/**
 * Client-side money formatting — exact mirrors of the Nunjucks filters in
 * apps/storefront/src/plugins/views.ts (which wrap packages/core/formatters),
 * so React output is byte-identical to what the templates rendered. Amounts
 * arrive as strings from the JSON API (Decimal serialized via dstr()); plain
 * Number math is safe here because IDR amounts are far below 2^53 and the
 * derived-USDT rounding is a single step, same as core's Decimal.
 */

/** Half-up rounding away from zero (Decimal.ROUND_HALF_UP parity). */
function roundHalfUp(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * factor)) / factor;
}

/**
 * Rounding towards +Infinity (Decimal.ROUND_CEIL parity) — what
 * `usdtFromIdr` uses in core since M13 / P2-1. `Math.ceil`, not `Math.round`,
 * and NOT sign-symmetric: ceiling on a negative number rounds towards zero,
 * which is exactly what `Decimal.ROUND_CEIL` does too, so the mirror stays
 * faithful for the refund/adjustment figures that can be negative.
 *
 * The `toFixed(10)` re-parse absorbs the float error `value * factor`
 * introduces: 4.9375 × 100 is 493.75000000000006 in IEEE-754, and a bare
 * `Math.ceil` of that would give 4.94 by luck here but 2.79 → 2.80 elsewhere.
 * Rounding the product to 10 significant-ish places first lands it on the
 * decimal value core's `Decimal` would have had, before the ceiling is taken.
 */
function roundCeil(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.ceil(Number((value * factor).toFixed(10))) / factor;
}

/** Central IDR price: "Rp79.000". "—" for null/empty. Mirrors the `idr` filter. */
export function formatIdr(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  const whole = roundHalfUp(n, 0);
  const digits = Math.abs(whole).toFixed(0);
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${whole < 0 ? "-" : ""}Rp${grouped}`;
}

/**
 * Derived USDT info beside an IDR price: "≈ $4.94". Empty string when the fx
 * rate is missing or the amount is not worth a hint. Mirrors core's
 * `usdtFromIdr` (packages/core/src/formatters.ts) EXACTLY, and must keep doing
 * so: idr / rate rounded UP to the next 0.01, which is what the crypto rails
 * actually charge. A shopfront figure that disagreed with the charged total,
 * even by a cent, is a support ticket and a trust problem — this function has
 * no licence to round its own way.
 *
 * The `< 0.01` guard no longer fires on a small positive amount (ceiling puts
 * every one of those at 0.01 or above, where it used to floor them to 0.0 and
 * the templates hid the hint). It is kept for the cases it still catches: a
 * zero price, and a negative figure.
 */
export function formatUsdt(
  idrValue: string | number | null | undefined,
  rate: string | number | null | undefined,
): string {
  if (idrValue === null || idrValue === undefined || idrValue === "" || !rate) return "";
  const idr = Number(idrValue);
  const fx = Number(rate);
  if (Number.isNaN(idr) || Number.isNaN(fx) || fx <= 0) return "";
  const usdt = roundCeil(idr / fx, 2);
  if (usdt < 0.01) return "";
  return `≈ $${usdt.toFixed(2)}`;
}

function trimTrailingZeros(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/**
 * Native USDT amount for display: up to 4dp, half-up, trailing zeros
 * stripped, whole values with no decimal point at all — "0", "1", "1.5",
 * "12.34", "96.7", "123.4568". "—" for null/empty. Mirrors
 * packages/core/formatters.ts's formatUsdtAmount, byte-for-byte.
 */
export function formatUsdtAmount(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return trimTrailingZeros(roundHalfUp(n, 4).toFixed(4));
}

/** formatUsdtAmount with the " USDT" suffix, e.g. "12.34 USDT". "—" for null/empty. */
export function formatNativeUsdt(value: string | number | null | undefined): string {
  const amount = formatUsdtAmount(value);
  return amount === "—" ? amount : `${amount} USDT`;
}

/** "$1,250.00" — 2dp, comma thousands. Mirrors core's formatUsdDisplay
 * (packages/core/src/formatters.ts) exactly, so a display-currency figure
 * over $999 groups the same way the bot/core would render it. Plain-number
 * based (not Decimal) like the rest of this file — see the file header. */
function formatUsdGrouped(amount: number): string {
  const fixed = Math.abs(amount).toFixed(2);
  const [whole, cents] = fixed.split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount < 0 ? "-" : ""}$${grouped}.${cents}`;
}

/**
 * The PRIMARY display string for a canonical IDR amount, in the viewer's
 * display-currency preference — mirrors core's convertIdrToDisplay /
 * formatDisplayMoney (packages/core/src/formatters.ts) exactly:
 *  - `"IDR"` or `null` (no preference chosen yet — today's default): the same
 *    "Rp…" string formatIdr always produced. `null` is intentionally treated
 *    identically to `"IDR"` here — the null-only "≈ $" hint is Price.tsx's
 *    own concern, layered on top of this helper's primary string, not this
 *    function's.
 *  - `"USD"`: the ceil-to-0.01 figure formatUsdt already computes (reused,
 *    not reimplemented — same rounding, so a display price never disagrees
 *    with what formatUsdt's "≈ $" hint would have shown), thousands-grouped
 *    like core's formatUsdDisplay, no "≈ " prefix (this IS the primary
 *    figure, not a hint).
 *  - `"USD"` with a missing/invalid rate: falls back to the explicit "Rp…"
 *    string — never a bare number, never a "$" figure invented without a
 *    rate. Same rule the bot follows (bot: currency.rate_unavailable). The
 *    caller's `currency` state is NOT silently reset to IDR by this — it's
 *    purely what gets rendered for this one value.
 *
 * Never applies to an order's own settlement currency (order.currency) —
 * that's what {@link formatOrderAmount} is for, applied to an
 * already-canonical IDR catalog/cart/preview price only.
 */
export function formatPriceFor(
  idrValue: string | number | null | undefined,
  currency: "USD" | "IDR" | null | undefined,
  fx: string | number | null | undefined,
): string {
  if (currency !== "USD") return formatIdr(idrValue);
  if (idrValue === null || idrValue === undefined || idrValue === "") return formatIdr(idrValue);
  const idr = Number(idrValue);
  const rate = Number(fx);
  if (!fx || Number.isNaN(idr) || Number.isNaN(rate) || rate <= 0) return formatIdr(idrValue);
  const usdt = roundCeil(idr / rate, 2);
  return formatUsdGrouped(usdt);
}

/**
 * An order's OWN settlement-currency amount — `order.total`,
 * `order.qris_admin_fee`, a linked ticket order's `total`, etc. (see
 * api/types.ts's `PayData`/`TicketOrderSummary`). `orderCurrency` is the
 * order's stored rail currency ("IDR" | "USDT"), NEVER the viewer's
 * display-currency preference — do not run this through
 * {@link formatPriceFor}'s conversion, that would double-convert an amount
 * that is already denominated in whatever the order actually settled in.
 *
 * Task 5 bug fix: PayPage.tsx and TicketOrderSummaryCard.tsx used to call
 * formatIdr on these fields unconditionally, which mis-renders a USDT
 * order's total as if it were a Rupiah figure.
 */
export function formatOrderAmount(
  value: string | number | null | undefined,
  orderCurrency: string | null | undefined,
): string {
  return orderCurrency === "USDT" ? formatNativeUsdt(value) : formatIdr(value);
}
