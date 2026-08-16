/**
 * The greppable event vocabulary for the payment path (Task E6).
 *
 * When a buyer says "I paid but got nothing" or "I was charged twice", the
 * question is always the same: what happened to THIS payment, across the
 * webhook that may have confirmed it, the poller that may have confirmed it
 * first, and the outbox row that was supposed to tell them. The prose in those
 * log lines was already good, but every rail phrased its own moments
 * differently, so answering that question meant knowing six vocabularies. The
 * names below are one vocabulary for all six.
 *
 * These are for the STRUCTURED METADATA object only — `logger.info({ event:
 * PaymentLogEvent.PAYMENT_CONFIRMED, ... }, "A full English sentence.")`. That
 * object is explicitly exempt from the message-string sentence convention
 * (docs/LOGGING.md); the message string beside it still has to read as a
 * sentence and must never be replaced by a bare event name.
 *
 * Observability only. Emitting one of these must never change what the code
 * does — no early return, no swallowed error, no extra write.
 *
 * ── LEVELS ─────────────────────────────────────────────────────────────────
 * `PAYMENT_ALREADY_CONFIRMED` and `WALLET_CREDIT_ALREADY_APPLIED` are `info`,
 * not `warn`: a lost ledger claim is the idempotency gate WORKING. Two
 * confirmations racing is the expected shape of this system (a webhook and a
 * poller are meant to overlap), and logging the normal case as a warning
 * trains operators to ignore warnings.
 *
 * ── VOLUME ─────────────────────────────────────────────────────────────────
 * Every event here is a state TRANSITION — a payment being accepted, a wallet
 * moving, a notification being queued, a bubble reaching its final state. The
 * pollers run every few seconds over every pending order; none of these may be
 * emitted per poll, per pending order, or per sweep row, or the transitions
 * drown in the polling. `sweepPaidOrderBubbles` (apps/order-bot/src/jobs/index.ts)
 * aggregates by count for exactly this reason — keep it that way.
 *
 * ── NEVER IN THE METADATA ──────────────────────────────────────────────────
 * Credentials, payment-proof `file_id`, password hashes, database URLs,
 * gateway API keys or secrets, HMAC signatures, deposit addresses. A
 * provider's public transaction id is fine — it identifies a payment but
 * cannot authenticate a request. If a value could be replayed to a gateway or
 * would let someone impersonate the shop or the buyer, it does not go in a log
 * line, structured or not (CLAUDE.md, "Never log secrets").
 */
export const PaymentLogEvent = {
  /** A provider payment was accepted and its ledger claim succeeded for the
   *  first time. Emitted once per payment, by whichever of the webhook or the
   *  poller won the claim. */
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  /** A ledger claim was lost — this payment had already been processed. The
   *  `already_processed` and `stale` returns of the six `deliverPaid*Order`
   *  helpers. Expected, not a fault. */
  PAYMENT_ALREADY_CONFIRMED: "PAYMENT_ALREADY_CONFIRMED",
  /** `settleWalletTopup` credited the buyer's wallet (`credited > 0`). */
  WALLET_CREDIT_APPLIED: "WALLET_CREDIT_APPLIED",
  /** `settleWalletTopup`'s atomic claim was lost, so it returned
   *  `credited: 0` and moved no money. The wallet half of
   *  `PAYMENT_ALREADY_CONFIRMED`. */
  WALLET_CREDIT_ALREADY_APPLIED: "WALLET_CREDIT_ALREADY_APPLIED",
  /** A buyer-facing outbox row was enqueued. Not emitted for a deduped
   *  enqueue that wrote nothing — that did not create a notification. */
  NOTIFICATION_CREATED: "NOTIFICATION_CREATED",
  /** A payment bubble reached its final state: edited in place, replaced, or
   *  deleted. Not emitted for an attempt left to be retried. */
  TELEGRAM_PAYMENT_MESSAGE_UPDATED: "TELEGRAM_PAYMENT_MESSAGE_UPDATED",
} as const;

export type PaymentLogEvent = (typeof PaymentLogEvent)[keyof typeof PaymentLogEvent];

/**
 * The correlation fields every event above carries, so one payment can be
 * followed across processes with a single grep. Consistency IS the feature
 * here: a field that means `orderId` on one rail and `order_id` on another
 * cannot be filtered on.
 *
 * `orderId` (not `orderCode`) because it is the join key every table already
 * uses; the code is in the message sentence beside it, where a human reads it.
 */
export interface PaymentLogFields {
  event: PaymentLogEvent;
  /** `Order.id`. */
  orderId: number;
  /** Which rail. `PaymentMethod` values (`@app/core/enums`), so this filters
   *  the same way `Order.paymentMethod` does. */
  provider: string;
  /** The gateway's own public transaction/payment id, where the rail has one
   *  at this point. Never a secret — see the module comment. */
  providerPaymentId?: string;
  /** The outcome being reported, in the vocabulary the emitting function
   *  already returns (`delivered`, `processing`, `already_processed`,
   *  `stale`, `edited`, `replaced`, `deleted`, …) — not a second spelling
   *  invented for the log. */
  status?: string;
}
