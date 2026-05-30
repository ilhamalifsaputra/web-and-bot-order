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

/** Oldest pending rows first, capped at `limit`. */
export function fetchPendingNotifications(db: Db, limit = 50) {
  return db.notificationOutbox.findMany({
    where: { status: NotificationStatus.PENDING },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/** Mark a row SENT with the current timestamp. */
export async function markNotificationSent(
  db: Db,
  notifId: number,
): Promise<void> {
  await db.notificationOutbox.update({
    where: { id: notifId },
    data: { status: NotificationStatus.SENT, sentAt: new Date() },
  });
}

/**
 * Increment attempts and record the error (truncated to 500 chars). Flip to
 * FAILED only once attempts >= maxAttempts; otherwise it stays PENDING for a
 * later retry. No-op if the row is gone.
 */
export async function markNotificationFailed(
  db: Db,
  notifId: number,
  error: string,
  maxAttempts = 5,
): Promise<void> {
  const row = await db.notificationOutbox.findUnique({ where: { id: notifId } });
  if (!row) return;
  const attempts = row.attempts + 1;
  await db.notificationOutbox.update({
    where: { id: notifId },
    data: {
      attempts,
      lastError: error.slice(0, 500),
      ...(attempts >= maxAttempts
        ? { status: NotificationStatus.FAILED }
        : {}),
    },
  });
}
