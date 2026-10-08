/**
 * Polling loop that drains notification_outbox -> Telegram or -> email,
 * decided per row by `row.channel` (NotificationChannel.TELEGRAM, the
 * default, or NotificationChannel.EMAIL — added by the owner-email-
 * notifications feature).
 *
 * TELEGRAM lane — two kinds of rows:
 *  - Direct messages to a buyer/admin (payload.chat_id): ORDER_DELIVERED_DM,
 *    ORDER_MANUAL_DELIVERED_DM, ORDER_PROCESSING_DM, ADMIN_PW_RESET,
 *    WALLET_TOPUP_CREDITED_DM, ADMIN_NEW_TICKET, TICKET_REPLY_DM,
 *    TICKET_CLOSED_DM. These deliver regardless of whether a public channel
 *    is configured — the loop runs whenever a bot token is available.
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
 * ADMIN_NEW_TICKET and TICKET_REPLY_DM (Task 2, Phase C) are also handled by
 * their own dedicated branches, but for a different reason than the two
 * above: nothing is read live from the DB, they just need a reply_markup
 * inline keyboard (and, for ADMIN_NEW_TICKET, a follow-up `sendMediaGroup` of
 * the buyer's attached photo file ids) that the generic render()+sendMessage
 * path below has no way to carry. TICKET_CLOSED_DM has no keyboard, so it
 * goes through the generic path like any other simple DM.
 *
 * Payment-bubble flush hook (Task E3): right before sending
 * ORDER_DELIVERED_DM, ORDER_MANUAL_DELIVERED_DM, WALLET_TOPUP_CREDITED_DM or
 * ORDER_PROCESSING_DM — the four order-scoped DMs that follow a buyer paying
 * — this calls `flushPaymentBubble` (`@app/core/nudge`) so the order's payment
 * bubble (the "🔄 Refresh Status" / QR bubble) has finished flipping to its
 * settled state before the DM lands. Without this, a buyer could see their
 * credentials or top-up notice arrive above a still-pending "waiting for
 * payment" bubble, reading as "the shop sent my account before I paid" —
 * nothing was ever delivered early (`approveOrder`'s atomic claim gates
 * every credential send), it was purely a message-ordering artefact. Not
 * called for admin DMs, channel posts or broadcasts — those have no payment
 * bubble, so it would just cost a DB read each. `flushBubbleBeforeDm` below
 * bounds and swallows the call: a hung or failing flush must never block or
 * fail the DM it precedes.
 *
 * EMAIL lane — every row whose channel is EMAIL, whoever it is addressed to.
 * That is the shop owner's OWNER_EMAIL_* rows (Task 3's enqueueOwner*Email
 * helpers) and, since the order-ready receipt shipped, the buyer-addressed
 * BUYER_EMAIL_ORDER_READY as well. The lane does not care which: it is chosen
 * by `row.channel` alone and the recipient is whatever `payload.to` says.
 * payload carries `to` (never `chat_id`); the body/subject come from
 * `renderEmail` (emailTemplates.ts) and go out via SMTP creds resolved from
 * Settings (getSmtpCreds). SMTP being unconfigured is the shop's configuration,
 * not the row's fault, so those rows back off and retry forever rather than
 * failing — the same treatment a channel post gets when PUBLIC_CHANNEL_ID is
 * unset. There's no email analogue of Telegram flood control, so the EMAIL
 * lane never bails out of the tick early.
 *
 * Each pending row is sent independently; status is updated in short writes.
 * Telegram flood control
 * (429/RetryAfter) backs off and bails out of the tick; Forbidden (403) fails
 * the row at once.
 */
import { Bot, GrammyError, InputFile, InlineKeyboard, InputMediaBuilder } from "grammy";
import {
  prisma,
  fetchPendingNotifications,
  claimNotification,
  releaseNotificationClaim,
  releaseNotificationClaimWithBackoff,
  markNotificationSent,
  markNotificationFailed,
  getOrderByCodeFull,
  getSmtpCreds,
  recordPollHealth,
} from "@app/db";
import { config } from "@app/core/config";
import { registerOutboxNudge, flushPaymentBubble } from "@app/core/nudge";
import { publicChannelId } from "@app/core/runtime";
import { logger } from "@app/core/logger";
import { NotificationEvent, NotificationChannel, langCode } from "@app/core/enums";
import { fulfillmentProviderFor } from "@app/core/orderFulfillment";
import { sendMail } from "@app/core/mailer";
import {
  buildAccountFileContent,
  buildDeliveryCaption,
  warrantyDaysFor,
  accountFileName,
} from "@app/core/delivery";
import { render, escape } from "./templates";
import { renderEmail } from "./emailTemplates";

// Events delivered as a direct message (payload.chat_id), not as a post to
// PUBLIC_CHANNEL_ID. DMs only work from a bot the recipient has started —
// i.e. the main order-bot — so keep NOTIF_BOT_TOKEN unset for these to arrive.
const ADMIN_DM_EVENTS = new Set<string>([
  NotificationEvent.ADMIN_PW_RESET,
  NotificationEvent.ADMIN_OVERPAID, // admin DM (overpayment on any of the six payment rails)
  NotificationEvent.ORDER_DELIVERED_DM, // buyer DM (web auto-delivery)
  NotificationEvent.ORDER_PIPELINE_FAILED, // admin DM (Bybit BSC tracking pipeline failure)
  NotificationEvent.ORDER_PROCESSING_DM, // buyer DM (manual order queued for hand-fulfilment)
  NotificationEvent.PRODUCT_RESTOCKED_BROADCAST, // buyer DM (restock broadcast, all customers)
  NotificationEvent.RESTOCK_SUBSCRIBER_NOTIFIED, // buyer DM (a customer who asked to be told when this SKU is back)
  NotificationEvent.FLASH_SALE_BROADCAST, // buyer DM (flash sale went live, all customers)
  NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED, // admin DM (order queued for hand-fulfilment)
  NotificationEvent.ADMIN_STALE_PAYMENT, // admin DM (webhook delivery raced order's own expiry/cancel)
  NotificationEvent.ADMIN_UNCONFIRMABLE_PAYMENT, // admin DM (gateway says paid but sent no transaction id — needs a human before the order auto-cancels)
  NotificationEvent.ADMIN_DIGIFLAZZ_RESYNC_ABORTED, // admin DM (hourly Digiflazz catalog resync tripped its own blast-radius circuit breaker and wrote nothing — needs a human to check the supplier connection)
  NotificationEvent.ADMIN_DIGIFLAZZ_BELOW_COST, // admin DM (catalog prices need review after supplier cost changes)
  NotificationEvent.ADMIN_DIGIFLAZZ_SKUS_CHANGED, // admin DM (a catalog sync added, reactivated or deactivated SKUs)
  NotificationEvent.ADMIN_FX_RATE_REJECTED, // admin DM (the hourly market-rate refresh fetched a USD/IDR rate outside the sanity band — the saved rate stands, but the source needs checking)
  NotificationEvent.ADMIN_FX_RATE_STALE, // admin DM (the saved USD/IDR rate stopped being confirmed: past fx_quote_ttl_minutes no USDT rail is offered, past fx_rate_max_age_hours USDT is hidden shop-wide)
  NotificationEvent.WALLET_TOPUP_CREDITED_DM, // buyer DM (any rail's top-up settled, wallet credited — enqueued once by settleWalletTopup)
  NotificationEvent.TICKET_CLOSED_DM, // buyer DM (Task 2: an admin closed the buyer's support ticket)
]);

/** Telegram's hard cap on a single message's text length. */
const TELEGRAM_MESSAGE_MAX_LEN = 4096;

type PendingRow = Awaited<ReturnType<typeof fetchPendingNotifications>>[number];

/**
 * A row this dispatcher has claimed, carrying the exact `claimedAt` it claimed
 * with. Every write that settles the row (SENT, failed attempt, release) is
 * guarded by that timestamp (Task B1.2), so a send that outlived
 * STALE_CLAIM_MS — and lost the row to another dispatcher — can't overwrite
 * the new claimer's state. `signal` is the dispatcher's shutdown signal,
 * carried along so `trySend`'s flood-control sleep can wake on it (Task B1.4)
 * without threading another parameter through every deliver* branch.
 */
type ClaimedRow = PendingRow & { claimedAt: Date; signal?: AbortSignal };

/** Record a failed attempt on a claimed row, guarded by its claim. */
function failRow(row: ClaimedRow, error: string, maxAttempts: number): Promise<void> {
  return markNotificationFailed(prisma, row.id, error, maxAttempts, new Date(), row.claimedAt);
}

/**
 * Rows whose send already succeeded but whose SENT write failed (Task B1.1),
 * keyed by id, holding the claim timestamp they were sent under. Such a row
 * must never be sent again: it is skipped by every later tick of this process
 * and its SENT write is retried at the start of each tick until it lands (or
 * the row turns out to belong to someone else now). In-memory only — see the
 * residual-risk note on `recordSent`.
 */
const unrecordedSends = new Map<number, Date>();

/** Retry the SENT write for every send this process could not record yet. */
async function flushUnrecordedSends(): Promise<void> {
  for (const [id, claimedAt] of unrecordedSends) {
    try {
      const recorded = await markNotificationSent(prisma, id, claimedAt);
      unrecordedSends.delete(id);
      if (recorded) {
        logger.info(`Recorded notification ${id} as SENT on a later tick — it had been sent earlier but the first SENT write failed`);
      } else {
        logger.warn(`Gave up recording notification ${id} as SENT: it was sent earlier, but the row has since been reclaimed or changed by someone else, who now owns its outcome`);
      }
    } catch (err) {
      logger.warn({ err, notificationId: id }, `Still could not record notification ${id} as SENT — it was already sent and will not be sent again by this process; retrying the write next tick`);
    }
  }
}

/**
 * Sleep for `ms`, waking early if `signal` aborts (Task B1.4) — so a shutdown
 * during a long Telegram flood-control `retry_after` isn't held up by it.
 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Race `promise` against `timeoutMs`; resolves `"timeout"` if the deadline
 * wins. The underlying promise isn't cancelled when this loses the race — it
 * may still complete in the background — so this only bounds how long the
 * caller waits on it, not the call itself. Mirrors the identical small
 * `withTimeout` helper duplicated per-module across apps/order-bot's payment
 * rails (e.g. payments/telegramTimeout.ts) rather than importing one of
 * theirs: this package must not depend on `apps/order-bot` (see
 * `flushBubbleBeforeDm` below), and the duplication is the codebase's own
 * established pattern for this exact utility. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Bound for the payment-bubble flush hook (Task E3, `flushPaymentBubble`,
 * `@app/core/nudge`) — same value as `TELEGRAM_MESSAGE_TIMEOUT_MS`/
 * `RECONCILE_TELEGRAM_TIMEOUT_MS` elsewhere on this path (a single bounded
 * Telegram call reliably finishes in well under a second in the normal
 * case, so 5s stays generous). */
const BUBBLE_FLUSH_TIMEOUT_MS = 5_000;

/**
 * Ask the registered payment-bubble flush implementation (if any) to finish
 * flipping `orderId`'s payment bubble before the settlement DM that's about
 * to go out. Called only for the four order-scoped settlement DMs — see
 * this file's own module doc-comment.
 *
 * The registered implementation (apps/order-bot's `flushSettledOrderBubble`,
 * jobs/index.ts) already self-bounds with its own `withTimeout`
 * (payments/telegramTimeout.ts) and never throws by contract — this is a
 * second, independent bound at the boundary THIS package owns, since
 * nothing here can assume the registered function honours that contract
 * forever (defence in depth, not redundancy: a bubble flip is cosmetic, the
 * DM it precedes carries the buyer's credentials or wallet credit, so a hung
 * or failing flush must never block or fail that send).
 */
async function flushBubbleBeforeDm(orderId: number | null): Promise<void> {
  if (orderId == null) return;
  try {
    const outcome = await withTimeout(flushPaymentBubble(orderId), BUBBLE_FLUSH_TIMEOUT_MS);
    if (outcome === "timeout") {
      logger.warn(`Gave up waiting on the payment-bubble flush for order ${orderId} after ${BUBBLE_FLUSH_TIMEOUT_MS}ms — sending its settlement DM regardless; the background paid-order bubble sweep will still catch a stale bubble within a minute`);
    }
  } catch (err) {
    logger.warn({ err, orderId }, `The payment-bubble flush for order ${orderId} failed — sending its settlement DM regardless; the background paid-order bubble sweep will still catch a stale bubble within a minute`);
  }
}

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
 *
 * Task 15 (I-3, fresh backend audit 2026-08-21): this is the sole delivery
 * path for every buyer credential DM and every admin alert this codebase
 * enqueues, but unlike the six payment reconcile pollers it wrote no
 * heartbeat — a bad notifier token or an unhandled exception class silently
 * stopped all Telegram delivery with nothing but the `logger.error` line
 * below, no admin ever told (the one channel that would tell them is the
 * thing that's broken). `recordPollHealth(prisma, "outbox", ...)` on both the
 * success and failure path below gives `outboxDispatcherPollWatchdog`
 * (apps/order-bot/src/jobs/index.ts) a heartbeat to page admins from, the
 * same pattern already shared by `binancePollWatchdog` and its five twins.
 */
export async function runDispatcher(bot: Bot, signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
    try {
      const seen = await drainBatch(bot, signal);
      await recordPollHealth(prisma, "outbox", { lastTxCount: seen, success: true }).catch(() => undefined);
    } catch (e) {
      logger.error({ err: e }, "Outbox dispatcher tick failed — will retry on the next poll interval");
      // 300-char truncation matches this repo's own documented convention
      // (packages/core/src/payments/pollHealth.ts's LAST_ERROR_DISPLAY_MAX
      // comment) — the poller-side truncation the display logic already expects.
      await recordPollHealth(prisma, "outbox", { lastTxCount: 0, success: false, error: String(e).slice(0, 300) }).catch(() => undefined);
    }
    if (signal?.aborted) break;
    await sleepOrNudge(config.NOTIF_POLL_INTERVAL_SECONDS * 1000, signal);
  }
}

/** Exported for tests — drains exactly one batch (no polling loop). Returns
 * the number of rows it saw this cycle (`pending.length`), regardless of how
 * many were actually claimed/sent/failed/rate-limit-bailed — `runDispatcher`
 * above records this as `lastTxCount` on the outbox heartbeat (Task 15 / I-3). */
export async function drainBatch(bot: Bot, signal?: AbortSignal): Promise<number> {
  await flushUnrecordedSends();
  const pending = await fetchPendingNotifications(prisma, 50);
  if (pending.length === 0) return 0;

  logger.debug(`Draining ${pending.length} pending notification(s)`);

  for (const fetched of pending) {
    // Already sent by this process, only the SENT write is outstanding — even
    // once its claim goes stale it must not be claimed and sent again.
    if (unrecordedSends.has(fetched.id)) continue;

    // Atomic claim right before processing — closes the crash-window
    // double-send gap (Infra-2 fix): if this dispatcher dies between sending
    // and recording SENT, the row stays SENDING (not PENDING) and only
    // becomes claimable again once stale, instead of being re-sent on every
    // tick in the meantime. Also guards against an accidental second
    // dispatcher instance racing this one.
    const claimedAt = new Date();
    if (!(await claimNotification(prisma, fetched.id, claimedAt))) continue;
    const row: ClaimedRow = { ...fetched, claimedAt, signal };

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch (e) {
      await failRow(row, `bad payload json: ${e}`, 1);
      continue;
    }

    // EMAIL lane — decided by channel, not event name (checking channel first
    // is clearer/cheaper than relying on event names never colliding with the
    // Telegram-only special cases below). Owner- and buyer-addressed rows both
    // come through here; see deliverEmail's own doc comment below. No
    // rate-limit concept for email, so just move on to the next row either way.
    // Upgrade compatibility: old settlement rows must not describe an automatic
    // order as manual or create a second buyer message next to its tracked one.
    // ORDER_PROCESSING_DM is also dropped for any order (manual included) that
    // already has a progress message row, which carries that same news.
    if (row.orderId != null && row.event === NotificationEvent.WALLET_TOPUP_CREDITED_DM
      && await prisma.fulfillmentMessage.count({ where: { orderId: row.orderId, state: { notIn: ["STOPPED", "UNCERTAIN"] } } })) {
      await recordSent(row, "Telegram");
      continue;
    }
    // Routine wallet credits are visible in transaction history; owner alerts
    // are reserved for actionable financial exceptions.
    if (row.event === NotificationEvent.OWNER_EMAIL_WALLET_TOPUP) {
      await recordSent(row, "email");
      continue;
    }
    if (row.orderId != null && [
      NotificationEvent.ORDER_PROCESSING_DM,
      NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED,
      NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED,
      NotificationEvent.OWNER_EMAIL_ORDER_PAID,
    ].includes(row.event as never)) {
      const order = await prisma.order.findUnique({ where: { id: row.orderId }, include: { items: { include: { product: true } } } });
      const tracked = order && (fulfillmentProviderFor(order) === "DIGIFLAZZ"
        || row.event === NotificationEvent.OWNER_EMAIL_ORDER_PAID && fulfillmentProviderFor(order) !== "MANUAL"
        || row.event === NotificationEvent.ORDER_PROCESSING_DM
          && (await prisma.fulfillmentMessage.count({ where: { orderId: row.orderId } })) > 0);
      if (tracked) {
        await recordSent(row, row.channel === NotificationChannel.EMAIL ? "email" : "Telegram");
        continue;
      }
    }
    if (row.channel === NotificationChannel.EMAIL) {
      await deliverEmail(row, payload);
      continue;
    }

    // Buyer account-delivery DM: send the account(s) as a .txt document, with
    // credentials read live from the DB (never from the outbox payload).
    // Flush the payment bubble first (Task E3) — see this file's own module
    // doc-comment.
    if (row.event === NotificationEvent.ORDER_DELIVERED_DM) {
      await flushBubbleBeforeDm(row.orderId);
      if ((await deliverAccountDm(bot, row, payload)) === "ratelimited") return pending.length;
      continue;
    }

    // Buyer manual-fulfilment DM: send the admin-typed deliveredContent as a
    // plain message, with the content read live from the DB (never from the
    // outbox payload) — same credential-safety rule as ORDER_DELIVERED_DM.
    // Flush the payment bubble first (Task E3) — see this file's own module
    // doc-comment.
    if (row.event === NotificationEvent.ORDER_MANUAL_DELIVERED_DM) {
      await flushBubbleBeforeDm(row.orderId);
      if ((await deliverManualContentDm(bot, row, payload)) === "ratelimited") return pending.length;
      continue;
    }

    // Admin/support-group DM: a new ticket was opened. Needs a reply_markup
    // keyboard (Reply/Close) and, when the buyer attached photos, a follow-up
    // sendMediaGroup — neither of which the generic render() + plain
    // sendMessage path below can carry, so this gets its own branch (Task 2),
    // same reason ORDER_DELIVERED_DM/ORDER_MANUAL_DELIVERED_DM do. No payment
    // bubble to flush — tickets aren't order-scoped settlement DMs.
    if (row.event === NotificationEvent.ADMIN_NEW_TICKET) {
      if ((await deliverAdminNewTicketDm(bot, row, payload)) === "ratelimited") return pending.length;
      continue;
    }

    // Buyer DM: an admin replied to their ticket. Needs a reply_markup
    // keyboard ("Mark as Resolved") the generic path can't carry — same
    // reason as ADMIN_NEW_TICKET above.
    if (row.event === NotificationEvent.TICKET_REPLY_DM) {
      if ((await deliverTicketReplyDm(bot, row, payload)) === "ratelimited") return pending.length;
      continue;
    }

    // `render` runs money fields through `formatIdr`/`formatUsdt`
    // (templates.ts), which THROW on a non-numeric value — deliberately: they
    // are also called from live checkout/settlement code, where a garbage
    // amount is a bug worth surfacing loudly, not silently coercing to "0".
    // A malformed outbox payload is the one place that throw must not
    // propagate: uncaught here it would abort the rest of this batch and
    // leave the row this claimed stuck in SENDING until the stale-claim
    // window, only to throw again on the retry. Isolate it the same way a
    // bad `payloadJson` is isolated above — fail this one row (maxAttempts=1;
    // a malformed payload cannot become valid on retry) and keep draining the
    // rest of the batch.
    let text: string;
    try {
      text = render(row.event, payload);
    } catch (e) {
      // Warned, not just recorded in `lastError`: this notification is now
      // dropped for good (maxAttempts=1), so a buyer who was owed a delivery
      // or top-up confirmation will never receive one and only an operator
      // reaching into the outbox table would otherwise ever find out. The
      // payload itself is deliberately kept out of the message — it is the
      // thing that was malformed, and it may carry values from an untrusted
      // source.
      logger.warn(
        { err: e, notificationId: row.id, event: row.event, orderId: row.orderId },
        `Could not render notification ${row.id} from its stored payload, so it has been failed permanently and the recipient will never receive it — a malformed payload cannot become valid on a retry. Check the notification_outbox row's payload against what the enqueueing code should have written for this event.`,
      );
      await failRow(row, `template render failed: ${e}`, 1);
      continue;
    }
    if (!text) {
      // Unknown event type — drop so we don't loop forever.
      await failRow(row, `no template for event ${row.event}`, 1);
      continue;
    }

    const isDm = ADMIN_DM_EVENTS.has(row.event);
    // Channel post with no channel configured → release back to PENDING with
    // backoff so it posts once a public channel is (re)set (never failed
    // permanently — an admin might reconfigure at any time), but without
    // re-claiming a batch slot on every single tick forever (Outbox-1 fix,
    // backend audit).
    if (!isDm && publicChannelId() === undefined) {
      await releaseNotificationClaimWithBackoff(prisma, row.id, new Date(), row.claimedAt);
      continue;
    }
    const chatId = isDm ? Number(payload.chat_id) : Number(publicChannelId());
    if (!Number.isFinite(chatId)) {
      await failRow(row, isDm ? "missing chat_id" : "no PUBLIC_CHANNEL_ID", 1);
      continue;
    }

    // The last two order-scoped settlement DMs (Task E3) — see this file's own
    // module doc-comment. Every other event reaching this generic send (admin
    // DMs, channel posts, broadcasts) has no payment bubble, so it's
    // deliberately excluded.
    //
    // ORDER_PROCESSING_DM was missing here until the final whole-branch
    // review, and it is the one settlement DM the per-rail reordering could
    // never fix on its own: `settlePaidOrder` enqueues it INSIDE the
    // settlement transaction, so it can already be waiting in the outbox
    // before the rail reaches its own bubble flip at all. A buyer of a
    // hand-fulfilled SKU would then read "your order is being prepared" above
    // a bubble still saying "waiting for payment", with a live Refresh button
    // under it — the same thing the credential DM used to do.
    if (
      row.event === NotificationEvent.WALLET_TOPUP_CREDITED_DM ||
      row.event === NotificationEvent.ORDER_PROCESSING_DM
    ) {
      await flushBubbleBeforeDm(row.orderId);
    }

    if ((await trySend(bot, row, () => bot.api.sendMessage(chatId, text, { parse_mode: "HTML" }))) === "ratelimited") {
      return pending.length; // remaining rows retry next tick
    }
  }
  return pending.length;
}

/**
 * Read an order for a credential DM, decrypting its secrets. An unreadable
 * secret (a corrupt value, a missing or wrong key, legacy plaintext under
 * strict mode) must not escape: thrown out of drainBatch it aborted the whole
 * batch, left this row SENDING to be reclaimed and retried forever without
 * ever counting an attempt, and starved every row queued behind it. Instead it
 * is recorded as a failed attempt on this row only — so it backs off, retries
 * (the key may be fixed meanwhile) and dead-letters at NOTIF_MAX_ATTEMPTS like
 * any other failed send — and nothing is sent: never ciphertext, never a
 * placeholder. The error names the order and the reason class, never content.
 */
async function readOrderForDelivery(
  row: ClaimedRow,
  code: string,
): Promise<Awaited<ReturnType<typeof getOrderByCodeFull>> | "unreadable"> {
  try {
    return await getOrderByCodeFull(prisma, code);
  } catch (e) {
    logger.error(
      { err: e, notificationId: row.id, orderCode: code },
      `Could not read the delivered credentials for order ${code}, so notification ${row.id} was not sent — recording a failed attempt; it retries with backoff and dead-letters at the attempt limit`,
    );
    await failRow(
      row,
      `could not decrypt the delivered credentials for order ${code}: ${e instanceof Error ? e.name : "error"}`,
      config.NOTIF_MAX_ATTEMPTS,
    );
    return "unreadable";
  }
}

/**
 * Deliver a buyer's account(s) as a `<order-code>.txt` document. Reads the order
 * (incl. stock credentials) live from the DB — the outbox payload only carries
 * the order code + chat id, never credentials.
 */
async function deliverAccountDm(
  bot: Bot,
  row: ClaimedRow,
  payload: Record<string, unknown>,
): Promise<"ok" | "ratelimited"> {
  const chatId = Number(payload.chat_id);
  if (!Number.isFinite(chatId)) {
    await failRow(row, "missing chat_id", 1);
    return "ok";
  }
  const code = typeof payload.order_code === "string" ? payload.order_code : "";
  const order = code ? await readOrderForDelivery(row, code) : null;
  if (order === "unreadable") return "ok";
  if (!order) {
    await failRow(row, `order not found for code ${code}`, 1);
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
  row: ClaimedRow,
  payload: Record<string, unknown>,
): Promise<"ok" | "ratelimited"> {
  const chatId = Number(payload.chat_id);
  if (!Number.isFinite(chatId)) {
    await failRow(row, "missing chat_id", 1);
    return "ok";
  }
  const code = typeof payload.order_code === "string" ? payload.order_code : "";
  const order = code ? await readOrderForDelivery(row, code) : null;
  if (order === "unreadable") return "ok";
  if (!order) {
    await failRow(row, `order not found for code ${code}`, 1);
    return "ok";
  }
  if (!order.deliveredContent) {
    // Shouldn't normally happen — fulfillManualOrder always sets deliveredContent
    // before enqueueing this DM — but the dispatcher must not assume the DB
    // can't have surprised it (e.g. a bug elsewhere, or the row processed out
    // of order).
    await failRow(row, "order has no deliveredContent", 1);
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

/** Callback-data convention mirrored from apps/order-bot's own
 * keyboards/admin.ts (`ticketReplyKb`) and keyboards/customer.ts (`cb`) — the
 * versioned `v1:` prefix followed by a colon-separated path. This package
 * must not depend on apps/order-bot (see `withTimeout`'s doc comment above
 * for the same rule applied to a different helper), so the two ticket
 * keyboards below build their `InlineKeyboard`s directly rather than
 * importing those helpers; keep the literal strings here in sync with
 * keyboards/admin.ts/customer.ts if either ticket callback's shape ever
 * changes. */

/**
 * Deliver the "new support ticket" forward to an admin/support-group chat
 * (Task 2). Unlike `deliverAccountDm`/`deliverManualContentDm`, nothing here
 * is read live from the DB — every field the message needs already rode in
 * the outbox payload (`enqueueAdminNewTicketDm`, packages/db/src/crud/
 * notifications.ts) — this function only needs its own branch because the
 * send itself is more than the generic path's plain `sendMessage`: a
 * Reply/Close inline keyboard, and — when the buyer attached photos — a
 * follow-up `sendMediaGroup` of their file ids (never binary; see this
 * event's own doc comment, @app/core/enums).
 */
async function deliverAdminNewTicketDm(
  bot: Bot,
  row: ClaimedRow,
  payload: Record<string, unknown>,
): Promise<"ok" | "ratelimited"> {
  const chatId = Number(payload.chat_id);
  if (!Number.isFinite(chatId)) {
    await failRow(row, "missing chat_id", 1);
    return "ok";
  }
  const ticketId = Number(payload.ticket_id);
  const fromUserId = escape(String(payload.from_user_id ?? ""));
  const fromUsername = escape(typeof payload.from_username === "string" ? payload.from_username : "");
  const message = escape(String(payload.message ?? ""));
  const photoFileIds = Array.isArray(payload.photo_file_ids)
    ? payload.photo_file_ids.filter((f): f is string => typeof f === "string")
    : [];
  const photoNote = photoFileIds.length ? `\n📎 ${photoFileIds.length} photo(s) attached` : "";
  // Mirrors conversations/support.ts's pre-outbox forwardText exactly.
  const text =
    `🆘 <b>New support ticket #${ticketId}</b>\n` +
    `From: <code>${fromUserId}</code> (@${fromUsername})${photoNote}\n\n` +
    `${message}`;
  const keyboard = new InlineKeyboard()
    .text("💬 Reply", `v1:adm:ticket:reply:${ticketId}`)
    .text("🔒 Close", `v1:adm:ticket:close:${ticketId}`);

  return trySend(bot, row, async () => {
    // Both sends happen inside this one trySend callback so SENT/FAILED/
    // rate-limit bookkeeping happens exactly once for the pair — mirrors
    // deliverManualContentDm's multi-chunk send above. If a rate-limit hits
    // between them, the text already went out and can't be un-sent; the
    // retry resends both, so admins could rarely see the text duplicated —
    // same accepted tradeoff as the multi-chunk case.
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: keyboard });
    if (photoFileIds.length) {
      await bot.api.sendMediaGroup(chatId, photoFileIds.map((fid) => InputMediaBuilder.photo(fid)));
    }
  });
}

/**
 * Deliver the buyer's "admin replied to your ticket" DM (Task 2). Always
 * English — see `NotificationEvent.TICKET_REPLY_DM`'s own doc comment for
 * why. Needs its own branch (not the generic render() path) for the same
 * reason as `deliverAdminNewTicketDm`: a reply_markup keyboard ("Mark as
 * Resolved") the generic plain `sendMessage` can't carry.
 */
async function deliverTicketReplyDm(
  bot: Bot,
  row: ClaimedRow,
  payload: Record<string, unknown>,
): Promise<"ok" | "ratelimited"> {
  const chatId = Number(payload.chat_id);
  if (!Number.isFinite(chatId)) {
    await failRow(row, "missing chat_id", 1);
    return "ok";
  }
  const ticketId = Number(payload.ticket_id);
  const message = escape(String(payload.message ?? ""));
  // Mirrors conversations/admin.ts's pre-outbox coreT("support.admin_reply", "en", …) exactly.
  const text =
    `<b>Reply from support:</b>\n\n${message}\n\n` +
    `<i>If your issue is resolved, tap the button below to close this ticket.</i>`;
  const keyboard = new InlineKeyboard().text("✅ Mark as Resolved", `v1:ticket:close:${ticketId}`);

  return trySend(bot, row, () => bot.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: keyboard }));
}

/**
 * Run one Telegram send and update the outbox row. Returns "ratelimited" when
 * Telegram flood-controlled us (caller should bail the tick); "ok" otherwise
 * (sent, or failed-and-recorded).
 *
 * Only a failed SEND is ever recorded as a failed attempt. Once the send has
 * succeeded the row is finished from the buyer's side, whatever happens to
 * the SENT write afterwards (Task B1.1) — see `recordSent`.
 */
async function trySend(bot: Bot, row: ClaimedRow, send: () => Promise<unknown>): Promise<"ok" | "ratelimited"> {
  try {
    await send();
  } catch (e) {
    if (e instanceof GrammyError && e.parameters?.retry_after) {
      logger.warn(`Telegram rate-limited the dispatcher — sleeping ${e.parameters.retry_after}s before retrying, or less if the dispatcher is shutting down`);
      await sleepAbortable((e.parameters.retry_after + 1) * 1000, row.signal);
      // Release the claim (not a failed attempt) so the row is immediately
      // retryable next tick instead of waiting out the full stale-claim
      // window — flood control is transient, not the row's fault.
      await releaseNotificationClaim(prisma, row.id, row.claimedAt);
      return "ratelimited";
    }
    if (e instanceof GrammyError && e.error_code === 403) {
      logger.error(`Telegram forbade sending notification ${row.id} — the bot is blocked or not in the target channel, marking it failed`);
      await failRow(row, "Forbidden: bot blocked, or not in channel / lacks post permission", 1);
      return "ok";
    }
    logger.error({ err: e }, `Failed to send notification ${row.id} — recording the attempt, it will retry until it hits the max attempt limit`);
    await failRow(row, String(e), config.NOTIF_MAX_ATTEMPTS);
    return "ok";
  }
  await recordSent(row, "Telegram");
  return "ok";
}

/**
 * Record a successfully sent row as SENT. Never throws, and never sends the
 * row back to PENDING or counts a failed attempt (Task B1.1): the message is
 * already out, and a retry would deliver it twice — for ORDER_DELIVERED_DM,
 * the buyer's credentials. If the write fails, the row is parked in
 * `unrecordedSends` so this process never sends it again and retries only the
 * write on each later tick.
 *
 * Residual risk, accepted: the parking is in memory, so if the SENT write
 * keeps failing AND this process restarts before it lands, the row is still
 * SENDING with an old claim and a fresh process reclaims and re-sends it once
 * STALE_CLAIM_MS has passed. Closing that needs a durable "sent" record the
 * failing database could not take either.
 */
async function recordSent(row: ClaimedRow, via: "Telegram" | "email"): Promise<void> {
  try {
    const recorded = await markNotificationSent(prisma, row.id, row.claimedAt);
    if (recorded) {
      logger.info(`Sent notification ${row.id} (${row.event}) by ${via}`);
    } else {
      logger.warn(
        `Sent notification ${row.id} (${row.event}) by ${via}, but the send outlasted this dispatcher's claim and another instance had already reclaimed the row, so this one did not record SENT — that instance may deliver it a second time`,
      );
    }
  } catch (err) {
    unrecordedSends.set(row.id, row.claimedAt);
    logger.error(
      { err, notificationId: row.id },
      `Sent notification ${row.id} (${row.event}) by ${via}, but could not record it as SENT — this process will not send it again and retries recording SENT at the start of every tick`,
    );
  }
}

/**
 * Deliver one EMAIL-channel row, whoever it is addressed to. It handles every
 * EMAIL-channel event: the shop owner's OWNER_EMAIL_* rows, and
 * BUYER_EMAIL_ORDER_READY, which goes to the customer instead. No routing
 * change was needed to add the buyer one: this lane is selected purely by
 * `row.channel`, and the recipient comes from `payload.to` below, whoever
 * wrote it. Do not add per-event recipient logic here.
 *
 * Mirrors the Telegram render()/chatId-resolution steps above, but for mail:
 * unknown event or missing `to` fail the row at once (maxAttempts=1), same as
 * the Telegram "no template"/"missing chat_id" drops; SMTP being unconfigured
 * releases the claim with backoff instead of failing — this is the shop's
 * configuration, not the row's fault, exactly like a channel post left
 * PENDING when PUBLIC_CHANNEL_ID is unset. Never returns a rate-limit signal
 * — there's no email analogue of Telegram flood control.
 */
async function deliverEmail(row: ClaimedRow, payload: Record<string, unknown>): Promise<void> {
  // renderEmail is async (the OWNER_EMAIL_ORDER_PAID, OWNER_EMAIL_WALLET_TOPUP
  // and BUYER_EMAIL_ORDER_READY branches resolve brand — and for ORDER_PAID,
  // copy — from Settings via Prisma) — see emailTemplates.ts's header comment.
  //
  // It and getSmtpCreds below can throw (a settings read failing, a stored
  // SMTP password that no longer decrypts). Thrown out of drainBatch that
  // aborted the rest of the batch and left this row SENDING to be reclaimed
  // every STALE_CLAIM_MS without ever counting an attempt (Task B1.3) — the
  // same trap `readOrderForDelivery` documents. Record a failed attempt on
  // this row only, so it backs off and dead-letters like any failed send.
  let rendered: Awaited<ReturnType<typeof renderEmail>>;
  try {
    rendered = await renderEmail(row.event, payload);
  } catch (e) {
    logger.error(
      { err: e, notificationId: row.id, event: row.event },
      `Could not render email notification ${row.id} (${row.event}), so it was not sent — recording a failed attempt; it retries with backoff and dead-letters at the attempt limit`,
    );
    await failRow(row, `email render failed: ${e instanceof Error ? e.name : "error"}`, config.NOTIF_MAX_ATTEMPTS);
    return;
  }
  if (!rendered) {
    await failRow(row, `no email template for event ${row.event}`, 1);
    return;
  }

  const to = payload.to;
  if (typeof to !== "string" || !to) {
    await failRow(row, "missing to address", 1);
    return;
  }

  let creds: Awaited<ReturnType<typeof getSmtpCreds>>;
  try {
    creds = await getSmtpCreds(prisma);
  } catch (e) {
    // The error class only — never the message, which could echo SMTP
    // settings content.
    logger.error(
      { notificationId: row.id, errorName: e instanceof Error ? e.name : "error" },
      `Could not read the SMTP settings for email notification ${row.id}, so it was not sent — recording a failed attempt; it retries with backoff and dead-letters at the attempt limit`,
    );
    await failRow(row, `could not read SMTP settings: ${e instanceof Error ? e.name : "error"}`, config.NOTIF_MAX_ATTEMPTS);
    return;
  }
  if (!creds) {
    // SMTP unconfigured — the shop's configuration, not this row's fault.
    // Back off and retry forever instead of failing away; the mail goes out
    // once the owner fills in SMTP.
    await releaseNotificationClaimWithBackoff(prisma, row.id, new Date(), row.claimedAt);
    return;
  }

  // rendered.html is undefined for the three plain-text-only events
  // (OWNER_EMAIL_MANUAL_ORDER_QUEUED, OWNER_EMAIL_NEW_TICKET,
  // OWNER_EMAIL_TICKET_REPLY) and a real string for the events that render
  // through the shared HTML design system — OWNER_EMAIL_ORDER_PAID,
  // OWNER_EMAIL_WALLET_TOPUP, and BUYER_EMAIL_ORDER_READY — sendMail's `html`
  // param is optional (Task 2), so passing `undefined` here is a no-op for
  // the plain-text three, unchanged from before this field existed.
  await trySendEmail(row, () => sendMail(creds, { to, subject: rendered.subject, text: rendered.text, html: rendered.html }));
}

/**
 * Run one email send and update the outbox row. No "ratelimited" state to
 * return — unlike `trySend`, email has no transport-level flood-control or
 * forbidden-recipient concept to special-case, so a failure always just
 * records the attempt for the standard backoff/retry cycle.
 */
async function trySendEmail(row: ClaimedRow, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (e) {
    logger.error({ err: e }, `Failed to send notification ${row.id} — recording the attempt, it will retry until it hits the max attempt limit`);
    await failRow(row, String(e), config.NOTIF_MAX_ATTEMPTS);
    return;
  }
  await recordSent(row, "email");
}
