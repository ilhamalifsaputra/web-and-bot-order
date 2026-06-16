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
import { publicChannelId } from "@app/core/runtime";
import { logger } from "@app/core/logger";
import { NotificationEvent } from "@app/core/enums";
import { render } from "./templates";

// Events delivered as a direct message (payload.chat_id), not as a post to
// PUBLIC_CHANNEL_ID. DMs only work from a bot the recipient has started —
// i.e. the main order-bot — so keep NOTIF_BOT_TOKEN unset for these to arrive.
const ADMIN_DM_EVENTS = new Set<string>([
  NotificationEvent.ADMIN_PW_RESET,
  NotificationEvent.ORDER_DELIVERED_DM, // buyer DM (web auto-delivery)
]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Drain the outbox forever. Pass an `AbortSignal` to stop the loop gracefully
 * (used by the combined single-process server on SIGTERM/SIGINT); the standalone
 * notifier omits it and loops until the process exits.
 */
export async function runDispatcher(bot: Bot, signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
    try {
      await drainBatch(bot);
    } catch (e) {
      logger.error({ err: e }, "Dispatcher tick error, continuing...");
    }
    if (signal?.aborted) break;
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

    // Admin DMs target payload.chat_id; everything else posts to the channel.
    const isDm = ADMIN_DM_EVENTS.has(row.event);
    const chatId = isDm ? Number(payload.chat_id) : Number(publicChannelId());
    if (!Number.isFinite(chatId)) {
      await markNotificationFailed(prisma, row.id, isDm ? "missing chat_id" : "no PUBLIC_CHANNEL_ID", 1);
      continue;
    }

    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
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
          `Bot is not allowed to post in channel ${publicChannelId()} — marking failed`,
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
