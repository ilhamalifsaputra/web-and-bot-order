function trimTrailingZeros(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/**
 * Native USDT amount: up to 4dp, half-up, trailing zeros stripped, whole
 * values with no decimal point at all — "0", "1", "1.5", "12.34", "96.7",
 * "123.4568". Mirrors packages/core/formatters.ts's formatUsdtAmount,
 * byte-for-byte.
 */
export function formatUsdtAmount(value: string | number): string {
  const n = Number(value);
  const factor = 10 ** 4;
  const sign = n < 0 ? -1 : 1;
  const rounded = (sign * Math.round(Math.abs(n) * factor)) / factor;
  return trimTrailingZeros(rounded.toFixed(4));
}

/**
 * Pure display formatting only — the backend (packages/db/src/crud) already
 * did every Decimal-precision money computation; these values are final.
 * Mirrors packages/core/src/formatters.ts's formatIdr/formatPrice/formatUsdt
 * OUTPUT SHAPE exactly, without re-doing any of their arithmetic.
 */
export function formatCurrencyDisplay(value: string, currency: "IDR" | "USDT" | "USD"): string {
  const n = Number(value);
  if (currency === "IDR") {
    const whole = Math.round(n);
    const grouped = Math.abs(whole).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return `${whole < 0 ? "-" : ""}Rp${grouped}`;
  }
  if (currency === "USDT") return `${formatUsdtAmount(n)} ${currency}`;
  return `${n.toFixed(2)} ${currency}`;
}

export interface CurrencyAmount {
  currency: "IDR" | "USDT" | "USD";
  value: string;
}

/**
 * Same values as `formatCurrencyDisplay`, split into an emphasized amount and
 * a de-emphasized currency suffix — for table cells that want to style the
 * two differently (e.g. Orders table's Total column) without re-deriving the
 * formatting logic locally. IDR has no suffix (the "Rp" prefix already reads
 * as the currency), matching `formatCurrencyDisplay`'s own IDR output shape.
 */
export function formatCurrencyParts(
  value: string,
  currency: "IDR" | "USDT" | "USD",
): { amount: string; suffix: string } {
  if (currency === "IDR") return { amount: formatCurrencyDisplay(value, currency), suffix: "" };
  if (currency === "USDT") return { amount: formatUsdtAmount(value), suffix: "USDT" };
  return { amount: Number(value).toFixed(2), suffix: "USD" };
}

/**
 * Renders each currency on its own line — this component exists specifically
 * so a card can never render "Rp137 + 20.25 USDT" as one joined string (the
 * bug this whole dashboard redesign fixes).
 */
export function CurrencyStack({ amounts }: { amounts: CurrencyAmount[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      {amounts.map((a) => (
        <div key={a.currency} className="flex items-baseline gap-1.5">
          <span className="text-xs font-medium text-ink-soft w-12">{a.currency}</span>
          <span className="font-mono text-sm">{formatCurrencyDisplay(a.value, a.currency)}</span>
        </div>
      ))}
    </div>
  );
}
