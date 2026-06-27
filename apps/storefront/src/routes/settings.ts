/**
 * Account settings — credentials (username / email / password) and Telegram
 * linking. Protected by `currentCustomer` on GET routes and `csrfProtect`
 * (which includes currentCustomer) on the POST route.
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "@app/core/config";
import { t } from "@app/core/i18n";
import { ValidationError } from "@app/core/errors";
import { hashPassword, verifyPassword } from "@app/core/password";
import {
  prisma,
  getUser,
  setLoginCredentials,
  linkTelegram,
  setSetting,
  LOGIN_USERNAME_RE,
} from "@app/db";
import {
  verifyTelegramLogin,
  newJti,
  shopSessionJtiKey,
  makeCustomerSession,
  SHOP_COOKIE_NAME,
  SHOP_SESSION_TTL_HOURS,
} from "../auth";
import { currentCustomer, csrfProtect } from "../plugins/auth";
import { shopContext, resolveBotUsername, resolveBotToken } from "../shop";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const settingsRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /account/settings ------------------------------------------------
  app.get<{ Querystring: { saved?: string; linked?: string; err?: string } }>(
    "/account/settings",
    { preHandler: currentCustomer },
    async (req, reply) => {
      const ctx = await shopContext(req, "/account");
      const customer = req.customer!;
      const errKey =
        req.query.err === "tg_taken"
          ? "web.settings_tg_taken"
          : req.query.err === "tg_invalid"
            ? "web.error_message"
            : null;
      return reply.view("settings.njk", {
        ...ctx,
        customer,
        bot_username: await resolveBotUsername(),
        values: {
          username: customer.user.loginUsername ?? "",
          email: customer.user.email ?? "",
        },
        has_password: Boolean(customer.user.passwordHash),
        tg_linked: customer.user.telegramId != null,
        tg_name:
          customer.user.username ??
          customer.user.fullName ??
          String(customer.user.telegramId ?? ""),
        saved: Boolean(req.query.saved),
        linked: Boolean(req.query.linked),
        error: errKey ? t(errKey, ctx.lang) : null,
      });
    },
  );

  // ---- POST /account/settings/credentials -----------------------------------
  app.post<{
    Body: {
      csrf_token?: string;
      username?: string;
      email?: string;
      current_password?: string;
      new_password?: string;
    };
  }>(
    "/account/settings/credentials",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const ctx = await shopContext(req, "/account");
      const customer = req.customer!;
      const username = (req.body.username ?? "").trim().toLowerCase();
      const email = (req.body.email ?? "").trim().toLowerCase();
      const newPassword = req.body.new_password ?? "";

      const back = async (error: string) => {
        const fresh = await getUser(prisma, customer.userId);
        return reply.code(400).view("settings.njk", {
          ...ctx,
          customer,
          bot_username: await resolveBotUsername(),
          values: { username, email },
          has_password: Boolean(fresh?.passwordHash),
          tg_linked: fresh?.telegramId != null,
          tg_name: fresh?.username ?? fresh?.fullName ?? "",
          saved: false,
          linked: false,
          error,
        });
      };

      if (username && !LOGIN_USERNAME_RE.test(username))
        return back(t("web.register_username_invalid", ctx.lang));
      if (email && !EMAIL_RE.test(email))
        return back(t("web.register_email_invalid", ctx.lang));
      if (newPassword && newPassword.length < 8) return back(t("web.register_password_short", ctx.lang));

      const changes: { loginUsername?: string; email?: string; passwordHash?: string } = {};
      if (username && username !== customer.user.loginUsername) changes.loginUsername = username;
      if (email && email !== customer.user.email) changes.email = email;

      // Re-auth via current_password for ANY credential change (username,
      // email, or password) — email/username are the account-recovery
      // anchor, so changing them with no re-auth would let an attacker with a
      // hijacked session redirect password-reset to themselves and lock the
      // real owner out permanently (Storefront-3 fix, security audit
      // 2026-06-23). Skipped only when the account has no password yet
      // (Telegram-login-only) — same condition the password-change check
      // already used, since there's nothing to verify against.
      const changingCredentials = Boolean(changes.loginUsername || changes.email || newPassword);
      if (changingCredentials && customer.user.passwordHash) {
        if (!verifyPassword(req.body.current_password ?? "", customer.user.passwordHash)) {
          return back(t("web.settings_wrong_password", ctx.lang));
        }
      }
      if (newPassword) changes.passwordHash = hashPassword(newPassword);

      try {
        await setLoginCredentials(prisma, customer.userId, changes);
      } catch (e) {
        if (e instanceof ValidationError) return back(t(e.message, ctx.lang));
        throw e;
      }

      // Rotate the session jti on password change — without this, a session
      // hijacked BEFORE the password change (shared device, leaked cookie)
      // stays valid indefinitely after, defeating the whole point of
      // changing the password (Storefront-2 fix, security audit 2026-06-23).
      // Refresh THIS request's own cookie to the new jti so the user who just
      // changed their own password isn't logged out by their own action —
      // every OTHER device's session is what actually gets invalidated.
      if (changes.passwordHash) {
        const jti = newJti();
        await setSetting(prisma, shopSessionJtiKey(customer.userId), jti);
        const { raw } = makeCustomerSession(customer.userId, customer.user.telegramId, jti);
        void reply.setCookie(SHOP_COOKIE_NAME, raw, {
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          secure: config.WEB_COOKIE_SECURE,
          maxAge: SHOP_SESSION_TTL_HOURS * 3600,
        });
      }
      return reply.code(303).redirect("/account/settings?saved=1");
    },
  );

  // ---- GET /account/settings/link-telegram ----------------------------------
  app.get<{ Querystring: Record<string, string> }>(
    "/account/settings/link-telegram",
    { preHandler: currentCustomer },
    async (req, reply) => {
      const customer = req.customer!;
      const auth = verifyTelegramLogin(req.query, await resolveBotToken());
      if (!auth) return reply.code(303).redirect("/account/settings?err=tg_invalid");
      const fullName =
        [auth.first_name, auth.last_name].filter(Boolean).join(" ") || null;
      const res = await linkTelegram(
        prisma,
        customer.userId,
        auth.id,
        auth.username ?? null,
        fullName,
      );
      if (!res.ok) return reply.code(303).redirect("/account/settings?err=tg_taken");
      return reply.code(303).redirect("/account/settings?linked=1");
    },
  );
};

export default settingsRoutes;
