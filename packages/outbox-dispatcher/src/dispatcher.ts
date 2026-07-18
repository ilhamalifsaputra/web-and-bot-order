/**
 * Polling loop that drains notification_outbox -> Telegram.
 *
 * Two kinds of rows:
 *  - Direct messages to a buyer/admin (payload.chat_id): ORDER_DELIVERED_DM,
 *    ORDER_MANUAL_DELIVERED_DM, ORDER_PROCESSING_DM, ADMIN_PW_RESET. These
 *    deliver regardless of whether a public channel is configured — the loop
 *    runs whenever a bot token is available.
 *  - Channel posts (ORDER_DELIVERED testimonial): need PUBLIC_CHANNEL_ID. When
 *    no channel is configured they are left PENDING (skipped) so they post once
 *    a channel is set, rather than being failed away.
 *
 * ORDER_DELIVERED_DM and ORDER_MANUAL_DELIVERED_DM are special: the buyer's
 * account/credentials are read LIVE from the DB at send time — ORDER_DELIVERED_DM
 * as a `<order-code>.txt` document, ORDER_MANUAL_DELIVERED_DM (per-SKU manual
 * delivery flows) as the admin-typed `Order.deliveredContent` sent as one or
 * more plain messages. Credentials/content NEVER ride in the outbox payload
 * (CLAUDE.md).
 *
 * Each pending row is sent independently; status is updated in short writes to
 * keep the SQLite write lock held only briefly. Telegram flood control
 * (429/RetryAfter) backs off and bails out of the tick; Forbidden (403) fails
 * the row at once.
 */
import { Bot, GrammyError, InputFile } from "grammy";
import {
  prisma,
  fetchPendingNotifications,
  claimNotification,
  releaseNotificationClaim,
  releaseNotificationClaimWithBackoff,
  markNotificationSent,
  markNotificationFailed,
  getOrderByCodeFull,
} from "@app/db";
import { config } from "@app/core/config";
import { registerOutboxNudge } from "@app/core/nudge";
import { publicChannelId } from "@app/core/runtime";
import { logger } from "@app/core/logger";
import { NotificationEvent, langCode } from "@app/core/enums";
import {
  buildAccountFileContent,
  buildDeliveryCaption,
  warrantyDaysFor,
  accountFileName,
} from "@app/core/delivery";
import { render, escape } from "./templates";

// Events delivered as a direct message (payload.chat_id), not as a post to
// PUBLIC_CHANNEL_ID. DMs only work from a bot the recipient has started —
// i.e. the main order-bot — so keep NOTIF_BOT_TOKEN unset for these to arrive.
const ADMIN_DM_EVENTS = new Set<string>([
  NotificationEvent.ADMIN_PW_RESET,
  NotificationEvent.ADMIN_OVERPAID, // admin DM (gateway webhook overpayment)
  NotificationEvent.ORDER_DELIVERED_DM, // buyer DM (web auto-delivery)
  NotificationEvent.ORDER_PIPELINE_FAILED, // admin DM (Bybit BSC tracking pipeline failure)
  NotificationEvent.ORDER_PROCESSING_DM, // buyer DM (manual order queued for hand-fulfilment)
  NotificationEvent.PRODUCT_RESTOCKED_BROADCAST, // buyer DM (restock broadcast, all customers)
]);

/** Telegram's hard cap on a single message's text length. */
const TELEGRAM_MESSAGE_MAX_LEN = 4096;

type PendingRow = Awaited<ReturnType<typeof fetchPendingNotifications>>[number];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sleep for `ms` milliseconds, but wake immediately if `nudgeOutboxDispatcher`
 * is called or the AbortSignal fires. Replaces the plain `sleep()` so webhook
 * handlers can cut the poll gap from up to NOTIF_POLL_INTERVAL_SECONDS to
 * near-zero after enqueueing ORDER_DELIVERED_DM.
 */
function sleepOrNudge(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      registerOutboxNudge(null);
      resolve();
    };
    const timer = setTimeout(done, ms);
    registerOutboxNudge(() => {
      clearTimeout(timer);
      done();
    });
    signal?.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
  });
}

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
      logger.error({ err: e }, "Outbox dispatcher tick failed — will retry on the next poll interval");
    }
    if (signal?.aborted) break;
    await sleepOrNudge(config.NOTIF_POLL_INTERVAL_SECONDS * 1000, signal);
  }
}

/** Exported for tests — drains exactly one batch (no polling loop). */
export async function drainBatch(bot: Bot): Promise<void> {
  const pending = await fetchPendingNotifications(prisma, 50);
  if (pending.length === 0) return;

  logger.debug(`Draining ${pending.length} pending notification(s)`);

  for (const row of pending) {
    // Atomic claim right before processing — closes the crash-window
    // double-send gap (Infra-2 fix): if this dispatcher dies between sending
    // and recording SENT, the row stays SENDING (not PENDING) and only
    // becomes claimable again once stale, instead of being re-sent on every
    // tick in the meantime. Also guards against an accidental second
    // dispatcher instance racing this one.
    if (!(await claimNotification(prisma, row.id))) continue;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch (e) {
      await markNotificationFailed(prisma, row.id, `bad payload json: ${e}`, 1);
      continue;
    }

    // Buyer account-delivery DM: send the account(s) as a .txt document, with
    // credentials read live from the DB (never from the outbox payload).
    if (row.event === NotificationEvent.ORDER_DELIVERED_DM) {
      if ((await deliverAccountDm(bot, row, payload)) === "ratelimited") return;
      continue;
    }

    // Buyer manual-fulfilment DM: send the admin-typed deliveredContent as a
    // plain message, with the content read live from the DB (never from the
    // outbox payload) — same credential-safety rule as ORDER_DELIVERED_DM.
    if (row.event === NotificationEvent.ORDER_MANUAL_DELIVERED_DM) {
      if ((await deliverManualContentDm(bot, row, payload)) === "ratelimited") return;
      continue;
    }

    const text = render(row.event, payload);
    if (!text) {
      // Unknown event type — drop so we don't loop forever.
      await markNotificationFailed(prisma, row.id, `no template for event ${row.event}`, 1);
      continue;
    }

    const isDm = ADMIN_DM_EVENTS.has(row.event);
    // Channel post with no channel configured → release back to PENDING with
    // backoff so it posts once a public channel is (re)set (never failed
    // permanently — an admin might reconfigure at any time), but without
    // re-claiming a batch slot on every single tick forever (Outbox-1 fix,
    // backend audit).
    if (!isDm && publicChannelId() === undefined) {
      await releaseNotificationClaimWithBackoff(prisma, row.id);
      continue;
    }
    const chatId = isDm ? Number(payload.chat_id) : Number(publicChannelId());
    if (!Number.isFinite(chatId)) {
      await markNotificationFailed(prisma, row.id, isDm ? "missing chat_id" : "no PUBLIC_CHANNEL_ID", 1);
      continue;
    }

    if ((await trySend(bot, row, () => bot.api.sendMessage(chatId, text, { parse_mode: "HTML" }))) === "ratelimited") {
      return; // remaining rows retry next tick
    }
  }
}

/**
 * Deliver a buyer's account(s) as a `<order-code>.txt` document. Reads the order
 * (incl. stock credentials) live from the DB — the outbox payload only carries
 * the order code + chat id, never credentials.
 */
async function deliverAccountDm(
  bot: Bot,
  row: PendingRow,
  payload: Record<string, unknown>,
): Promise<"ok" | "ratelimited"> {
  const chatId = Number(payload.chat_id);
  if (!Number.isFinite(chatId)) {
    await markNotificationFailed(prisma, row.id, "missing chat_id", 1);
    return "ok";
  }
  const code = typeof payload.order_code === "string" ? payload.order_code : "";
  const order = code ? await getOrderByCodeFull(prisma, code) : null;
  if (!order) {
    await markNotificationFailed(prisma, row.id, `order not found for code ${code}`, 1);
    return "ok";
  }

  const lang = langCode(order.user.language);
  const warranty = warrantyDaysFor(order.items);
  const content = buildAccountFileContent(
    { orderCode: order.orderCode, warrantyDays: warranty, items: order.items },
    lang,
  );
  const file = new InputFile(Buffer.from(content, "utf8"), accountFileName(order.orderCode));

  return trySend(bot, row, () =>
    bot.api.sendDocument(chatId, file, {
      caption: buildDeliveryCaption(order.orderCode, warranty, lang),
      parse_mode: "HTML",
    }),
  );
}

/**
 * Split `text` into chunks of at most `maxLen` characters, breaking only at
 * line boundaries (never mid-word) where possible. If a single line alone
 * exceeds `maxLen` it's kept whole in its own chunk rather than cut mid-word
 * — the same "keep whole" tradeoff `templates.ts`'s `fmtItems` takes on an
 * over-long single item.
 */
function chunkText(text: string, maxLen = TELEGRAM_MESSAGE_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Deliver a buyer's manually-typed account content (an admin-fulfilled
 * MANUAL/MANUAL_WITH_INFO order) as one or more plain messages. Reads
 * `Order.deliveredContent` live from the DB — the outbox payload only
 * carries the order code + chat id, never the content itself (same
 * credential-safety rule as `deliverAccountDm`/ORDER_DELIVERED_DM).
 */
async function deliverManualContentDm(
  bot: Bot,
  row: PendingRow,
  payload: Record<string, unknown>,
): Promise<"ok" | "ratelimited"> {
  const chatId = Number(payload.chat_id);
  if (!Number.isFinite(chatId)) {
    await markNotificationFailed(prisma, row.id, "missing chat_id", 1);
    return "ok";
  }
  const code = typeof payload.order_code === "string" ? payload.order_code : "";
  const order = code ? await getOrderByCodeFull(prisma, code) : null;
  if (!order) {
    await markNotificationFailed(prisma, row.id, `order not found for code ${code}`, 1);
    return "ok";
  }
  if (!order.deliveredContent) {
    // Shouldn't normally happen — fulfillManualOrder always sets deliveredContent
    // before enqueueing this DM — but the dispatcher must not assume the DB
    // can't have surprised it (e.g. a bug elsewhere, or the row processed out
    // of order).
    await markNotificationFailed(prisma, row.id, "order has no deliveredContent", 1);
    return "ok";
  }

  const codeEsc = escape(order.orderCode);
  const caption =
    `✅ <b>Order <code>${codeEsc}</code></b> — here's your account:\n\n` +
    `✅ <b>Pesanan <code>${codeEsc}</code></b> — berikut akun kamu:`;
  const fullText = `${caption}\n\n${escape(order.deliveredContent)}`;
  const chunks = chunkText(fullText);

  return trySend(bot, row, async () => {
    // All chunks are sent inside this one trySend callback so the SENT/
    // FAILED/rate-limit bookkeeping happens exactly once for the whole
    // sequence, and they go out sequentially in order (the buyer must
    // receive them in the right order). Accepted tradeoff (mirrors
    // approveOrder's own documented races): if a rate-limit hits mid-way
    // through a multi-chunk send, earlier chunks already went out and can't
    // be un-sent — trySend's retry resends from chunk 1, so a buyer could
    // rarely see an early chunk duplicated.
    for (const chunk of chunks) {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
    }
  });
}

/**
 * Run one Telegram send and update the outbox row. Returns "ratelimited" when
 * Telegram flood-controlled us (caller should bail the tick); "ok" otherwise
 * (sent, or failed-and-recorded).
 */
async function trySend(bot: Bot, row: PendingRow, send: () => Promise<unknown>): Promise<"ok" | "ratelimited"> {
  try {
    await send();
    await markNotificationSent(prisma, row.id);
    logger.info(`Sent notification ${row.id} (${row.event}) to Telegram`);
    return "ok";
  } catch (e) {
    if (e instanceof GrammyError && e.parameters?.retry_after) {
      logger.warn(`Telegram rate-limited the dispatcher — sleeping ${e.parameters.retry_after}s before retrying`);
      await sleep((e.parameters.retry_after + 1) * 1000);
      // Release the claim (not a failed attempt) so the row is immediately
      // retryable next tick instead of waiting out the full stale-claim
      // window — flood control is transient, not the row's fault.
      await releaseNotificationClaim(prisma, row.id);
      return "ratelimited";
    }
    if (e instanceof GrammyError && e.error_code === 403) {
      logger.error(`Telegram forbade sending notification ${row.id} — the bot is blocked or not in the target channel, marking it failed`);
      await markNotificationFailed(prisma, row.id, "Forbidden: bot blocked, or not in channel / lacks post permission", 1);
      return "ok";
    }
    logger.error({ err: e }, `Failed to send notification ${row.id} — recording the attempt, it will retry until it hits the max attempt limit`);
    await markNotificationFailed(prisma, row.id, String(e), config.NOTIF_MAX_ATTEMPTS);
    return "ok";
  }
}
