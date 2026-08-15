/**
 * Per-order timer teardown (extracted from handlers/checkout.ts, A-02): drop
 * any countdown/reminder timers an order still holds once its payment screen
 * is left. This module-level map is the single source of truth for them, so
 * checkout.ts and the conversations import the helper below rather than
 * keeping maps of their own.
 *
 * There used to be a second map here, `activePaymentByChat` ("chatId → orderId
 * currently on screen", inherited from the python-telegram-bot port), with
 * `setActivePayment`/`clearActivePayment` writing and deleting entries from
 * twelve call sites. Nothing ever READ it — so it never guarded anything, and
 * in particular it never stopped a chat from opening a second checkout while
 * the first was still pending. That is precisely how one Telegram message
 * could end up claimed by two orders at once (see util/paymentAnchor.ts).
 * Anchor takeover handles that case properly now, on the database row rather
 * than in process memory, so the map was deleted rather than wired up: a guard
 * that lives only in memory would have been lost on every restart anyway.
 */

interface OrderTimers {
  interval?: NodeJS.Timeout;
  timeouts: NodeJS.Timeout[];
}
const timersByOrder = new Map<number, OrderTimers>();

/** Remove all scheduled countdown/reminder timers for this order. */
export function cancelPaymentJobs(orderId: number): void {
  const tm = timersByOrder.get(orderId);
  if (!tm) return;
  if (tm.interval) clearInterval(tm.interval);
  for (const to of tm.timeouts) clearTimeout(to);
  timersByOrder.delete(orderId);
}
