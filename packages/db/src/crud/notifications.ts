/**
 * Notification outbox CRUD — port of the four functions in Python crud.py
 * (enqueue_notification / fetch_pending_notifications / mark_notification_sent
 * / mark_notification_failed). Same semantics; see migrate.md §5.5.
 *
 * Every function takes a Prisma client or transaction client as its first
 * argument (mirrors the SQLAlchemy `session` parameter). enqueue() does NOT
 * commit on its own — pass the same `tx` used by the triggering business
 * transaction so the outbox row lands atomically with the state change.
 */
import type { PrismaClient, Tx } from "../client";
import { config } from "@app/core/config";
import {
  NotificationEvent,
  NotificationStatus,
  langCode,
} from "@app/core/enums";
import type { Decimal } from "@app/core/money";
import { resolveAdminIds } from "./admins";

type Db = PrismaClient | Tx;

/** Insert one outbox row. Caller's transaction owns the commit. */
export async function enqueueNotification(
  db: Db,
  event: NotificationEvent,
  orderId: number,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.notificationOutbox.create({
    data: {
      event,
      orderId,
      payloadJson: JSON.stringify(payload),
    },
  });
}

/**
 * Enqueue a one-time web-admin password-reset code as an admin DM (orderId is
 * null — this is not tied to an order). The dispatcher routes ADMIN_PW_RESET
 * rows to `payload.chat_id` instead of the public channel. The web NEVER sends
 * Telegram itself; this just drops the row for the notifier/bot to deliver.
 */
export async function enqueueAdminPasswordReset(
  db: Db,
  args: { telegramId: number; code: string; ttlMinutes: number },
): Promise<void> {
  await db.notificationOutbox.create({
    data: {
      event: NotificationEvent.ADMIN_PW_RESET,
      orderId: null,
      payloadJson: JSON.stringify({
        chat_id: args.telegramId,
        code: args.code,
        ttl_minutes: args.ttlMinutes,
      }),
    },
  });
}

/**
 * Enqueue one admin DM per resolved admin (env ADMIN_IDS ∪ the DB `admin_ids`
 * Setting — same allow-list the bot/web panel resolve at runtime via
 * `resolveAdminIds`/`adminIds()`) alerting that a payment-gateway webhook
 * delivered an order whose paid amount exceeded the total. Previously looped
 * over `config.ADMIN_IDS` alone, so a shop managed entirely through the
 * DB/setup-wizard (no env ADMIN_IDS) never got these alerts (Infra-4 fix,
 * security audit 2026-06-23). orderId is set (unlike ADMIN_PW_RESET) so the
 * rows are visible from the order in the admin /outbox panel. No-op if no
 * admin is resolved. Numbers are carried as Decimal `.toString()` — never
 * `number` — per money rules.
 */
export async function enqueueAdminOverpaid(
  db: Db,
  args: {
    orderId: number;
    orderCode: string;
    paid: Decimal;
    expected: Decimal;
    excess: Decimal;
    currency: string;
  },
): Promise<void> {
  for (const adminId of await resolveAdminIds(db)) {
    await db.notificationOutbox.create({
      data: {
        event: NotificationEvent.ADMIN_OVERPAID,
        orderId: args.orderId,
        payloadJson: JSON.stringify({
          chat_id: adminId,
          order_code: args.orderCode,
          paid: args.paid.toString(),
          expected: args.expected.toString(),
          excess: args.excess.toString(),
          currency: args.currency,
        }),
      },
    });
  }
}

/**
 * Enqueue one admin DM per resolved admin alerting that a Bybit BSC order's
 * automated tracking pipeline failed post-detection (tracker lookup-failure
 * grace period exhausted, or a delivery throw after Bybit reported the
 * deposit Success) and needs manual action. Same fan-out-per-admin shape as
 * `enqueueAdminOverpaid`. `reason` is a short diagnostic string — never a
 * secret/credential, but still not the kind of detail a buyer should see,
 * hence an admin DM rather than anything customer-facing.
 */
export async function enqueueOrderPipelineFailed(
  db: Db,
  args: { orderId: number; orderCode: string; reason: string },
): Promise<void> {
  for (const adminId of await resolveAdminIds(db)) {
    await db.notificationOutbox.create({
      data: {
        event: NotificationEvent.ORDER_PIPELINE_FAILED,
        orderId: args.orderId,
        payloadJson: JSON.stringify({
          chat_id: adminId,
          order_code: args.orderCode,
          reason: args.reason.slice(0, 300),
        }),
      },
    });
  }
}

/**
 * Enqueue one admin DM per resolved admin alerting that a paid order routed
 * to the hand-fulfilment queue (settlePaidOrder's MANUAL branch — a
 * MANUAL/MANUAL_WITH_INFO SKU) and is waiting on an admin to fulfil it by
 * hand. Same fan-out-per-admin shape as `enqueueOrderPipelineFailed`. Numbers
 * are carried as Decimal `.toString()` — never `number` — per money rules.
 * No-op if no admin is resolved.
 */
export async function enqueueManualOrderAdminAlert(
  db: Db,
  args: {
    orderId: number;
    orderCode: string;
    items: { name: string; qty: number }[];
    total: Decimal;
    currency: string;
  },
): Promise<void> {
  for (const adminId of await resolveAdminIds(db)) {
    await db.notificationOutbox.create({
      data: {
        event: NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED,
        orderId: args.orderId,
        payloadJson: JSON.stringify({
          chat_id: adminId,
          order_code: args.orderCode,
          items: args.items,
          total: args.total.toString(),
          currency: args.currency,
        }),
      },
    });
  }
}

/**
 * Enqueue one admin DM per resolved admin alerting that a payment-gateway
 * webhook (TokoPay/PayDisini/NOWPayments) confirmed payment for an order that
 * had already left PENDING_PAYMENT by the time the delivery transaction ran
 * (M-10 fix, backend audit 2026-07-31) — routine, since
 * `autoCancelExpiredOrders` cancels orders on a timer and can race a slow
 * webhook. Nothing else recovers this automatically: the reconcile pollers
 * only act on orders still PENDING_PAYMENT, and `reconcileFinances` doesn't
 * scan ledger rows, so this needs a human to check whether the buyer actually
 * paid and reconcile manually. Same fan-out-per-admin shape as
 * `enqueueAdminOverpaid`. No-op if no admin is resolved.
 */
export async function enqueueAdminStalePayment(
  db: Db,
  args: { orderId: number; orderCode: string; gateway: string; trxId: string },
): Promise<void> {
  for (const adminId of await resolveAdminIds(db)) {
    await db.notificationOutbox.create({
      data: {
        event: NotificationEvent.ADMIN_STALE_PAYMENT,
        orderId: args.orderId,
        payloadJson: JSON.stringify({
          chat_id: adminId,
          order_code: args.orderCode,
          gateway: args.gateway,
          trx_id: args.trxId.slice(0, 300),
        }),
      },
    });
  }
}

/**
 * A SENDING row whose claim is older than this is treated as abandoned (the
 * dispatcher that claimed it died mid-send, before reaching
 * markNotificationSent/Failed) and becomes claimable again. Infra-2 fix,
 * security audit 2026-06-23.
 */
export const STALE_CLAIM_MS = 5 * 60_000;

/**
 * `nextRetryAt` IS NULL OR <= now — a row markNotificationFailed backed off
 * isn't claimable again until its window passes (Infra-3 fix, security audit
 * 2026-06-23). Shared by fetchPendingNotifications and claimNotification so
 * a backed-off row can never sneak through one but not the other.
 */
function claimableWhere(staleCutoff: Date, now: Date) {
  return {
    OR: [
      { status: NotificationStatus.PENDING },
      { status: NotificationStatus.SENDING, claimedAt: { lt: staleCutoff } },
    ],
    AND: { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
  };
}

// Bulk fan-out events (createMany, one row per customer — potentially
// hundreds/thousands at once) that must never be allowed to queue ahead of a
// single-recipient urgent DM (e.g. ADMIN_PW_RESET, the admin-panel
// forgot-password OTP) just because they happened to enqueue first.
const BROADCAST_EVENTS = new Set<string>([
  NotificationEvent.PRODUCT_RESTOCKED_BROADCAST,
  NotificationEvent.FLASH_SALE_BROADCAST,
]);

/**
 * Oldest claimable rows first (PENDING, or SENDING claimed past
 * STALE_CLAIM_MS), capped at `limit` — but urgent (non-broadcast) rows are
 * always returned ahead of bulk-broadcast rows, regardless of enqueue order.
 * Without this split, a large `enqueueRestockBroadcast`/
 * `enqueueFlashSaleBroadcast` fan-out sitting in the same FIFO queue could
 * delay an urgent DM enqueued moments later by many minutes.
 */
export async function fetchPendingNotifications(db: Db, limit = 50, now: Date = new Date()) {
  const staleCutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const where = claimableWhere(staleCutoff, now);

  const urgent = await db.notificationOutbox.findMany({
    where: { ...where, event: { notIn: [...BROADCAST_EVENTS] } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  if (urgent.length >= limit) return urgent;

  const broadcasts = await db.notificationOutbox.findMany({
    where: { ...where, event: { in: [...BROADCAST_EVENTS] } },
    orderBy: { createdAt: "asc" },
    take: limit - urgent.length,
  });
  return [...urgent, ...broadcasts];
}

/**
 * Atomically claim a row (PENDING, or SENDING past STALE_CLAIM_MS) right
 * before attempting to send it — closes the crash-window double-send gap
 * where a row could be sent to Telegram but the SENT write never lands
 * (Infra-2 fix). Returns false if another dispatcher already claimed it
 * (multi-instance) or it's no longer claimable; the caller must skip the row.
 */
export async function claimNotification(db: Db, notifId: number, now: Date = new Date()): Promise<boolean> {
  const staleCutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const res = await db.notificationOutbox.updateMany({
    where: { id: notifId, ...claimableWhere(staleCutoff, now) },
    data: { status: NotificationStatus.SENDING, claimedAt: now },
  });
  return res.count === 1;
}

/**
 * Release a claimed row back to PENDING without counting it as a failed
 * attempt — used for transient conditions that aren't the row's fault (e.g.
 * Telegram flood-control), so it's immediately retryable on the next tick
 * instead of waiting out the full STALE_CLAIM_MS window. No-op if the row was
 * already claimed by someone else or moved on (SENT/FAILED).
 */
export async function releaseNotificationClaim(db: Db, notifId: number): Promise<void> {
  await db.notificationOutbox.updateMany({
    where: { id: notifId, status: NotificationStatus.SENDING },
    data: { status: NotificationStatus.PENDING, claimedAt: null },
  });
}

/** Mark a row SENT with the current timestamp. */
export async function markNotificationSent(
  db: Db,
  notifId: number,
): Promise<void> {
  await db.notificationOutbox.update({
    where: { id: notifId },
    data: { status: NotificationStatus.SENT, sentAt: new Date(), claimedAt: null },
  });
}

// Exponential backoff for a row markNotificationFailed sends back to PENDING
// (Infra-3 fix, security audit 2026-06-23) — base 30s, doubling per attempt,
// capped at 10 minutes. At the default NOTIF_POLL_INTERVAL_SECONDS=10 this
// frees up several tick's worth of "top N" batch slots for valid rows
// instead of a permanently-failing row re-claiming one every single tick.
export const NOTIF_RETRY_BASE_MS = 30_000;
export const NOTIF_RETRY_MAX_MS = 10 * 60_000;

/** Exponential backoff delay for the Nth attempt (1-indexed), capped. */
export function notificationBackoffMs(attempts: number): number {
  return Math.min(NOTIF_RETRY_BASE_MS * 2 ** (attempts - 1), NOTIF_RETRY_MAX_MS);
}

/**
 * Increment attempts and record the error (truncated to 500 chars). Flip to
 * FAILED only once attempts >= maxAttempts; otherwise back to PENDING with an
 * exponential-backoff `nextRetryAt`, for a later retry. No-op if the row is
 * gone.
 */
export async function markNotificationFailed(
  db: Db,
  notifId: number,
  error: string,
  maxAttempts = 5,
  now: Date = new Date(),
): Promise<void> {
  const row = await db.notificationOutbox.findUnique({ where: { id: notifId } });
  if (!row) return;
  const attempts = row.attempts + 1;
  const failed = attempts >= maxAttempts;
  await db.notificationOutbox.update({
    where: { id: notifId },
    data: {
      attempts,
      lastError: error.slice(0, 500),
      claimedAt: null,
      status: failed ? NotificationStatus.FAILED : NotificationStatus.PENDING,
      nextRetryAt: failed ? null : new Date(now.getTime() + notificationBackoffMs(attempts)),
    },
  });
}

/**
 * Release a claimed row back to PENDING with the same exponential backoff
 * `markNotificationFailed` uses (attempts increment + `notificationBackoffMs`),
 * but WITHOUT ever transitioning it to FAILED — for conditions that are the
 * shop's configuration, not the row's fault (e.g. a channel-post event like
 * ORDER_DELIVERED enqueued while PUBLIC_CHANNEL_ID was set, then the channel
 * is unset/changed before it's delivered). An admin can fix the configuration
 * at any time, so no attempt count is ever terminal for this path — unlike
 * `releaseNotificationClaim` (used for transient conditions like Telegram
 * flood control), this backs off so the row stops re-claiming a batch slot
 * every single tick. No-op if the row was already claimed by someone else or
 * moved on (SENT/FAILED).
 */
export async function releaseNotificationClaimWithBackoff(
  db: Db,
  notifId: number,
  now: Date = new Date(),
): Promise<void> {
  const row = await db.notificationOutbox.findUnique({ where: { id: notifId } });
  if (!row) return;
  const attempts = row.attempts + 1;
  await db.notificationOutbox.updateMany({
    where: { id: notifId, status: NotificationStatus.SENDING },
    data: {
      attempts,
      claimedAt: null,
      status: NotificationStatus.PENDING,
      nextRetryAt: new Date(now.getTime() + notificationBackoffMs(attempts)),
    },
  });
}

/**
 * Enqueue the buyer's account-credentials DM for a DELIVERED order, for
 * callers that don't send it themselves — the web-admin panel's approve and
 * resend actions (CLAUDE.md: the web NEVER sends Telegram, only enqueues).
 * Same payload shape the payment-gateway auto-confirm rails already enqueue
 * (see tokopay.ts `deliverPaidTokopayOrder`). No-op for web-only buyers
 * (telegramId=null) — they see their order on the storefront instead.
 */
export async function enqueueOrderDeliveredDm(
  db: Db,
  args: { orderId: number; orderCode: string; telegramId: bigint | null; language: string | null },
): Promise<void> {
  if (args.telegramId == null) return;
  const shopUrl = config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null;
  await db.notificationOutbox.create({
    data: {
      event: NotificationEvent.ORDER_DELIVERED_DM,
      orderId: args.orderId,
      payloadJson: JSON.stringify({
        chat_id: Number(args.telegramId),
        order_code: args.orderCode,
        order_url: shopUrl ? `${shopUrl.replace(/\/+$/, "")}/account/orders/${args.orderCode}` : null,
        buyer_language: langCode(args.language),
      }),
    },
  });
}

/**
 * Enqueue the buyer's "payment received — being prepared by hand" DM when a
 * manual-delivery order moves PAID → PROCESSING (see settlePaidOrder). Carries
 * chat_id + order_code + language only; the dispatcher renders the reassurance
 * copy. No-op for web-only buyers (they see the status on the storefront).
 */
export async function enqueueOrderProcessingDm(
  db: Db,
  args: { orderId: number; orderCode: string; telegramId: bigint | null; language: string | null },
): Promise<void> {
  if (args.telegramId == null) return;
  const shopUrl = config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null;
  await enqueueNotification(db, NotificationEvent.ORDER_PROCESSING_DM, args.orderId, {
    chat_id: Number(args.telegramId),
    order_code: args.orderCode,
    order_url: shopUrl ? `${shopUrl.replace(/\/+$/, "")}/account/orders/${args.orderCode}` : null,
    buyer_language: langCode(args.language),
  });
}

/**
 * Enqueue the buyer's DM carrying the admin-typed fulfillment text for a manual
 * order (PROCESSING → DELIVERED, see fulfillManualOrder). Like the credentials
 * DM, the CONTENT itself is NOT placed in the payload — the dispatcher reads
 * Order.deliveredContent live at send time (the outbox table is admin-visible).
 * No-op for web-only buyers (they read deliveredContent on the storefront).
 */
export async function enqueueManualDeliveredDm(
  db: Db,
  args: { orderId: number; orderCode: string; telegramId: bigint | null; language: string | null },
): Promise<void> {
  if (args.telegramId == null) return;
  await enqueueNotification(db, NotificationEvent.ORDER_MANUAL_DELIVERED_DM, args.orderId, {
    chat_id: Number(args.telegramId),
    order_code: args.orderCode,
    buyer_language: langCode(args.language),
  });
}

/**
 * Enqueue a "back in stock" DM to every non-banned customer with a linked
 * Telegram account, for a product whose `broadcastOnRestock` flag is on.
 * Unlike RestockSubscription (per-SKU opt-in, one-shot), this targets the
 * entire customer base every time the flag is on and stock is added, so a
 * single `createMany` is used instead of a per-row loop (potentially
 * hundreds/thousands of recipients). No-op (returns 0) if there are no
 * eligible customers. The web NEVER sends Telegram itself — this just drops
 * the rows for the notifier/bot to deliver.
 *
 * Also writes a `Broadcast` row with status SENT so this shows up in the
 * web-admin Broadcast History table alongside manually-composed broadcasts —
 * that table is otherwise populated only by the separate admin-compose
 * flow (`createBroadcast`/`drainBroadcasts` in crud/broadcasts.ts), which
 * this feature deliberately does NOT route through (that pipeline sends with
 * no parse_mode, so the bold formatting below wouldn't render). The
 * sent/total counts here are optimistic (assume delivery succeeds) since the
 * actual per-recipient send happens later, asynchronously, via the outbox
 * dispatcher — unlike drainBroadcasts's real-time counts.
 *
 * `message` here MUST be kept in sync (plain-text, same content) with the
 * HTML template for NotificationEvent.PRODUCT_RESTOCKED_BROADCAST in
 * packages/outbox-dispatcher/src/templates.ts — that's the one actually sent
 * to customers; this is only what the admin sees in the History table.
 */
export async function enqueueRestockBroadcast(
  db: Db,
  args: { productName: string; stockCount: number; createdById?: number | null },
): Promise<number> {
  const users = await db.user.findMany({
    where: { banned: false, telegramId: { not: null } },
    select: { telegramId: true, language: true },
  });
  if (!users.length) return 0;
  await db.notificationOutbox.createMany({
    data: users.map((u) => ({
      event: NotificationEvent.PRODUCT_RESTOCKED_BROADCAST,
      orderId: null,
      payloadJson: JSON.stringify({
        chat_id: Number(u.telegramId),
        product_name: args.productName,
        stock_count: args.stockCount,
        buyer_language: langCode(u.language),
      }),
    })),
  });
  await db.broadcast.create({
    data: {
      message:
        `👋 Hello!\n\n` +
        `We're happy to let you know that ${args.productName} is back in stock! 🎉\n\n` +
        `📦 Available Stock: ${args.stockCount} accounts\n\n` +
        `Order now while supplies last. Thank you for choosing us!`,
      segment: "ALL",
      status: "SENT",
      totalCount: users.length,
      sentCount: users.length,
      failedCount: 0,
      createdById: args.createdById ?? null,
      scheduledAt: null,
      sentAt: new Date(),
    },
  });
  return users.length;
}

/**
 * Enqueue a "flash sale is live" DM to every non-banned customer with a linked
 * Telegram account, for a denomination whose scheduled sale window has just
 * opened (see the order-bot's `announceStartedFlashSales` job — that job stamps
 * `flashAnnouncedAt` in the same transaction, which is what stops the same sale
 * fanning out twice). Same shape as `enqueueRestockBroadcast`: one `createMany`
 * rather than a per-row loop, because this targets the whole customer base
 * (potentially hundreds/thousands of recipients). No-op (returns 0) if there
 * are no eligible customers.
 *
 * Prices and the end time arrive here as already-formatted display strings
 * (shop currency via `formatIdr`, shop timezone via `localize`) — the caller
 * owns that formatting, exactly like ORDER_DELIVERED's `delivered_at`, so the
 * dispatcher never has to do money or timezone math at send time.
 *
 * Also writes a `Broadcast` row with status SENT so the announcement shows up
 * in the web-admin Broadcast History table alongside the restock ones; the
 * sent/total counts are optimistic (assume delivery succeeds) since the actual
 * per-recipient send happens later, asynchronously, via the outbox dispatcher.
 *
 * `message` here MUST be kept in sync (plain-text, same content) with the HTML
 * template for NotificationEvent.FLASH_SALE_BROADCAST in
 * packages/outbox-dispatcher/src/templates.ts — that's the one actually sent to
 * customers; this is only what the admin sees in the History table.
 */
export async function enqueueFlashSaleBroadcast(
  db: Db,
  args: {
    productName: string;
    denominationName: string;
    discountPercent: string;
    oldPrice: string;
    newPrice: string;
    endsAt: string;
    createdById?: number | null;
  },
): Promise<number> {
  const users = await db.user.findMany({
    where: { banned: false, telegramId: { not: null } },
    select: { telegramId: true, language: true },
  });
  if (!users.length) return 0;
  await db.notificationOutbox.createMany({
    data: users.map((u) => ({
      event: NotificationEvent.FLASH_SALE_BROADCAST,
      orderId: null,
      payloadJson: JSON.stringify({
        chat_id: Number(u.telegramId),
        product_name: args.productName,
        denomination_name: args.denominationName,
        discount_percent: args.discountPercent,
        old_price: args.oldPrice,
        new_price: args.newPrice,
        ends_at: args.endsAt,
        buyer_language: langCode(u.language),
      }),
    })),
  });
  await db.broadcast.create({
    data: {
      message:
        `⚡ FLASH SALE — ${args.discountPercent}% OFF\n\n` +
        `${args.productName} — ${args.denominationName} is on sale right now! 🎉\n\n` +
        `💸 Now ${args.newPrice} (was ${args.oldPrice})\n` +
        `⏳ Ends: ${args.endsAt}\n\n` +
        `Grab it before the timer runs out!`,
      segment: "ALL",
      status: "SENT",
      totalCount: users.length,
      sentCount: users.length,
      failedCount: 0,
      createdById: args.createdById ?? null,
      scheduledAt: null,
      sentAt: new Date(),
    },
  });
  return users.length;
}

// ---- Outbox monitor (web-admin /outbox) -----------------------------------

/** Newest-first outbox rows, optionally filtered by status, with linked order code. */
export function listNotifications(
  db: Db,
  opts: { status?: string | null; limit?: number; offset?: number } = {},
) {
  return db.notificationOutbox.findMany({
    where: opts.status ? { status: opts.status } : {},
    orderBy: { createdAt: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 50,
    include: { order: { select: { id: true, orderCode: true } } },
  });
}

export function countNotifications(db: Db, opts: { status?: string | null } = {}) {
  return db.notificationOutbox.count({ where: opts.status ? { status: opts.status } : {} });
}

/** Count of outbox rows per status — drives the summary cards. */
export async function outboxStatusCounts(db: Db): Promise<Record<string, number>> {
  const grouped = await db.notificationOutbox.groupBy({ by: ["status"], _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;
  return counts;
}

/**
 * Requeue a FAILED (or stuck) notification: back to PENDING, attempts reset to
 * 0, error/sent cleared, so the notifier drains it again on its next cycle.
 * `nextRetryAt` is cleared too (Infra-3 fix, security audit 2026-06-23) — an
 * admin clicking "retry" means NOW, not "wait out whatever backoff window
 * this row was already in." Returns false if the row is gone. The web NEVER
 * sends Telegram itself.
 */
export async function retryNotification(db: Db, notifId: number): Promise<boolean> {
  const row = await db.notificationOutbox.findUnique({ where: { id: notifId } });
  if (!row) return false;
  await db.notificationOutbox.update({
    where: { id: notifId },
    data: { status: NotificationStatus.PENDING, attempts: 0, lastError: null, sentAt: null, nextRetryAt: null },
  });
  return true;
}
