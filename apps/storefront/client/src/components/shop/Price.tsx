/**
 * TSX port of `price(idr_value, fx, size)` in apps/storefront/views/_shop.njk —
 * the central IDR figure with the derived USDT hint beside it (design.md §4.4 +
 * §8b). The hint is only rendered when formatUsdt() actually returns something
 * (fx missing/invalid or the amount rounds under $0.01 both hide it).
 */
import { formatIdr, formatUsdt } from "../../lib/format";

export interface PriceProps {
  value: string | number | null | undefined;
  fx: string | number | null | undefined;
  size?: string;
}

export default function Price({ value, fx, size = "text-sm" }: PriceProps) {
  const hint = formatUsdt(value, fx);
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className={`font-semibold text-pine ${size}`}>{formatIdr(value)}</span>
      {hint && <span className="text-ink-faint text-xs">{hint}</span>}
    </span>
  );
}
