/**
 * Polling loop that drains notification_outbox -> the public Telegram channel.
 * Direct port of notif_bot/dispatcher.py.
 *
 * Each pending row is sent independently; status is updated in short writes to
 * keep the SQLite write lock held only briefly (the bot.* writers run in the
 * same DB). Telegram flood control (429/RetryAfter) backs off and bails out of
 * the tick so the rest retry next poll; Forbidden (403) fails the row at once.
 */
import { Bot, GrammyError } from "grammy";
import {
  prisma,
  fetchPendingNotifications,
  markNotificationSent,
  markNotificationFailed,
} from "@app/db";
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import { render } from "./templates";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runDispatcher(bot: Bot): Promise<void> {
  for (;;) {
    try {
      await drainBatch(bot);
    } catch (e) {
      logger.error({ err: e }, "Dispatcher tick error, continuing...");
    }
    await sleep(config.NOTIF_POLL_INTERVAL_SECONDS * 1000);
  }
}

async function drainBatch(bot: Bot): Promise<void> {
  const pending = await fetchPendingNotifications(prisma, 50);
  if (pending.length === 0) return;

  logger.debug(`Draining ${pending.length} pending notification(s)`);

  for (const row of pending) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch (e) {
      await markNotificationFailed(prisma, row.id, `bad payload json: ${e}`, 1);
      continue;
    }

    const text = render(row.event, payload);
    if (!text) {
      // Unknown event type — drop so we don't loop forever.
      await markNotificationFailed(
        prisma,
        row.id,
        `no template for event ${row.event}`,
        1,
      );
      continue;
    }

    try {
      await bot.api.sendMessage(Number(config.PUBLIC_CHANNEL_ID), text, {
        parse_mode: "HTML",
      });
      await markNotificationSent(prisma, row.id);
      logger.info(`Sent notif id=${row.id} event=${row.event}`);
    } catch (e) {
      if (e instanceof GrammyError && e.parameters?.retry_after) {
        // Telegram flood control: sleep then bail; remaining rows retry next tick.
        logger.warn(`Rate limited, sleeping ${e.parameters.retry_after}s`);
        await sleep((e.parameters.retry_after + 1) * 1000);
        return;
      }
      if (e instanceof GrammyError && e.error_code === 403) {
        logger.error(
          `Bot is not allowed to post in channel ${config.PUBLIC_CHANNEL_ID} — marking failed`,
        );
        await markNotificationFailed(
          prisma,
          row.id,
          "Forbidden: bot not in channel or lacks post permission",
          1,
        );
        continue;
      }
      logger.error({ err: e }, `Failed to send notif id=${row.id}`);
      await markNotificationFailed(
        prisma,
        row.id,
        String(e),
        config.NOTIF_MAX_ATTEMPTS,
      );
    }
  }
}
