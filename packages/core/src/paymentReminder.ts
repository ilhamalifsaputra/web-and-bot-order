/**
 * Shared timing rules for the buyer's one-time "your payment window is about
 * to close" push (NotificationEvent.PAYMENT_REMINDER_DM, owner decision for
 * the Game Top-up refactor Phase 4 — it applies to every service and to
 * wallet top-ups).
 *
 * Three places use these and must agree, which is why they live here rather
 * than in any one of them: the order-bot's `sendPaymentReminders` job decides
 * whether to enqueue, `enqueuePaymentReminderDm` (packages/db) stamps the
 * payload, and the outbox dispatcher re-checks eligibility and renders the
 * remaining time at SEND time.
 */

/**
 * The reminder is pointless — and risks landing next to, or after, the
 * auto-cancel notice — once less than this much time is left. Both the job
 * (before enqueueing) and the dispatcher (before sending) drop it below this
 * floor, so a row delayed by a dispatcher backoff, flood control or a restart
 * can never arrive in the window's last minute. `autoCancelExpiredOrders`
 * runs on second 0 of every minute, so a minute of margin also keeps the push
 * clear of the cancel tick.
 */
export const PAYMENT_REMINDER_MIN_REMAINING_MS = 60_000;

/**
 * Whole minutes left before `expiresAt`, rounded DOWN and never below 1 — the
 * buyer is told slightly less time than they really have, never more. Callers
 * only reach this with at least `PAYMENT_REMINDER_MIN_REMAINING_MS` left, so
 * the floor of 1 is a guard, not a normal case.
 */
export function paymentReminderMinutesLeft(expiresAt: Date, now: Date): number {
  return Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 60_000));
}

/** The outbox dedupe key that makes the reminder at most once per order. */
export function paymentReminderDedupeKey(orderId: number): string {
  return `payment_reminder:${orderId}`;
}

/**
 * The outbox dedupe key that makes the expiry push (ORDER_EXPIRED_DM, the
 * other half of the same owner decision) at most once per order. Its queueing
 * may run twice for one order — inside the cancel transaction for a tracked
 * message, or right after a Telegram edit for an anchored bubble — and a
 * second bot instance may run the sweep too.
 */
export function orderExpiredDedupeKey(orderId: number): string {
  return `order_expired:${orderId}`;
}
