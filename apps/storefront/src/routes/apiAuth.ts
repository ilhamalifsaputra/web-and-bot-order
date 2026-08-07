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
import type { FastifyPluginAsync } from "fastify";
import { logger } from "@app/core/logger";
import { sendMail } from "@app/core/mailer";
import { hashPassword, verifyPassword } from "@app/core/password";
import { ValidationError } from "@app/core/errors";
import { config } from "@app/core/config";
import { utcStamp } from "@app/core/datetime";
import { renderResetPasswordEmail } from "@app/core/email";
import type { BrandConfig, EmailCopy } from "@app/core/email";
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
import { publicBase, resolveBotUsername } from "../shop";
import { establishSession, safeNext } from "./auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    // (cost-12 bcrypt + a DB write) on a single-process server backed by
    // single-writer SQLite — a burst of concurrent POSTs can stall checkout
    // and the bot. Same per-IP throttle as /auth/login (M-17, backend audit
    // 2026-07-31).
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
      if (user && !user.banned) {
        const { token } = await createPasswordResetToken(prisma, user.id);
        const link = `${publicBase(req)}/reset/${token}`;
        const shopName = (await getSetting(prisma, "shop_name")) ?? "Toko Digital";
        // Same Settings-driven brand/copy resolution Task 3's emailTemplates.ts
        // uses for the owner-facing "New Paid Order" mail — `??` (not `||`) so
        // an explicitly-saved-but-empty Setting isn't silently overridden by
        // the default, only a genuinely unset (null) one.
        const [logoUrl, accentColor, supportEmail, copySubject, copyTitle, copySubtitle, copyMessage] =
          await Promise.all([
            getSetting(prisma, "web_logo_url"),
            getSetting(prisma, "email_brand_color"),
            getSetting(prisma, "email_support_address"),
            getSetting(prisma, "email_reset_password_subject"),
            getSetting(prisma, "email_reset_password_title"),
            getSetting(prisma, "email_reset_password_subtitle"),
            getSetting(prisma, "email_reset_password_message"),
          ]);
        const brand: BrandConfig = {
          shopName,
          logoUrl: logoUrl ?? null,
          accentColor: accentColor ?? "#4F46E5",
          supportEmail: supportEmail ?? null,
          storeUrl: config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null,
        };
        const copy: EmailCopy = {
          // A blank Subject header is a spam-filter red flag in a way a
          // blank title/subtitle/message is not (those are harmless empty
          // body text), so subject alone also falls back on a
          // whitespace-only stored value, not just on a genuinely unset
          // (null) Setting.
          subject: copySubject?.trim() || "{shop_name} — reset your password",
          title: copyTitle ?? "Reset your password",
          subtitle: copySubtitle ?? "We received a request to reset your password.",
          // No expiry clause here — packages/core/src/email/templates/
          // resetPassword.ts already renders its own dedicated expiry line
          // from `expiryMinutes`; restating it here (previously "...This
          // link expires in 1 hour.") duplicated it in a different, mismatched
          // unit (hours vs. the template's minutes).
          message: copyMessage ?? "Click the button below to choose a new password.",
        };
        // Fastify hands back a string, an array (repeated header), or
        // undefined for a missing header — normalize to string | null, taking
        // the first value of an array the same way the rest of this codebase
        // would treat a repeated header.
        const uaHeader = req.headers["user-agent"];
        const uaValue = Array.isArray(uaHeader) ? (uaHeader[0] ?? null) : (uaHeader ?? null);
        // /auth/forgot is unauthenticated (no CSRF, no login) and can be
        // triggered against any registered email by anyone who knows/guesses
        // it — the raw User-Agent header rides verbatim (HTML-escaped, but
        // otherwise unvalidated) into a real, correctly-branded email sent to
        // the victim's inbox as the "Device" line. A normal browser can't set
        // an arbitrary value here, but curl/any raw HTTP client can, so this
        // caps how much attacker-controlled text can ride in that one field —
        // no attempt at UA parsing/validation, just a length bound. Kept here
        // (app-specific truncation policy) rather than inside the shared
        // packages/core/src/email/ template layer.
        const userAgent = uaValue == null ? null : uaValue.slice(0, 180);
        const rendered = renderResetPasswordEmail(
          {
            resetUrl: link,
            expiryMinutes: RESET_TOKEN_TTL_MINUTES,
            requestedAt: utcStamp(new Date()),
            ip,
            userAgent,
          },
          brand,
          copy,
        );
        try {
          await sendMail(smtp, {
            to: email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
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
      // Same per-IP throttle as /auth/login and /auth/register — a burst of
      // submissions here still costs a bcrypt hash + DB write per attempt
      // (M-17, backend audit 2026-07-31).
      if (loginRateLimited(clientIp(req))) {
        return reply.code(429).send({ error: "error.rate_limited" });
      }
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
