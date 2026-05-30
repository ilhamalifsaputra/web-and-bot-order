/**
 * Entry point for the testimoni notifier. Port of notif_bot/main.py.
 * Connects to the shared DB via @app/db and runs the dispatcher polling loop.
 */
import { Bot } from "grammy";
import { initDb } from "@app/db";
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import { runDispatcher } from "./dispatcher";

async function main(): Promise<void> {
  if (!config.NOTIF_BOT_TOKEN) {
    throw new Error("NOTIF_BOT_TOKEN is required for the notifier");
  }
  if (config.PUBLIC_CHANNEL_ID === undefined) {
    throw new Error("PUBLIC_CHANNEL_ID is required for the notifier");
  }

  await initDb();

  const bot = new Bot(config.NOTIF_BOT_TOKEN);
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
