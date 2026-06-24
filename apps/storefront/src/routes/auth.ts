/**
 * Customer login/logout/registration-adjacent auth routes.
 *
 * /login now has TWO doors (spec 2026-06-12):
 *   1. username/email + password form (primary)
 *   2. the Telegram Login Widget — LOOKUP-ONLY: it signs in existing accounts
 *      (every bot member qualifies) but no longer auto-creates users; unknown
 *      Telegram IDs are pointed to /register or the bot.
 * Sessions are keyed per userId (web-only accounts have no telegramId).
 * Guest-cart merge on every successful sign-in (plan.md §5 decision D).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import { t } from "@app/core/i18n";
import { verifyPassword, hashPassword } from "@app/core/password";
import { ValidationError } from "@app/core/errors";
import {
  prisma,
  setSetting,
  addToCart,
  getDenomination,
  getUserByTelegramId,
  findUserByLoginIdentifier,
  LOGIN_USERNAME_RE,
  createWebUser,
} from "@app/db";
import {
  makeCustomerSession,
  newJti,
  shopSessionJtiKey,
  verifyTelegramLoginResult,
  SHOP_COOKIE_NAME,
  SHOP_SESSION_TTL_HOURS,
} from "../auth";
import {
  clientIp,
  loginRateLimited,
  resetLoginAttempts,
  accountLockedOut,
  recordAccountFailure,
  resetAccountFailures,
} from "../rateLimit";
import { shopContext, readGuestCart, writeGuestCart, resolveBotUsername, resolveBotToken } from "../shop";

/** Only ever redirect to a local path (open-redirect guard). */
export const safeNext = (raw: unknown): string => {
  const s = typeof raw === "string" ? raw : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
};

type SessionUser = { id: number; telegramId: bigint | null };

/** Shared sign-in tail: merge guest cart, rotate jti, set the cookie. */
export async function establishSession(
  req: FastifyRequest,
  reply: FastifyReply,
  user: SessionUser,
): Promise<void> {
  const guestCart = readGuestCart(req);
  for (const line of guestCart) {
    const denom = await getDenomination(prisma, line.p);
    if (denom?.isActive) await addToCart(prisma, user.id, line.p, line.q);
  }
  if (guestCart.length) writeGuestCart(reply, []);

  const jti = newJti();
  await setSetting(prisma, shopSessionJtiKey(user.id), jti);
  const { raw } = makeCustomerSession(user.id, user.telegramId, jti);
  void reply.setCookie(SHOP_COOKIE_NAME, raw, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.WEB_COOKIE_SECURE,
    maxAge: SHOP_SESSION_TTL_HOURS * 3600,
  });
}

async function renderLogin(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { next?: string; ref?: string; error?: string; notice?: string; identifier?: string; code?: number } = {},
) {
  const ctx = await shopContext(req, "/login");
  const params = new URLSearchParams();
  params.set("next", safeNext(opts.next));
  if (opts.ref) params.set("ref", opts.ref.slice(0, 16));
  return reply.code(opts.code ?? 200).view("login.njk", {
    ...ctx,
    bot_username: await resolveBotUsername(),
    auth_url: `/auth/telegram?${params.toString()}`,
    next: safeNext(opts.next),
    error: opts.error ?? null,
    notice: opts.notice ?? null,
    identifier: opts.identifier ?? "",
  });
}

const authRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { next?: string; ref?: string; reset?: string } }>(
    "/login",
    async (req, reply) => {
      const ctx = await shopContext(req, "/login");
      return renderLogin(req, reply, {
        next: req.query.next,
        ref: req.query.ref,
        notice: req.query.reset ? t("web.login_reset_done", ctx.lang) : undefined,
      });
    },
  );

  app.post<{ Body: { identifier?: string; password?: string; next?: string } }>(
    "/login",
    async (req, reply) => {
      const ctx = await shopContext(req, "/login");
      const ip = clientIp(req);
      const identifier = (req.body.identifier ?? "").trim();
      const idKey = identifier.toLowerCase();

      // Per-IP throttle, same generic response either way the request is
      // capped (don't reveal which limiter tripped).
      if (loginRateLimited(ip)) {
        return renderLogin(req, reply, {
          next: req.body.next,
          error: t("error.rate_limited", ctx.lang),
          identifier,
          code: 429,
        });
      }
      // Per-account lockout: stops an attacker rotating IPs against ONE
      // account. Returns the SAME 429 rate-limited response as the IP
      // throttle above — never reveal whether the account exists.
      if (idKey && accountLockedOut(idKey)) {
        return renderLogin(req, reply, {
          next: req.body.next,
          error: t("error.rate_limited", ctx.lang),
          identifier,
          code: 429,
        });
      }

      const password = req.body.password ?? "";
      const user = identifier ? await findUserByLoginIdentifier(prisma, identifier) : null;
      // Generic failure for every miss — no enumeration. Banned accounts also
      // get the generic error (don't reveal credential correctness).
      if (!user || user.banned || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
        if (idKey) recordAccountFailure(idKey);
        return renderLogin(req, reply, {
          next: req.body.next,
          error: t("web.login_failed", ctx.lang),
          identifier,
          code: 403,
        });
      }
      await establishSession(req, reply, user);
      resetLoginAttempts(ip);
      if (idKey) resetAccountFailures(idKey);
      return reply.code(303).redirect(safeNext(req.body.next));
    },
  );

  app.get<{ Querystring: Record<string, string> }>("/auth/telegram", async (req, reply) => {
    const { next, ref, ...tgParams } = req.query;
    const ctx = await shopContext(req, "/login");
    // Verify with the LIVE bot token (DB setting wins) so it matches the live
    // bot username the widget signed with — a mismatched bot = "bad_hash".
    const result = verifyTelegramLoginResult(tgParams, await resolveBotToken());
    if (!result.ok) {
      logger.warn(
        `Rejected a Telegram login widget callback — reason: ${result.reason} ` +
          `("bad_hash" means the configured bot token doesn't match the bot username the widget signed with; ` +
          `"stale" means server clock skew or a replayed login link).`,
      );
      return renderLogin(req, reply, { next, ref, error: t("web.error_message", ctx.lang), code: 403 });
    }
    const auth = result.data;
    const user = await getUserByTelegramId(prisma, auth.id);
    if (!user) {
      return renderLogin(req, reply, { next, ref, error: t("web.login_tg_unlinked", ctx.lang), code: 403 });
    }
    if (user.banned) {
      return renderLogin(req, reply, { next, ref, error: t("web.error_message", ctx.lang), code: 403 });
    }
    await establishSession(req, reply, user);
    return reply.code(303).redirect(safeNext(next));
  });

  app.post("/logout", async (req, reply) => {
    const { optionalCustomer } = await import("../plugins/auth");
    const customer = await optionalCustomer(req);
    if (customer) {
      await setSetting(prisma, shopSessionJtiKey(customer.userId), newJti());
    }
    void reply.clearCookie(SHOP_COOKIE_NAME, { path: "/" });
    return reply.code(303).redirect("/");
  });

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  interface RegisterBody {
    username?: string;
    email?: string;
    password?: string;
    password2?: string;
    ref?: string;
    next?: string;
  }

  async function renderRegister(
    req: FastifyRequest,
    reply: FastifyReply,
    opts: { next?: string; ref?: string; error?: string; values?: Record<string, string>; code?: number } = {},
  ) {
    const ctx = await shopContext(req, "/login");
    return reply.code(opts.code ?? 200).view("register.njk", {
      ...ctx,
      next: safeNext(opts.next),
      ref: (opts.ref ?? "").slice(0, 16),
      error: opts.error ?? null,
      values: opts.values ?? {},
    });
  }

  app.get<{ Querystring: { next?: string; ref?: string } }>("/register", async (req, reply) =>
    renderRegister(req, reply, { next: req.query.next, ref: req.query.ref }),
  );

  app.post<{ Body: RegisterBody }>("/register", async (req, reply) => {
    const ctx = await shopContext(req, "/login");
    const username = (req.body.username ?? "").trim().toLowerCase();
    const email = (req.body.email ?? "").trim().toLowerCase();
    const password = req.body.password ?? "";
    const back = (error: string) =>
      renderRegister(req, reply, {
        next: req.body.next,
        ref: req.body.ref,
        error,
        values: { username, email },
        code: 400,
      });

    if (!LOGIN_USERNAME_RE.test(username)) return back(t("web.register_username_invalid", ctx.lang));
    if (!EMAIL_RE.test(email)) return back(t("web.register_email_invalid", ctx.lang));
    if (password.length < 8) return back(t("web.register_password_short", ctx.lang));
    if (password !== (req.body.password2 ?? "")) return back(t("web.register_password_mismatch", ctx.lang));

    try {
      const user = await createWebUser(prisma, {
        loginUsername: username,
        email,
        passwordHash: hashPassword(password),
        referredByCode: req.body.ref ? req.body.ref.toUpperCase() : null,
      });
      await establishSession(req, reply, user);
      return reply.code(303).redirect(safeNext(req.body.next));
    } catch (e) {
      if (e instanceof ValidationError) return back(t(e.message, ctx.lang));
      throw e;
    }
  });
};

export default authRoutes;
