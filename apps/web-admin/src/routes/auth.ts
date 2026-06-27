/**
 * Login, logout, first-admin bootstrap, healthcheck — port of routers/auth.py.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
import { logger } from "@app/core/logger";
import { UserRole } from "@app/core/enums";
import {
  prisma,
  getSetting,
  setSetting,
  deleteSetting,
  getUserByTelegramId,
  enqueueAdminPasswordReset,
  logAdminAction,
  anyAdminPasswordSet,
} from "@app/db";
import {
  hashPassword,
  verifyPassword,
  makeSession,
  newJti,
  passwordHashKey,
  sessionJtiKey,
  twoFaSecretKey,
  verifyTotp,
  loginRateLimited,
  resetLoginAttempts,
  accountLockedOut,
  recordAccountFailure,
  resetAccountFailures,
  newResetCode,
  consumeResetCode,
  pwResetKey,
  PW_RESET_TTL_MS,
} from "../auth";
import { optionalAdmin } from "../plugins/auth";

/**
 * True if `telegramId` is a real, active web admin that already has a password
 * set — i.e. a valid target for a reset code. Checked silently (the /forgot
 * response never reveals whether an ID qualifies) so an attacker can't probe
 * which Telegram IDs are admins.
 */
async function resetEligible(telegramId: number): Promise<boolean> {
  if (!Number.isInteger(telegramId) || !isAdmin(telegramId)) return false;
  const user = await getUserByTelegramId(prisma, telegramId);
  if (!user || user.role !== UserRole.ADMIN || user.banned) return false;
  return (await getSetting(prisma, passwordHashKey(telegramId))) !== null;
}

const RESET_TTL_MINUTES = Math.round(PW_RESET_TTL_MS / 60000);

function clientIp(req: FastifyRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0]!.trim();
  return req.ip || "unknown";
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => {
    await getSetting(prisma, "__healthz_probe__");
    return { status: "ok" };
  });

  // ---- Bootstrap ----
  // GET /bootstrap: retired — unauthShell serves this as SPA

  app.post("/bootstrap", async (req, reply) => {
    const isJson = (req.headers["content-type"] ?? "").includes("application/json");
    if (await anyAdminPasswordSet(prisma)) {
      if (isJson) return reply.code(403).send({ error: "Setup already complete.", redirect: "/login" });
      return reply.code(303).redirect("/login");
    }
    const body = (req.body ?? {}) as Record<string, string>;
    const telegramId = Number(body.telegram_id);
    const password = body.password ?? "";
    const passwordConfirm = body.password_confirm ?? "";

    let error: string | null = null;
    if (!Number.isInteger(telegramId) || !config.ADMIN_IDS.includes(telegramId)) {
      error = "That Telegram ID is not in the bot's ADMIN_IDS allow-list.";
    } else if (password.length < 8) {
      error = "Password must be at least 8 characters.";
    } else if (password !== passwordConfirm) {
      error = "Passwords do not match.";
    }
    if (error) {
      return reply.code(400).send({ error });
    }

    await setSetting(prisma, passwordHashKey(telegramId), hashPassword(password));
    logger.info(`Bootstrap: set initial web admin password for Telegram id ${telegramId}`);
    if (isJson) return reply.send({ ok: true, redirect: "/login" });
    return reply.code(303).redirect("/login");
  });

  // ---- Login / logout ----
  // GET /login: retired — unauthShell serves this as SPA

  app.post("/login", async (req, reply) => {
    const isJson = (req.headers["content-type"] ?? "").includes("application/json");
    const ip = clientIp(req);
    if (loginRateLimited(ip)) {
      return reply.code(429).send({ error: "Too many attempts. Try again later." });
    }

    const body = (req.body ?? {}) as Record<string, string>;
    const telegramId = Number(body.telegram_id);
    const password = body.password ?? "";
    const genericError = "Invalid credentials.";

    // Per-account lockout: stops IP-rotating brute force against one admin.
    if (accountLockedOut(telegramId)) {
      return reply.code(429).send({ error: "Too many attempts. Try again later." });
    }

    // Record a failed attempt (account counter + DB audit, never the password)
    // and return the generic 401. Audit only real admin IDs so attacker noise
    // against random numbers doesn't flood the log.
    const fail = async (reason: string, extra: Record<string, unknown> = {}) => {
      recordAccountFailure(telegramId);
      if (isAdmin(telegramId)) {
        await logAdminAction(prisma, {
          adminId: null,
          action: "web_login_failed",
          targetType: "web_admin",
          targetId: null,
          details: `Failed login attempt for Telegram ID ${telegramId} from IP ${ip} (${reason}).`,
        });
      }
      return reply.code(401).send({ error: (extra.error as string) ?? genericError });
    };

    if (!Number.isInteger(telegramId) || !isAdmin(telegramId)) {
      return fail("not_admin");
    }

    const storedHash = await getSetting(prisma, passwordHashKey(telegramId));
    const user = await getUserByTelegramId(prisma, telegramId);
    if (!storedHash || !user) {
      return fail("no_account");
    }
    if (user.role !== UserRole.ADMIN || user.banned) {
      return fail("role_or_banned");
    }
    if (!verifyPassword(password, storedHash)) {
      return fail("bad_password");
    }

    // Second factor: if this admin has TOTP enabled, require a valid code.
    const twoFaSecret = await getSetting(prisma, twoFaSecretKey(telegramId));
    if (twoFaSecret && !verifyTotp(twoFaSecret, body.totp_code ?? "")) {
      return fail("bad_2fa", { error: "Invalid credentials or 2FA code.", two_fa: true });
    }

    const jti = newJti();
    await setSetting(prisma, sessionJtiKey(telegramId), jti);
    resetLoginAttempts(ip);
    resetAccountFailures(telegramId);

    const { raw } = makeSession(user.id, telegramId, jti);
    reply.setCookie(config.WEB_COOKIE_NAME, raw, {
      path: "/",
      maxAge: config.WEB_SESSION_TTL_HOURS * 3600,
      httpOnly: true,
      sameSite: "lax",
      secure: config.WEB_COOKIE_SECURE, // true in production behind TLS
    });
    logger.info(`Admin with Telegram id ${telegramId} logged in from IP ${ip}`);
    if (isJson) return reply.send({ ok: true, redirect: "/" });
    return reply.code(303).redirect("/");
  });

  // ---- Forgot / reset password (code delivered to the admin's Telegram) ----
  // The web NEVER sends Telegram: /forgot stores a one-time code and enqueues an
  // ADMIN_PW_RESET outbox row; the notifier/bot DMs it. Delivery therefore needs
  // the notifier running on the main bot — if a code never arrives, fall back to
  // the break-glass CLI (`pnpm reset-admin-password <id>`).
  // GET /forgot: retired — unauthShell serves this as SPA

  app.post("/forgot", async (req, reply) => {
    const isJson = (req.headers["content-type"] ?? "").includes("application/json");
    const ip = clientIp(req);
    if (loginRateLimited(ip)) {
      return reply.code(429).send({ error: "Too many attempts. Try again later." });
    }
    const body = (req.body ?? {}) as Record<string, string>;
    const telegramId = Number(body.telegram_id);

    // Only mint+enqueue for a genuine target, but always render the SAME page so
    // the response can't be used to enumerate admin IDs.
    if (await resetEligible(telegramId)) {
      const { code, store } = newResetCode();
      await setSetting(prisma, pwResetKey(telegramId), store);
      await enqueueAdminPasswordReset(prisma, { telegramId, code, ttlMinutes: RESET_TTL_MINUTES });
      logger.info(`Enqueued a password reset code for Telegram id ${telegramId}, requested from IP ${ip}`); // never log the code
    }
    return reply.send({ ok: true, sent: true });
  });

  // GET /reset: retired — unauthShell serves this as SPA

  app.post("/reset", async (req, reply) => {
    const isJson = (req.headers["content-type"] ?? "").includes("application/json");
    const ip = clientIp(req);
    const body = (req.body ?? {}) as Record<string, string>;
    const telegramId = Number(body.telegram_id);
    const code = (body.code ?? "").trim();
    const password = body.password ?? "";
    const passwordConfirm = body.password_confirm ?? "";
    const reRender = (error: string) => reply.code(400).send({ error });

    if (loginRateLimited(ip)) {
      return reply.code(429).send({ error: "Too many attempts. Try again later." });
    }
    if (password.length < 8) return reRender("Password must be at least 8 characters.");
    if (password !== passwordConfirm) return reRender("Passwords do not match.");

    // Generic outcome on any code problem — never distinguish wrong vs. expired
    // vs. unknown-id (anti-enumeration). Persist the burned-attempt record.
    const stored = await getSetting(prisma, pwResetKey(telegramId));
    const out = consumeResetCode(stored, code);
    if (!out.ok) {
      if (out.store === null) await deleteSetting(prisma, pwResetKey(telegramId));
      else await setSetting(prisma, pwResetKey(telegramId), out.store);
      return reRender("Invalid or expired code.");
    }
    // Re-check eligibility in case ADMIN_IDS changed since the code was issued.
    if (!(await resetEligible(telegramId))) {
      await deleteSetting(prisma, pwResetKey(telegramId));
      return reRender("Invalid or expired code.");
    }

    await setSetting(prisma, passwordHashKey(telegramId), hashPassword(password));
    await deleteSetting(prisma, pwResetKey(telegramId));
    await setSetting(prisma, sessionJtiKey(telegramId), newJti()); // kill live sessions
    resetLoginAttempts(ip);
    await logAdminAction(prisma, {
      adminId: null, // self-service via reset code — no logged-in actor
      action: "web_password_reset",
      targetType: "web_admin",
      targetId: null,
      details: `Password reset completed for Telegram ID ${telegramId}.`,
    });
    logger.info(`Password reset completed for Telegram id ${telegramId} from IP ${ip}`);
    if (isJson) return reply.send({ ok: true, redirect: "/login" });
    return reply.code(303).redirect("/login");
  });

  app.post("/logout", async (req, reply) => {
    const admin = await optionalAdmin(req);
    if (admin) {
      await setSetting(prisma, sessionJtiKey(admin.telegramId), newJti());
      logger.info(`Admin with Telegram id ${admin.telegramId} logged out`);
    }
    reply.clearCookie(config.WEB_COOKIE_NAME, { path: "/" });
    return reply.code(303).redirect("/login");
  });
}
