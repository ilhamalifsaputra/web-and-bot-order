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
 * The one comparator for that floor: true while at least
 * `PAYMENT_REMINDER_MIN_REMAINING_MS` is left. The job (enqueue) and the
 * dispatcher (send) both call this, so a row queued with exactly a minute
 * left is not then refused at send time by a stricter `>`.
 */
export function paymentReminderHasTimeLeft(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() - now.getTime() >= PAYMENT_REMINDER_MIN_REMAINING_MS;
}

/**
 * True only while NO payment has been observed for the order: its payment
 * state is unset or WAITING_PAYMENT, it carries no paid-at stamp, and no wallet
 * credit awaits review. Every other payment state counts as "seen" —
 * PAYMENT_DETECTED and VERIFYING (`recordProviderPaymentObservation` sets them
 * while the order status stays PENDING_PAYMENT), PAID, UNDERPAID, FAILED,
 * EXPIRED, REFUNDED, and any state added later (allow-list, so a new state is
 * safe by default).
 *
 * This is stricter than the expiry job's `customerPaymentOutstanding`
 * (packages/db orders.ts), on purpose: it decides who may be told "N minutes
 * left to pay, then the order is cancelled", and a buyer whose transfer is
 * already on its way who reads that may pay twice. The payment reminder's
 * enqueue and send halves and the "payment expired" email all use it.
 */
export function awaitingPaymentNothingObserved(order: {
  paymentState: string | null;
  paidAt: Date | null;
  walletCreditState: string | null;
}): boolean {
  return (!order.paymentState || order.paymentState === "WAITING_PAYMENT") && !order.paidAt && order.walletCreditState !== "NEEDS_REVIEW";
}

/**
 * True while a payment provider has reported a payment for the order that is
 * still confirming: PAYMENT_DETECTED or VERIFYING, the two states
 * `recordProviderPaymentObservation` (packages/db orderStatus.ts) writes while
 * the order status stays PENDING_PAYMENT (NOWPayments' IPN and reconcile
 * poller). The positive counterpart of `awaitingPaymentNothingObserved` for
 * exactly that in-flight case: PAID, UNDERPAID and the terminal states are NOT
 * in flight, they have their own paths.
 */
export function paymentObservedInFlight(paymentState: string | null | undefined): boolean {
  return paymentState === "PAYMENT_DETECTED" || paymentState === "VERIFYING";
}

/**
 * How long after `expiresAt` the expiry sweep keeps a PRODUCT order whose
 * payment is in flight (`paymentObservedInFlight`) open instead of cancelling
 * it, and the NOWPayments poller keeps checking it, so a payment that was
 * already on its way can still settle. After this the order is cancelled as
 * before and every admin is told once (ADMIN_UNCONFIRMABLE_PAYMENT,
 * `still_confirming`). A constant, not an env key: it is a safety margin, not
 * a shop setting.
 */
export const OBSERVED_PAYMENT_GRACE_MS = 30 * 60_000;

/** The start of the window an order's `expiresAt` must be inside for its
 *  in-flight payment to still be in its grace period at `now`: the order is
 *  held while `expiresAt > observedPaymentGraceCutoff(now)`, i.e. while
 *  `now < expiresAt + OBSERVED_PAYMENT_GRACE_MS`. */
export function observedPaymentGraceCutoff(now: Date): Date {
  return new Date(now.getTime() - OBSERVED_PAYMENT_GRACE_MS);
}

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
