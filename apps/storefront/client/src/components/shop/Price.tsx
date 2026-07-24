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
  /** "light" renders the figure/hint legibly on dark surfaces (e.g. the hero
   * product-preview cards) instead of the default text-pine, which is too
   * low-contrast there. Defaults to "default", preserving today's output
   * everywhere else Price is used. */
  tone?: "default" | "light";
}

export default function Price({ value, fx, size = "text-sm", tone = "default" }: PriceProps) {
  const hint = formatUsdt(value, fx);
  const figureColor = tone === "light" ? "text-white" : "text-pine";
  const hintColor = tone === "light" ? "text-white/70" : "text-ink-faint";
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className={`font-semibold ${figureColor} ${size}`}>{formatIdr(value)}</span>
      {hint && <span className={`${hintColor} text-xs`}>{hint}</span>}
    </span>
  );
}
