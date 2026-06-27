/**
 * Active-payment screen tracking + per-order timer teardown (extracted from
 * handlers/checkout.ts, A-02). The auto USDT rails (Binance Internal, Bybit)
 * mark which order a chat is currently viewing and tear down any timers an
 * order may still hold when the screen is left.
 *
 * These module-level maps are the single source of truth for active payment
 * screens; checkout.ts and the conversations import the helpers below so every
 * caller mutates the SAME maps.
 */

interface OrderTimers {
  interval?: NodeJS.Timeout;
  timeouts: NodeJS.Timeout[];
}
const timersByOrder = new Map<number, OrderTimers>();
/** chatId → orderId currently shown on the payment screen (the PTB guard). */
const activePaymentByChat = new Map<number, number>();

export function setActivePayment(chatId: number, orderId: number): void {
  activePaymentByChat.set(chatId, orderId);
}

/** Clear the chat's active-payment marker (used when leaving the screen). */
export function clearActivePayment(chatId: number): void {
  activePaymentByChat.delete(chatId);
}

/** Remove all scheduled countdown/reminder timers for this order. */
export function cancelPaymentJobs(orderId: number): void {
  const tm = timersByOrder.get(orderId);
  if (!tm) return;
  if (tm.interval) clearInterval(tm.interval);
  for (const to of tm.timeouts) clearTimeout(to);
  timersByOrder.delete(orderId);
}
