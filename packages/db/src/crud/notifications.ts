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
import {
  NotificationEvent,
  NotificationStatus,
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

/** Oldest claimable rows first (PENDING, or SENDING claimed past STALE_CLAIM_MS), capped at `limit`. */
export function fetchPendingNotifications(db: Db, limit = 50, now: Date = new Date()) {
  const staleCutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  return db.notificationOutbox.findMany({
    where: claimableWhere(staleCutoff, now),
    orderBy: { createdAt: "asc" },
    take: limit,
  });
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
