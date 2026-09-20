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
