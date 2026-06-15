/**
 * Setup wizard (spec §4) — first-run onboarding entirely in the browser.
 * Pre-auth (no session yet), so like /bootstrap these POSTs carry no CSRF token;
 * the bind-127.0.0.1 + short setup window + permanent lock (spec §8) are the
 * mitigations. /setup* is excluded from the setup gate (see plugins/setupGate),
 * and locks itself once `setup_completed` is set (final step only).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { logger } from "@app/core/logger";
import { config } from "@app/core/config";
import { addAdminId, setAdminIds } from "@app/core/runtime";
import {
  prisma,
  getSetting,
  setSetting,
  deleteSetting,
  getUserByTelegramId,
  addAdminIdToDb,
  upsertUser,
  isSetupCompleted,
  markSetupComplete,
  logAdminAction,
  resolveAdminIds,
} from "@app/db";
import { hashPassword, makeSession, newJti, passwordHashKey, sessionJtiKey } from "../auth";
import { setTokenValidator, getTokenValidator } from "../lib/telegramCheck";

// Re-exported for tests that import setTokenValidator from this module.
export { setTokenValidator };

const OWNER_TG_KEY = "setup_owner_tg"; // carries the owner id from step 2 → finish

export default async function setupRoutes(app: FastifyInstance): Promise<void> {
  /** Once setup is locked, the wizard is gone — send to the normal login. */
  async function lockedRedirect(reply: FastifyReply): Promise<FastifyReply | null> {
    if (await isSetupCompleted(prisma)) {
      reply.code(303).redirect("/login");
      return reply;
    }
    return null;
  }

  // ---- Step 1: connect bot ----
  app.get("/setup", async (_req, reply) => {
    if (await lockedRedirect(reply)) return reply;
    return reply.view("setup_bot.njk", { error: null });
  });

  app.post("/setup/bot", async (req, reply) => {
    if (await lockedRedirect(reply)) return reply;
    const body = (req.body ?? {}) as Record<string, string>;
    if (body.skip) return reply.code(303).redirect("/setup/owner");

    const token = (body.bot_token ?? "").trim();
    if (!token) {
      return reply.code(400).view("setup_bot.njk", { error: "Tempel token bot dari BotFather, atau pilih 'Atur nanti'." });
    }
    const check = await getTokenValidator()(token);
    if (!check.ok) {
      return reply.code(400).view("setup_bot.njk", { error: "Token salah atau bot tidak ditemukan. Cek lagi dari BotFather." });
    }
    await setSetting(prisma, "bot_token", token);
    if (check.username) await setSetting(prisma, "bot_username", check.username);
    logger.info("Setup: bot token saved"); // never log the token
    return reply.code(303).redirect("/setup/owner");
  });

  // ---- Step 2: create owner (admin) ----
  app.get("/setup/owner", async (_req, reply) => {
    if (await lockedRedirect(reply)) return reply;
    return reply.view("setup_owner.njk", { error: null });
  });

  app.post("/setup/owner", async (req, reply) => {
    if (await lockedRedirect(reply)) return reply;
    const body = (req.body ?? {}) as Record<string, string>;
    const telegramId = Number(body.telegram_id);
    const username = (body.username ?? "").trim() || null;
    const password = body.password ?? "";
    const passwordConfirm = body.password_confirm ?? "";

    let error: string | null = null;
    if (!Number.isInteger(telegramId) || telegramId <= 0) {
      error = "Telegram ID harus berupa angka. Dapatkan dari @userinfobot.";
    } else if (password.length < 8) {
      error = "Password minimal 8 karakter.";
    } else if (password !== passwordConfirm) {
      error = "Konfirmasi password tidak cocok.";
    }
    if (error) return reply.code(400).view("setup_owner.njk", { error });

    // Make the id an admin in the runtime FIRST so upsertUser resolves role=ADMIN,
    // then persist everything in one short transaction (CLAUDE.md: single-writer).
    addAdminId(telegramId); // runtime first so upsertUser resolves role=ADMIN
    try {
      await prisma.$transaction(async (tx) => {
        await addAdminIdToDb(tx, telegramId);
        await upsertUser(tx, { telegramId, username, fullName: null });
        await setSetting(tx, passwordHashKey(telegramId), hashPassword(password));
      });
    } catch (err) {
      // Transaction failed — undo the in-memory promotion so isAdmin() stays
      // consistent with the DB (re-derive the canonical env ∪ DB list).
      setAdminIds(await resolveAdminIds(prisma));
      throw err;
    }
    await setSetting(prisma, OWNER_TG_KEY, String(telegramId));
    logger.info(`Setup: owner admin created telegram_id=${telegramId}`); // never log the password
    return reply.code(303).redirect("/setup/shop");
  });

  // ---- Step 3: shop basics (skippable) + finish ----
  app.get("/setup/shop", async (_req, reply) => {
    if (await lockedRedirect(reply)) return reply;
    return reply.view("setup_shop.njk", { error: null });
  });

  app.post("/setup/shop", async (req, reply) => {
    if (await lockedRedirect(reply)) return reply;
    const body = (req.body ?? {}) as Record<string, string>;

    // The owner must exist (step 2) before we can finish + auto-login.
    const ownerTg = Number(await getSetting(prisma, OWNER_TG_KEY));
    if (!Number.isInteger(ownerTg) || ownerTg <= 0) {
      return reply.code(303).redirect("/setup/owner");
    }

    if (body.skip !== "1") {
      const shopName = (body.shop_name ?? "").trim();
      const tagline = (body.shop_tagline ?? "").trim();
      if (shopName) await setSetting(prisma, "shop_name", shopName);
      if (tagline) await setSetting(prisma, "shop_tagline", tagline);
    }

    // Finish: lock the wizard, then auto-login the owner (rotate jti).
    await markSetupComplete(prisma);
    const owner = await getUserByTelegramId(prisma, ownerTg);
    if (owner) {
      const jti = newJti();
      await setSetting(prisma, sessionJtiKey(ownerTg), jti);
      const { raw } = makeSession(owner.id, ownerTg, jti);
      reply.setCookie(config.WEB_COOKIE_NAME, raw, {
        path: "/",
        maxAge: config.WEB_SESSION_TTL_HOURS * 3600,
        httpOnly: true,
        sameSite: "lax",
        secure: config.WEB_COOKIE_SECURE,
      });
      await logAdminAction(prisma, {
        adminId: owner.id,
        action: "web_setup_completed",
        targetType: "web_admin",
        targetId: null,
        details: `owner_telegram_id=${ownerTg}`,
      });
    } else {
      logger.error(`Setup finish: owner user row missing for telegram_id=${ownerTg}; auto-login skipped`);
    }
    await deleteSetting(prisma, OWNER_TG_KEY);
    logger.info(`Setup completed; owner auto-logged-in telegram_id=${ownerTg}`);
    return reply.code(303).redirect("/setup/done");
  });

  // ---- Done screen (auto-login already set; offers bot restart) ----
  app.get("/setup/done", async (_req, reply) => {
    const botConfigured = (await getSetting(prisma, "bot_token")) !== null;
    return reply.view("setup_done.njk", { bot_configured: botConfigured, error: null, restarted: false });
  });
}
