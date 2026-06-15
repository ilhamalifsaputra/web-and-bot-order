/**
 * Setup wizard (spec §4) — first-run onboarding entirely in the browser.
 * Pre-auth (no session yet), so like /bootstrap these POSTs carry no CSRF token;
 * the bind-127.0.0.1 + short setup window + permanent lock (spec §8) are the
 * mitigations. /setup* is excluded from the setup gate (see plugins/setupGate),
 * and locks itself once `setup_completed` is set (final step only).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { logger } from "@app/core/logger";
import { prisma, getSetting, setSetting, isSetupCompleted } from "@app/db";
import { setTokenValidator, getTokenValidator } from "../lib/telegramCheck";

// Re-exported for tests that import setTokenValidator from this module.
export { setTokenValidator };

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
}
