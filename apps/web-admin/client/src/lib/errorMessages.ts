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
};

/** Looks up a known `ValidationError` key and returns a readable English
 * message; falls back to the raw string for anything unrecognized. */
export function describeError(key: string): string {
  return KNOWN_ERROR_MESSAGES[key] ?? key;
}
