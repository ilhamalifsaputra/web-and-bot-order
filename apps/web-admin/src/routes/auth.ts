/**
 * Login, logout, first-admin bootstrap, healthcheck — port of routers/auth.py.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config, isAdmin } from "@app/core/config";
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

async function anyAdminPasswordSet(): Promise<boolean> {
  for (const tgId of config.ADMIN_IDS) {
    if ((await getSetting(prisma, passwordHashKey(tgId))) !== null) return true;
  }
  return false;
}

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
  app.get("/bootstrap", async (_req, reply: FastifyReply) => {
    if (await anyAdminPasswordSet()) return reply.code(303).redirect("/login");
    return reply.view("bootstrap.njk", { error: null, admin_ids: config.ADMIN_IDS });
  });

  app.post("/bootstrap", async (req, reply) => {
    if (await anyAdminPasswordSet()) return reply.code(303).redirect("/login");
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
      return reply.code(400).view("bootstrap.njk", { error, admin_ids: config.ADMIN_IDS });
    }

    await setSetting(prisma, passwordHashKey(telegramId), hashPassword(password));
    logger.info(`Bootstrap: web admin password set for telegram_id=${telegramId}`);
    return reply.code(303).redirect("/login");
  });

  // ---- Login / logout ----
  app.get("/login", async (_req, reply) => {
    if (!(await anyAdminPasswordSet())) return reply.code(303).redirect("/bootstrap");
    return reply.view("login.njk", { error: null });
  });

  app.post("/login", async (req, reply) => {
    const ip = clientIp(req);
    if (loginRateLimited(ip)) {
      return reply.code(429).view("login.njk", { error: "Too many attempts. Try again later." });
    }

    const body = (req.body ?? {}) as Record<string, string>;
    const telegramId = Number(body.telegram_id);
    const password = body.password ?? "";
    const genericError = "Invalid credentials.";

    // Per-account lockout: stops IP-rotating brute force against one admin.
    if (accountLockedOut(telegramId)) {
      return reply.code(429).view("login.njk", { error: "Too many attempts. Try again later." });
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
          details: `telegram_id=${telegramId} ip=${ip} reason=${reason}`,
        });
      }
      return reply.code(401).view("login.njk", { error: genericError, ...extra });
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
    logger.info(`Login OK telegram_id=${telegramId} ip=${ip}`);
    return reply.code(303).redirect("/");
  });

  // ---- Forgot / reset password (code delivered to the admin's Telegram) ----
  // The web NEVER sends Telegram: /forgot stores a one-time code and enqueues an
  // ADMIN_PW_RESET outbox row; the notifier/bot DMs it. Delivery therefore needs
  // the notifier running on the main bot — if a code never arrives, fall back to
  // the break-glass CLI (`pnpm reset-admin-password <id>`).
  app.get("/forgot", async (_req, reply) => {
    return reply.view("forgot.njk", { error: null, sent: false });
  });

  app.post("/forgot", async (req, reply) => {
    const ip = clientIp(req);
    if (loginRateLimited(ip)) {
      return reply.code(429).view("forgot.njk", { error: "Too many attempts. Try again later.", sent: false });
    }
    const body = (req.body ?? {}) as Record<string, string>;
    const telegramId = Number(body.telegram_id);

    // Only mint+enqueue for a genuine target, but always render the SAME page so
    // the response can't be used to enumerate admin IDs.
    if (await resetEligible(telegramId)) {
      const { code, store } = newResetCode();
      await setSetting(prisma, pwResetKey(telegramId), store);
      await enqueueAdminPasswordReset(prisma, { telegramId, code, ttlMinutes: RESET_TTL_MINUTES });
      logger.info(`Password reset code enqueued telegram_id=${telegramId} ip=${ip}`); // never log the code
    }
    return reply.view("forgot.njk", {
      error: null,
      sent: true,
      telegram_id: Number.isInteger(telegramId) ? telegramId : "",
    });
  });

  app.get("/reset", async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    return reply.view("reset.njk", { error: null, telegram_id: q.telegram_id ?? "" });
  });

  app.post("/reset", async (req, reply) => {
    const ip = clientIp(req);
    const body = (req.body ?? {}) as Record<string, string>;
    const telegramId = Number(body.telegram_id);
    const code = (body.code ?? "").trim();
    const password = body.password ?? "";
    const passwordConfirm = body.password_confirm ?? "";
    const reRender = (error: string) =>
      reply.code(400).view("reset.njk", { error, telegram_id: body.telegram_id ?? "" });

    if (loginRateLimited(ip)) {
      return reply.code(429).view("reset.njk", { error: "Too many attempts. Try again later.", telegram_id: body.telegram_id ?? "" });
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
      details: `telegram_id=${telegramId}`,
    });
    logger.info(`Password reset completed telegram_id=${telegramId} ip=${ip}`);
    return reply.code(303).redirect("/login");
  });

  app.post("/logout", async (req, reply) => {
    const admin = await optionalAdmin(req);
    if (admin) {
      await setSetting(prisma, sessionJtiKey(admin.telegramId), newJti());
      logger.info(`Logout telegram_id=${admin.telegramId}`);
    }
    reply.clearCookie(config.WEB_COOKIE_NAME, { path: "/" });
    return reply.code(303).redirect("/login");
  });
}
