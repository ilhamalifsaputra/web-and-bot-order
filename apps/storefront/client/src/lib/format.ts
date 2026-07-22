/**
 * Client-side money formatting — exact mirrors of the Nunjucks filters in
 * apps/storefront/src/plugins/views.ts (which wrap packages/core/formatters),
 * so React output is byte-identical to what the templates rendered. Amounts
 * arrive as strings from the JSON API (Decimal serialized via dstr()); plain
 * Number math is safe here because IDR amounts are far below 2^53 and the
 * derived-USDT rounding is a single half-up step, same as core's Decimal.
 */

/** Half-up rounding away from zero (Decimal.ROUND_HALF_UP parity). */
function roundHalfUp(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * factor)) / factor;
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
 * Derived USDT info beside an IDR price: "≈ $4.90". Empty string when the fx
 * rate is missing or the amount rounds below $0.01 — templates hid the hint
 * in both cases. Mirrors the `usdt` filter: idr / rate rounded half-up to the
 * nearest 0.1 (what Binance actually charges), then displayed with 2dp.
 */
export function formatUsdt(
  idrValue: string | number | null | undefined,
  rate: string | number | null | undefined,
): string {
  if (idrValue === null || idrValue === undefined || idrValue === "" || !rate) return "";
  const idr = Number(idrValue);
  const fx = Number(rate);
  if (Number.isNaN(idr) || Number.isNaN(fx) || fx <= 0) return "";
  const usdt = roundHalfUp(idr / fx, 1);
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
