import { recordEmailLoginFailure, clearEmailLoginFailures } from "@app/db";
/**
 * JSON twins of the (now-deleted) HTML auth routes — login / register /
 * logout / forgot / reset — for the React SPA. Same semantics the HTML forms
 * used to have (routes/auth.ts + the deleted routes/forgot.ts): no CSRF on
 * any of them (pre-session, exactly like those HTML forms; logout matches
 * the HTML POST /logout which carried no csrfProtect — login and register,
 * which mint a session, do refuse cross-site requests by their
 * Origin/Sec-Fetch-Site headers via sessionMintOriginOk), the same rate
 * limiters in the same order, the same generic non-enumerating errors.
 * Errors return i18n KEYS — the client renders them through its own t().
 *
 * The Telegram Login Widget callback stays a server-side GET (routes/auth.ts
 * /auth/telegram) — the widget redirects the whole page, not an XHR.
 */
import type { FastifyPluginAsync } from "fastify";
import { logger } from "@app/core/logger";
import { createHash } from "node:crypto";
import { hashPassword, verifyPassword } from "@app/core/password";
import { ValidationError } from "@app/core/errors";
import { utcStamp } from "@app/core/datetime";
import {
  prisma,
  enqueueEmailEvent,
  setSetting,
  invalidateSettingCache,
  findUserByLoginIdentifier,
  createWebUser,
  createPasswordResetToken,
  consumePasswordResetToken,
  isPasswordResetTokenValid,
  setLoginCredentials,
  LOGIN_USERNAME_RE,
  getSmtpCreds,
  RESET_TOKEN_TTL_MINUTES,
} from "@app/db";
import { newJti, shopSessionJtiKey, SHOP_COOKIE_NAME } from "../auth";
import { optionalCustomer } from "../plugins/auth";
import {
  clientIp,
  loginRateLimited,
  resetLoginAttempts,
  accountLockedOut,
  recordAccountFailure,
  resetAccountFailures,
  forgotEmailRateLimited,
} from "../rateLimit";
import { publicBase, resolveBotId, resolveBotUsername } from "../shop";
import { establishSession, safeNext } from "./auth";
import { armTelegramCallback } from "../telegramCallback";
import { sessionMintOriginOk } from "./cart";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const apiAuthRoutes: FastifyPluginAsync = async (app) => {
  // ---- Telegram direct-link OAuth parameters for the React login/settings pages ----
  app.get<{ Querystring: { next?: string; ref?: string } }>(
    "/auth/telegram-widget",
    async (req, reply) => {
      if (!sessionMintOriginOk(req)) return reply.code(403).send({error:"csrf_failed"});
      if (loginRateLimited(`telegram-start:${clientIp(req)}`)) return reply.code(429).send({error:"error.rate_limited"});
      const params = new URLSearchParams();
      params.set("state", await armTelegramCallback(reply, "login", safeNext(req.query.next)));
      params.set("next", safeNext(req.query.next));
      if (req.query.ref) params.set("ref", req.query.ref.slice(0, 16));
      return reply.send({
        bot_username: await resolveBotUsername(),
        bot_id: await resolveBotId(),
        auth_url: `/auth/telegram?${params.toString()}`,
      });
    },
  );

  // ---- Login (username/email + password) ----
  app.post<{ Body: { identifier?: string; password?: string; next?: string } }>(
    "/auth/login",
    async (req, reply) => {
      // Login CSRF guard (backend audit Task C1): no session yet means no
      // token to check, so a cross-site page is refused by its headers.
      if (!sessionMintOriginOk(req)) return reply.code(403).send({ error: "csrf_failed" });
      const ip = clientIp(req);
      const identifier = (req.body?.identifier ?? "").trim();
      const idKey = identifier.toLowerCase();

      // Per-IP throttle, same generic response either way the request is
      // capped (don't reveal which limiter tripped).
      if (loginRateLimited(ip)) {
        return reply.code(429).send({ error: "error.rate_limited" });
      }
      // Per-account lockout: stops an attacker rotating IPs against ONE
      // account. Returns the SAME 429 as the IP throttle above — never
      // reveal whether the account exists.
      if (idKey && accountLockedOut(idKey)) {
        return reply.code(429).send({ error: "error.rate_limited" });
      }

      const password = req.body?.password ?? "";
      const user = identifier ? await findUserByLoginIdentifier(prisma, identifier) : null;
      // Generic failure for every miss — no enumeration. Banned accounts also
      // get the generic error (don't reveal credential correctness).
      if (!user || user.banned || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
        if (user?.passwordHash && !user.banned) await recordEmailLoginFailure(prisma, user.id);
        if (idKey) recordAccountFailure(idKey);
        return reply.code(403).send({ error: "web.login_failed" });
      }
      await establishSession(req, reply, user);
      await clearEmailLoginFailures(prisma, user.id);
      resetLoginAttempts(ip);
      if (idKey) resetAccountFailures(idKey);
      return reply.send({ redirect: safeNext(req.body?.next) });
    },
  );

  // ---- Register ----
  app.post<{
    Body: {
      username?: string;
      email?: string;
      password?: string;
      password2?: string;
      fullName?: string;
      ref?: string;
      next?: string;
    };
  }>("/auth/register", async (req, reply) => {
    // Registration is the most expensive unauthenticated endpoint in the app
    // (cost-12 bcrypt + a DB write) on a single-process server — a
    // burst of concurrent POSTs can stall checkout
    // and the bot. Same per-IP throttle as /auth/login (M-17, backend audit
    // 2026-07-31).
    if (!sessionMintOriginOk(req)) return reply.code(403).send({ error: "csrf_failed" });
    if (loginRateLimited(clientIp(req))) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const username = (req.body?.username ?? "").trim().toLowerCase();
    const email = (req.body?.email ?? "").trim().toLowerCase();
    const password = req.body?.password ?? "";
    const fullName = (req.body?.fullName ?? "").trim();

    if (!LOGIN_USERNAME_RE.test(username)) return reply.code(400).send({ error: "web.register_username_invalid" });
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: "web.register_email_invalid" });
    if (password.length < 8) return reply.code(400).send({ error: "web.register_password_short" });
    if (password !== (req.body?.password2 ?? "")) return reply.code(400).send({ error: "web.register_password_mismatch" });
    if (fullName.length < 2) return reply.code(400).send({ error: "web.register_fullname_invalid" });

    try {
      const user = await createWebUser(prisma, {
        loginUsername: username,
        email,
        passwordHash: hashPassword(password),
        fullName,
        referredByCode: req.body?.ref ? req.body.ref.toUpperCase() : null,
      });
      await establishSession(req, reply, user);
      return reply.send({ redirect: safeNext(req.body?.next) });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  // ---- Logout (rotate jti + clear cookie — parity with HTML POST /logout) ----
  app.post("/auth/logout", async (req, reply) => {
    const customer = await optionalCustomer(req);
    if (customer) {
      await setSetting(prisma, shopSessionJtiKey(customer.userId), newJti());
    }
    void reply.clearCookie(SHOP_COOKIE_NAME, { path: "/" });
    return reply.send({ redirect: "/" });
  });

  // ---- Forgot password (SMTP-gated, non-enumerating) ----
  app.post<{ Body: { email?: string } }>("/auth/forgot", async (req, reply) => {
    const ip = clientIp(req);
    const email = (req.body?.email ?? "").trim().toLowerCase();
    // Per-IP throttle stops one source hammering ANY address; per-email
    // throttle stops an attacker rotating IPs to email-bomb ONE victim with
    // reset-token mail — same pair as the HTML route.
    if (loginRateLimited(ip) || forgotEmailRateLimited(email)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }
    const smtp = await getSmtpCreds(prisma);
    if (!smtp) {
      return reply.send({ sent: false, unavailable: true });
    }
    if (email) {
      const user = await findUserByLoginIdentifier(prisma, email);
      // Telegram-only identities cannot request password recovery.
      if (user && !user.banned && user.passwordHash && user.email) {
        const uaHeader = req.headers["user-agent"];
        const userAgent = (Array.isArray(uaHeader) ? uaHeader[0] : uaHeader)?.slice(0, 180) ?? null;
        try {
          // A recoverable token and its durable delivery obligation commit together.
          await prisma.$transaction(async (db) => {
            const { token } = await createPasswordResetToken(db, user.id);
            await enqueueEmailEvent(db, {
              key: "account.password_reset.requested",
              aggregateId: user.id,
              occurrence: createHash("sha256").update(token).digest("hex"),
              to: user.email!,
              payload: {
                reset_url: `${publicBase(req)}/reset/${token}`,
                expiry_minutes: RESET_TOKEN_TTL_MINUTES,
                requested_at: utcStamp(new Date()),
                ip,
                user_agent: userAgent,
              },
            });
          });
        } catch {
          // Provider/database details may contain recovery credentials.
          logger.error("The password recovery request could not be queued; no recovery token was committed.");
        }
      }
    }
    return reply.send({ sent: true, unavailable: false });
  });

  // ---- Reset link check (does the link even work, before the form is filled in) ----
  // Read-only twin of the POST below: same token criteria
  // (isPasswordResetTokenValid mirrors consumePasswordResetToken's
  // unknown/expired/used checks exactly, so the two can't disagree), but
  // never consumes the token. The response is a bare boolean — nothing about
  // which user the token belongs to — so this stays as enumeration-safe as
  // /auth/forgot: it answers "is this link usable", never "does this account
  // exist".
  app.get<{ Params: { token: string } }>("/auth/reset/:token/check", async (req, reply) => {
    void reply.header("Referrer-Policy", "no-referrer");
    if (loginRateLimited(clientIp(req))) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }
    const valid = await isPasswordResetTokenValid(prisma, req.params.token);
    return reply.send({ valid });
  });

  // ---- Reset password (the token IS the auth) ----
  app.post<{ Params: { token: string }; Body: { password?: string; password2?: string } }>(
    "/auth/reset/:token",
    async (req, reply) => {
      // The single-use reset token rides in this URL — stop browsers from
      // leaking it via the Referer header (same guard as the HTML route).
      void reply.header("Referrer-Policy", "no-referrer");
      // Same per-IP throttle as /auth/login and /auth/register — a burst of
      // submissions here still costs a bcrypt hash + DB write per attempt
      // (M-17, backend audit 2026-07-31).
      if (loginRateLimited(clientIp(req))) {
        return reply.code(429).send({ error: "error.rate_limited" });
      }
      const password = req.body?.password ?? "";
      if (password.length < 8) return reply.code(400).send({ error: "web.register_password_short" });
      if (password !== (req.body?.password2 ?? "")) return reply.code(400).send({ error: "web.register_password_mismatch" });

      const passwordHash = hashPassword(password);
      let reset: number | null;
      try {
        reset = await prisma.$transaction(async (db) => {
          const user = await consumePasswordResetToken(db, req.params.token);
          if (!user || user.banned || !user.passwordHash) return null;
          await setLoginCredentials(db, user.id, { passwordHash });
          await setSetting(db, shopSessionJtiKey(user.id), newJti());
          return user.id;
        });
      } catch {
        // Prisma errors can contain password hashes or recovery-token query values.
        logger.error("The password recovery change could not be confirmed. Retry or request a new recovery link.");
        return reply.code(500).send({ error: "error.generic" });
      }
      if (!reset) return reply.code(400).send({ error: "web.reset_invalid" });
      invalidateSettingCache(prisma, [shopSessionJtiKey(reset)]);
      return reply.send({ redirect: "/login?reset=1" });
    },
  );
};

export default apiAuthRoutes;
