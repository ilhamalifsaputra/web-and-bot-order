/**
 * Entry point for the testimoni notifier. Port of notif_bot/main.py.
 * Connects to the shared DB via @app/db and runs the dispatcher polling loop.
 */
import { Bot } from "grammy";
import { initDb, prisma, resolveBotCredentials } from "@app/db";
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import { runDispatcher } from "./dispatcher";

async function main(): Promise<void> {
  if (config.PUBLIC_CHANNEL_ID === undefined) {
    throw new Error("PUBLIC_CHANNEL_ID is required for the notifier");
  }

  await initDb();

  // Setting wins, env is the fallback (plan.md §16). The standalone notifier
  // needs a dedicated token — it has no main bot instance to share.
  const { notifBotToken } = await resolveBotCredentials(prisma);
  if (!notifBotToken) {
    throw new Error("notif_bot_token (Settings) or NOTIF_BOT_TOKEN env is required for the notifier");
  }

  const bot = new Bot(notifBotToken);
  const me = await bot.api.getMe();
  logger.info(
    `Notif bot started: @${me.username} -> channel ${config.PUBLIC_CHANNEL_ID} ` +
      `(poll every ${config.NOTIF_POLL_INTERVAL_SECONDS}s)`,
  );

  await runDispatcher(bot);
}

main().catch((e) => {
  logger.error({ err: e }, "Notifier crashed");
  process.exit(1);
});
