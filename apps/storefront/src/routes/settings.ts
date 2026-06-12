/**
 * Account settings — credentials (username / email / password) and Telegram
 * linking. Protected by `currentCustomer` on GET routes and `csrfProtect`
 * (which includes currentCustomer) on the POST route.
 */
import type { FastifyPluginAsync } from "fastify";
import { botUsername } from "@app/core/runtime";
import { t } from "@app/core/i18n";
import { ValidationError } from "@app/core/errors";
import { hashPassword, verifyPassword } from "@app/core/password";
import {
  prisma,
  getUser,
  setLoginCredentials,
  linkTelegram,
  LOGIN_USERNAME_RE,
} from "@app/db";
import { verifyTelegramLogin } from "../auth";
import { currentCustomer, csrfProtect } from "../plugins/auth";
import { shopContext } from "../shop";

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
        bot_username: botUsername() ?? "",
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
          bot_username: botUsername() ?? "",
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

      const changes: { loginUsername?: string; email?: string; passwordHash?: string } = {};
      if (username && username !== customer.user.loginUsername) changes.loginUsername = username;
      if (email && email !== customer.user.email) changes.email = email;
      if (newPassword) {
        if (newPassword.length < 8) return back(t("web.register_password_short", ctx.lang));
        if (
          customer.user.passwordHash &&
          !verifyPassword(req.body.current_password ?? "", customer.user.passwordHash)
        ) {
          return back(t("web.settings_wrong_password", ctx.lang));
        }
        changes.passwordHash = hashPassword(newPassword);
      }

      try {
        await setLoginCredentials(prisma, customer.userId, changes);
      } catch (e) {
        if (e instanceof ValidationError) return back(t(e.message, ctx.lang));
        throw e;
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
      const auth = verifyTelegramLogin(req.query);
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
