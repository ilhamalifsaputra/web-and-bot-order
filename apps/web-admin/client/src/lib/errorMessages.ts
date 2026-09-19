/**
 * The web-admin SPA is deliberately English-only (no i18n system) — API
 * errors from a `ValidationError` (packages/core/src/errors.ts) surface as a
 * raw `error.some_key` string in `{ error: e.message }` JSON responses
 * (e.g. apps/web-admin/src/routes/api/payments.ts, .../orders.ts's `/fulfill`
 * route). Routing those through `t()` isn't the fix here since this app has
 * none — instead this is a small client-side lookup so admins see a readable
 * sentence instead of the literal key (audit-per-sku-delivery-flows-2026-07-13.md
 * findings #12/#13). Only known-to-occur keys need an entry: `describeError`
 * falls back to the raw string for anything not listed, so it's always safe
 * to wrap any `e.message` coming from one of these API error responses.
 */
const KNOWN_ERROR_MESSAGES: Record<string, string> = {
  "error.cannot_deliver_out_of_stock":
    "This item has no stock reserved and can't be delivered automatically — refund or credit the buyer instead.",
  "error.order_not_processing":
    "This order is no longer awaiting fulfilment — it may have already been processed.",
  "error.order_paid_needs_credit":
    "This order was already paid — use \"Credit to Balance\" instead of Reject/Cancel, so the payment isn't lost.",
  "error.illegal_admin_task_status_transition":
    "This task's status just changed — refresh the page and try again.",
  "error.admin_task_assignee_not_found":
    "That admin account could not be found.",
  "error.admin_task_assignee_not_admin":
    "That user isn't an admin and can't be assigned tasks.",
  "error.rate_limited":
    "You're doing that too quickly — wait a minute and try again.",
  // Account/stock replacement (M20's per-unit actions on the Items table).
  // Every one of these comes from the service's own guards
  // (packages/db/src/crud/stockReplacement.ts), so the wording explains what
  // an admin should do instead rather than restating the key.
  "error.stock_replacement_order_not_delivered":
    "Nothing has been handed to the buyer for this order yet, so there's no account to replace — deliver or cancel it instead.",
  "error.stock_replacement_item_not_sold":
    "This unit holds no delivered stock account to replace. Hand-fulfilled orders and units already refunded can't be replaced.",
  "error.stock_replacement_already_open":
    "This unit already has an open replacement request — resolve that one (retry it, or refund the unit) instead of opening a second.",
  "error.stock_replacement_not_awaiting_stock":
    "This request is no longer waiting on stock — it may have just been resolved by someone else. Refresh the page.",
  "error.stock_replacement_not_found":
    "That replacement request could not be found.",
  "error.stock_replacement_nothing_to_refund":
    "This unit works out to nothing refundable (it was fully discounted), so there's no payout to make.",
  "error.illegal_stock_replacement_status_transition":
    "This replacement request's status just changed — refresh the page and try again.",
  // Reachable from the "Refund instead" fallback, which pays out through the
  // shared Refund path (crud/refunds.ts's executeRefund).
  "error.refund_exceeds_refundable_amount":
    "This order has less left to refund than this unit is worth — most of it was paid from wallet balance, which this payout can't return. Refund it from the order's own refund flow instead.",
  "error.refund_exceeds_item_subtotal":
    "This unit has already been refunded as much as it was paid for.",
  "error.refund_execution_proof_required":
    "A manual transfer needs proof of the transfer before it can be recorded.",
  // Returning an overpayment (task F2). Both come from
  // `creditOverpaymentToBalance`'s own guards, and the first one is what a
  // double-clicked button earns — so it has to read as reassurance rather than
  // as a failure the admin needs to retry.
  "error.overpayment_already_credited":
    "This overpayment has already been credited to the buyer's balance, so nothing was handed over a second time. Refresh the page to see the current state.",
  "error.overpayment_none_recorded":
    "No payment provider recorded the buyer overpaying on this order, so there is no excess to return. If they really did pay too much, the provider's own record is what needs checking first.",
  "error.order_not_found":
    "That order could not be found — it may have just been removed. Refresh the page.",
};

/** Looks up a known `ValidationError` key and returns a readable English
 * message; falls back to the raw string for anything unrecognized. */
export function describeError(key: string): string {
  return KNOWN_ERROR_MESSAGES[key] ?? key;
}
