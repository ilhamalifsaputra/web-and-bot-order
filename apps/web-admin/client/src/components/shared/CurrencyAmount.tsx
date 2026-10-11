import { formatCurrencyDisplay } from "./CurrencyAmount.helpers";

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
          <span className="text-xs font-medium text-ink-soft w-12 shrink-0">{a.currency}</span>
          <span className="font-mono text-sm min-w-0 break-all">
            {formatCurrencyDisplay(a.value, a.currency)}
          </span>
        </div>
      ))}
    </div>
  );
}
