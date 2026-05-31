/**
 * Login, logout, first-admin bootstrap, healthcheck — port of routers/auth.py.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config, isAdmin } from "@app/core/config";
import { logger } from "@app/core/logger";
import { UserRole } from "@app/core/enums";
import { prisma, getSetting, setSetting, getUserByTelegramId } from "@app/db";
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
} from "../auth";
import { optionalAdmin } from "../plugins/auth";

async function anyAdminPasswordSet(): Promise<boolean> {
  for (const tgId of config.ADMIN_IDS) {
    if ((await getSetting(prisma, passwordHashKey(tgId))) !== null) return true;
  }
  return false;
}

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

    if (!Number.isInteger(telegramId) || !isAdmin(telegramId)) {
      return reply.code(401).view("login.njk", { error: genericError });
    }

    const storedHash = await getSetting(prisma, passwordHashKey(telegramId));
    const user = await getUserByTelegramId(prisma, telegramId);
    if (!storedHash || !user) {
      return reply.code(401).view("login.njk", { error: genericError });
    }
    if (user.role !== UserRole.ADMIN || user.banned) {
      return reply.code(401).view("login.njk", { error: genericError });
    }
    if (!verifyPassword(password, storedHash)) {
      return reply.code(401).view("login.njk", { error: genericError });
    }

    // Second factor: if this admin has TOTP enabled, require a valid code.
    const twoFaSecret = await getSetting(prisma, twoFaSecretKey(telegramId));
    if (twoFaSecret && !verifyTotp(twoFaSecret, body.totp_code ?? "")) {
      return reply.code(401).view("login.njk", { error: "Invalid credentials or 2FA code.", two_fa: true });
    }

    const jti = newJti();
    await setSetting(prisma, sessionJtiKey(telegramId), jti);
    resetLoginAttempts(ip);

    const { raw } = makeSession(user.id, telegramId, jti);
    reply.setCookie(config.WEB_COOKIE_NAME, raw, {
      path: "/",
      maxAge: config.WEB_SESSION_TTL_HOURS * 3600,
      httpOnly: true,
      sameSite: "lax",
      secure: false, // set true behind TLS — the reverse proxy handles this
    });
    logger.info(`Login OK telegram_id=${telegramId} ip=${ip}`);
    return reply.code(303).redirect("/");
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
