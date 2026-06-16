/**
 * Entry point for the testimoni notifier. Port of notif_bot/main.py.
 * Connects to the shared DB via @app/db and runs the dispatcher polling loop.
 */
import { Bot } from "grammy";
import { initDb, prisma, resolveBotCredentials, resolveAdminIds } from "@app/db";
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import { setAdminIds, setBotIdentity } from "@app/core/runtime";
import { runDispatcher } from "./dispatcher";

async function main(): Promise<void> {
  await initDb();
  setAdminIds(await resolveAdminIds(prisma));

  // Setting wins, env is the fallback (plan.md §16). Stamp the channel id so the
  // dispatcher's publicChannelId() getter sees it.
  const { notifBotToken, publicChannelId } = await resolveBotCredentials(prisma);
  if (publicChannelId === null) {
    throw new Error("public_channel_id is not set — add it in web admin (Settings → Bot & notifications) or PUBLIC_CHANNEL_ID in .env");
  }
  setBotIdentity({ publicChannelId });

  // The standalone notifier needs a dedicated token — it has no main bot instance.
  if (!notifBotToken) {
    throw new Error("notif_bot_token (Settings) or NOTIF_BOT_TOKEN env is required for the notifier");
  }

  const bot = new Bot(notifBotToken);
  const me = await bot.api.getMe();
  logger.info(
    `Notif bot started: @${me.username} -> channel ${publicChannelId} ` +
      `(poll every ${config.NOTIF_POLL_INTERVAL_SECONDS}s)`,
  );

  await runDispatcher(bot);
}

main().catch((e) => {
  logger.error({ err: e }, "Notifier crashed");
  process.exit(1);
});
