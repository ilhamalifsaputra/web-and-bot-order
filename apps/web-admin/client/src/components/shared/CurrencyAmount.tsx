/**
 * Pure display formatting only — the backend (packages/db/src/crud) already
 * did every Decimal-precision money computation; these values are final.
 * Mirrors packages/core/src/formatters.ts's formatIdr/formatPrice OUTPUT
 * SHAPE exactly, without re-doing any of their arithmetic.
 */
export function formatCurrencyDisplay(value: string, currency: "IDR" | "USDT" | "USD"): string {
  const n = Number(value);
  if (currency === "IDR") {
    const whole = Math.round(n);
    const grouped = Math.abs(whole).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return `${whole < 0 ? "-" : ""}Rp${grouped}`;
  }
  return `${n.toFixed(2)} ${currency}`;
}

export interface CurrencyAmount {
  currency: "IDR" | "USDT" | "USD";
  value: string;
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
