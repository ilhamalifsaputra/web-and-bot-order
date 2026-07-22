/**
 * JSON twins of the (now-deleted) HTML auth routes — login / register /
 * logout / forgot / reset — for the React SPA. Same semantics the HTML forms
 * used to have (routes/auth.ts + the deleted routes/forgot.ts): no CSRF on
 * any of them (pre-session, exactly like those HTML forms; logout matches
 * the HTML POST /logout which carried no csrfProtect), the same rate
 * limiters in the same order, the same generic non-enumerating errors.
 * Errors return i18n KEYS — the client renders them through its own t().
 *
 * The Telegram Login Widget callback stays a server-side GET (routes/auth.ts
 * /auth/telegram) — the widget redirects the whole page, not an XHR.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import { sendMail } from "@app/core/mailer";
import { hashPassword, verifyPassword } from "@app/core/password";
import { ValidationError } from "@app/core/errors";
import {
  prisma,
  getSetting,
  setSetting,
  findUserByLoginIdentifier,
  createWebUser,
  createPasswordResetToken,
  consumePasswordResetToken,
  setLoginCredentials,
  LOGIN_USERNAME_RE,
  getSmtpCreds,
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
import { resolveBotUsername } from "../shop";
import { establishSession, safeNext } from "./auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicBase(req: FastifyRequest): string {
  const fromConfig = config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL;
  if (fromConfig) return fromConfig.replace(/\/+$/, "");
  return `${req.protocol}://${req.headers.host ?? "localhost"}`;
}

const apiAuthRoutes: FastifyPluginAsync = async (app) => {
  // ---- Telegram Login Widget parameters for the React login/settings pages ----
  app.get<{ Querystring: { next?: string; ref?: string } }>(
    "/auth/telegram-widget",
    async (req, reply) => {
      const params = new URLSearchParams();
      params.set("next", safeNext(req.query.next));
      if (req.query.ref) params.set("ref", req.query.ref.slice(0, 16));
      return reply.send({
        bot_username: await resolveBotUsername(),
        auth_url: `/auth/telegram?${params.toString()}`,
      });
    },
  );

  // ---- Login (username/email + password) ----
  app.post<{ Body: { identifier?: string; password?: string; next?: string } }>(
    "/auth/login",
    async (req, reply) => {
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
        if (idKey) recordAccountFailure(idKey);
        return reply.code(403).send({ error: "web.login_failed" });
      }
      await establishSession(req, reply, user);
      resetLoginAttempts(ip);
      if (idKey) resetAccountFailures(idKey);
      return reply.send({ redirect: safeNext(req.body?.next) });
    },
  );

  // ---- Register ----
  app.post<{
    Body: { username?: string; email?: string; password?: string; password2?: string; ref?: string; next?: string };
  }>("/auth/register", async (req, reply) => {
    const username = (req.body?.username ?? "").trim().toLowerCase();
    const email = (req.body?.email ?? "").trim().toLowerCase();
    const password = req.body?.password ?? "";

    if (!LOGIN_USERNAME_RE.test(username)) return reply.code(400).send({ error: "web.register_username_invalid" });
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: "web.register_email_invalid" });
    if (password.length < 8) return reply.code(400).send({ error: "web.register_password_short" });
    if (password !== (req.body?.password2 ?? "")) return reply.code(400).send({ error: "web.register_password_mismatch" });

    try {
      const user = await createWebUser(prisma, {
        loginUsername: username,
        email,
        passwordHash: hashPassword(password),
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
      if (user && !user.banned) {
        const { token } = await createPasswordResetToken(prisma, user.id);
        const link = `${publicBase(req)}/reset/${token}`;
        const shopName = (await getSetting(prisma, "shop_name")) ?? "Toko Digital";
        try {
          await sendMail(smtp, {
            to: email,
            subject: `${shopName} — reset password`,
            text:
              `Click to set a new password (valid 1 hour):\n${link}\n\n` +
              `If you didn't request this, ignore this email — your password is unchanged.\n\n` +
              `Klik untuk membuat kata sandi baru (berlaku 1 jam):\n${link}\n\n` +
              `Abaikan email ini jika kamu tidak memintanya — kata sandimu tidak berubah.`,
          });
        } catch (e) {
          logger.error({ err: e }, "Failed to send the password reset email — the user still sees the generic check-your-inbox confirmation, so they have no signal to retry");
        }
      }
    }
    return reply.send({ sent: true, unavailable: false });
  });

  // ---- Reset password (the token IS the auth) ----
  app.post<{ Params: { token: string }; Body: { password?: string; password2?: string } }>(
    "/auth/reset/:token",
    async (req, reply) => {
      // The single-use reset token rides in this URL — stop browsers from
      // leaking it via the Referer header (same guard as the HTML route).
      void reply.header("Referrer-Policy", "no-referrer");
      const password = req.body?.password ?? "";
      if (password.length < 8) return reply.code(400).send({ error: "web.register_password_short" });
      if (password !== (req.body?.password2 ?? "")) return reply.code(400).send({ error: "web.register_password_mismatch" });

      const user = await consumePasswordResetToken(prisma, req.params.token);
      if (!user) return reply.code(400).send({ error: "web.reset_invalid" });

      await setLoginCredentials(prisma, user.id, { passwordHash: hashPassword(password) });
      await setSetting(prisma, shopSessionJtiKey(user.id), newJti());
      return reply.send({ redirect: "/login?reset=1" });
    },
  );
};

export default apiAuthRoutes;
