/**
 * The web-admin SPA is deliberately English-only (no i18n system) — API
 * errors from a `ValidationError` (packages/core/src/errors.ts) surface as a
 * raw `error.some_key` string in the `{ error, error_args? }` JSON responses the
 * routes send through `errorBody` (@app/core/errorBody; e.g.
 * apps/web-admin/src/routes/api/payments.ts, .../orders.ts's `/fulfill` route).
 * Routing those through `t()` isn't the fix here since this app has none —
 * instead this is a small client-side lookup so admins see a readable sentence
 * instead of the literal key (audit-per-sku-delivery-flows-2026-07-13.md
 * findings #12/#13). Only known-to-occur keys need an entry: `describeError`
 * falls back to the raw string for anything not listed, so it's always safe
 * to pass it any failure one of these API calls rejected with.
 *
 * ## The figures (P2)
 *
 * A sentence here may name a `{placeholder}`, filled from the error's
 * `errorArgs` — the values the service attached to the `ValidationError` and the
 * route put on the wire. Before P2 those were dropped on this surface, so the
 * copy below had to be written as if the number did not exist: "this item has no
 * stock", "this order has less left to refund". An admin holding several
 * underpaid orders open was told a refusal happened and not which order or
 * product caused it.
 *
 * Two rules keep that honest:
 *
 * - **Add a placeholder only where the throw site always supplies it.** A
 *   template whose figure is missing is left INTACT, braces and all, exactly as
 *   `t()` behaves everywhere else in this repo — a half-substituted sentence is
 *   worse than an unfilled one. So `{product}` is here because
 *   `error.cannot_deliver_out_of_stock` has a single throw site that always
 *   passes it (crud/orders.ts), not because the storefront copy happens to name
 *   one.
 * - **A key with no entry still shows its figures**, appended as
 *   `key (name: value, …)`. The settlement and ledger refusals are the live case:
 *   copy rich in `{grossAmount}`/`{netAmount}`, no hand-written admin sentence,
 *   and an admin who needs to know which of three numbers they mistyped. That is
 *   the same information `humanizeValidationError` (apps/web-admin/src/flash.ts)
 *   has always given the server-rendered flash path.
 */
const KNOWN_ERROR_MESSAGES: Record<string, string> = {
  // `{product}` comes from crud/orders.ts's only throw site, which always passes
  // the product's name. Naming it matters most exactly when this fires — a bulk
  // deliver over a mixed cart, where "this item" identifies nothing.
  "error.cannot_deliver_out_of_stock":
    "{product} has no stock reserved and can't be delivered automatically — refund or credit the buyer instead.",
  "error.order_not_processing":
    "This order is no longer awaiting fulfilment — it may have already been processed.",
  "error.order_paid_needs_credit":
    "This order was already paid — use \"Credit to Balance\" instead of Reject/Cancel, so the payment isn't lost.",
  "error.already_credited":
    "This order's payment has already been credited to the buyer's balance, so nothing was handed over a second time. Refresh the page to see the current state.",
  "error.order_already_refunded":
    "This cancelled order has already been refunded, so its payment can't also be credited to balance. Refresh the page to see the current state.",
  "error.order_never_paid":
    "This cancelled order was never paid, so there's nothing to credit to the buyer's balance. Refresh the page to see the current state.",
  "error.transfer_already_used":
    "This transfer has already been matched, credited, or dismissed, or belongs to another order, so it can't be credited here. Refresh the page to see the current state.",
  // `{paymentCurrency}`/`{orderCurrency}` from crud/payments.ts and
  // creditOrderToBalance (a Binance transfer is always USDT).
  "error.payment_currency_mismatch":
    "This payment's currency ({paymentCurrency}) does not match the order's currency ({orderCurrency}), so it can't be applied to this order.",
  // Manual match / dismiss on every gateway (packages/db/src/crud/manualMatch.ts).
  // Copy matches packages/core/locales/en.json; `{received}`/`{required}`/
  // `{currency}` are always passed by the single amount-short throw site.
  "error.tx_not_found":
    "No payment with that reference was found in the payment ledger.",
  "error.tx_not_unmatched":
    "This payment is no longer unmatched. It may already have been matched or dismissed, so refresh the list.",
  "error.tx_reference_ambiguous":
    "This reference exists on more than one payment gateway. Choose the gateway and try again.",
  "error.order_not_pending":
    "This order is no longer waiting for payment, so a transfer can't be matched to it.",
  "error.payment_method_mismatch":
    "This order is not set to be paid through this payment's gateway.",
  "error.manual_match_amount_unknown":
    "This payment has no recorded amount, so it cannot be matched to an order. Check the gateway's dashboard and resolve the order directly.",
  "error.manual_match_amount_short":
    "This payment ({received} {currency}) is less than the order needs ({required} {currency}). Use the underpaid flow for this order instead of a manual match.",
  "error.manual_match_nowpayments_unverifiable":
    "A NOWPayments amount is recorded in the coin the buyer paid with, so it cannot be checked against the order total. Check the payment in the NOWPayments dashboard and resolve the order directly.",
  "error.illegal_admin_task_status_transition":
    "This task's status just changed — refresh the page and try again.",
  "error.admin_task_assignee_not_found":
    "That admin account could not be found.",
  "error.admin_task_assignee_not_admin":
    "That user isn't an admin and can't be assigned tasks.",
  "error.denomination_has_stock_history":
    "This item has stock history and cannot be deleted; deactivate it instead.",
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
  // `{existingId}` from crud/stockReplacement.ts, which always passes the open
  // request's id. Without it the sentence sends an admin looking for a request it
  // refuses to name.
  "error.stock_replacement_already_open":
    "This unit already has an open replacement request (#{existingId}) — resolve that one (retry it, or refund the unit) instead of opening a second.",
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
  // `{refundable}`/`{currency}` from crud/refunds.ts, which always passes all
  // four figures it computes. The number is the decision: whether to refund the
  // smaller amount here or go to the order's own refund flow depends on it.
  "error.refund_exceeds_refundable_amount":
    "This order has only {refundable} {currency} left to refund, less than this unit is worth — most of it was paid from wallet balance, which this payout can't return. Refund it from the order's own refund flow instead.",
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

/** What a failure with no message of its own earns, when the caller named no
 * fallback either. Reached by a rejected non-Error — a bug rather than a refusal,
 * so it apologises instead of guessing. */
const GENERIC_MESSAGE = "Something went wrong. Please try again.";

/** The key a failure carries: the string itself when a call site still passes
 * `e.message`, otherwise an Error's own message. */
function keyOf(err: unknown): string | null {
  if (typeof err === "string") return err === "" ? null : err;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message !== "" ? message : null;
}

/** A failure's figures, accepted only as a flat map of strings — the same
 * narrowing `api/client.ts` applies to the response body, repeated here because
 * this helper is also handed react-query errors and bare `catch (e: unknown)`
 * values it cannot vouch for. */
function argsOf(err: unknown): Record<string, string> {
  const raw = (err as { errorArgs?: unknown } | null | undefined)?.errorArgs;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** Fill `{name}` tokens, or leave the template alone if any of them has no value.
 * All-or-nothing on purpose: it is what `t()` (packages/core/src/i18n.ts) does, so
 * the bot, the storefront and this panel cannot disagree about what a
 * half-answerable message looks like. */
function fill(template: string, args: Record<string, string>): string {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (token, name: string) => {
    if (Object.prototype.hasOwnProperty.call(args, name)) return args[name]!;
    missing = true;
    return token;
  });
  return missing ? template : out;
}

/**
 * Render a failed API call as a sentence for an admin.
 *
 * Takes the FAILURE, not a message string, because the wording and the figures it
 * quotes arrive separately: `api/client.ts` throws an `ApiError` whose `message`
 * is the server's i18n key and whose `errorArgs` are the values its copy names. A
 * call site that passes `e.message` has already thrown the figures away — it
 * still works, and still renders exactly what it used to, but it cannot show a
 * number.
 *
 * A plain string is accepted for the same reason: this must stay safe to wrap
 * around anything, including a hand-written "Failed to load" that is not a key at
 * all.
 *
 * @param fallback what to say when `err` carries no message — replaces the
 *   `e instanceof Error ? e.message : "Failed to …"` ternary call sites used to
 *   spell out by hand.
 */
export function describeError(err: unknown, fallback?: string): string {
  const key = keyOf(err);
  if (key === null) return fallback ?? GENERIC_MESSAGE;

  const args = argsOf(err);
  const known = KNOWN_ERROR_MESSAGES[key];
  if (known) return fill(known, args);

  // No hand-written copy for this key. Show it as before, plus whatever figures
  // came with it — an admin reading `error.settlement_amounts_inconsistent` needs
  // the three amounts far more than they need the key.
  const entries = Object.entries(args);
  if (entries.length === 0) return key;
  return `${key} (${entries.map(([name, value]) => `${name}: ${value}`).join(", ")})`;
}
