/**
 * The one rule for deriving a settled payment's idempotency-ledger key on the
 * two IDR gateway rails, TokoPay and PayDisini.
 *
 * Both rails confirm a payment from two independent directions — the
 * storefront webhook (`/pay/tokopay/callback`, `/pay/paydisini/callback`) and
 * the bot's reconcile poller (`apps/order-bot/src/payments/*Reconcile.ts`) —
 * and both write the result into a ledger table whose `trxId` column is
 * UNIQUE (`ProcessedTokopayTx`, `ProcessedPaydisiniTx`). That UNIQUE
 * constraint is the PRIMARY idempotency gate: SQLite has no row locks, so a
 * duplicate insert failing is what stops one payment from being delivered
 * twice.
 *
 * That gate only works if the two paths derive the SAME key from the same
 * payment. They did not. Both ask the gateway for the live transaction
 * (`checkTransaction`) and both prefer the id it hands back, but their
 * fallbacks disagreed when the gateway's response carried no id: the webhook
 * fell through to the callback body's `trx_id`/`reference` and finally to
 * `ref_id`, while the poller invented `reconcile-<orderCode>`. Those are two
 * different UNIQUE rows for one payment, so the ledger did not catch the
 * duplicate at all — it was caught one layer down by the order-status check
 * that returns `"stale"`, which is defence-in-depth, not the intended gate.
 * The visible symptom is a spurious ADMIN_STALE_PAYMENT alert asking a human
 * to verify a payment that was in fact already delivered.
 *
 * The rule below removes the disagreement by making the key a pure function
 * of the live gateway call and the order:
 *
 *   1. the transaction id the gateway's own live status call returned, or
 *   2. the order code, which is exactly the `ref_id` we handed the gateway
 *      when the transaction was created — so it is still the gateway's own
 *      reference for this payment, not an invented label.
 *
 * Deliberately NOT part of the chain: the `trx_id`/`reference` fields on the
 * webhook's request body. Neither rail's signature covers them (TokoPay signs
 * `merchantId:secret:refId`; PayDisini signs `apiKey:userKey:refId:amount`),
 * the poller has no request body to read them from at all, and both routes
 * already treat the live call — not the body — as the source of truth for
 * "paid" and for the amount. Keying the ledger off the body would leave the
 * primary idempotency gate reading a field the caller can vary freely inside
 * one valid signature.
 *
 * The result is never empty and never varies between two calls about the same
 * payment: `orderCode` is a non-null UNIQUE column stamped at order creation,
 * so the fallback is always a real, order-scoped, stable string.
 *
 * NOWPayments deliberately does not use this helper. Its IPN webhook
 * (`verifyIpn`, ./nowpayments.ts) rejects a callback outright when
 * `payment_id` is missing rather than falling back to anything (the M-12
 * fix), so there is no fallback on that rail to converge with — its poller
 * matches that stricter shape instead by declining to deliver rather than
 * inventing a key.
 */
export function gatewayLedgerTrxId(gatewayTrxId: string | null | undefined, orderCode: string): string {
  const fromGateway = (gatewayTrxId ?? "").trim();
  return fromGateway || orderCode;
}
