/**
 * TSX port of `price(idr_value, fx, size)` in apps/storefront/views/_shop.njk —
 * the central price figure (design.md §4.4 + §8b). Task 5 (multi-currency
 * display): the figure now follows the viewer's display-currency preference
 * (`ShopContext.currency`, Task 4) —
 *  - `"USD"`: primary `$` figure (formatPriceFor), no "≈" hint.
 *  - `"IDR"`: primary `Rp` figure, no hint either (IDR user → Rp only,
 *    decided design — the hint was only ever there to help an undecided
 *    visitor picture the USD price).
 *  - `null` (no preference chosen yet): EXACTLY today's behavior — Rp primary
 *    + the derived "≈ $" hint whenever formatUsdt() has something to show
 *    (fx missing/invalid or the amount rounding under $0.01 both hide it).
 *
 * Reads `currency` off the shared `["context"]` query (useShopContext, same
 * query Layout.tsx already runs) rather than taking it as a prop — TanStack
 * Query dedupes the fetch, so every one of the many existing <Price/> call
 * sites (product cards, cart lines, checkout summaries, …) gets the correct
 * behavior with no prop-drilling and no call-site changes.
 */
import { useShopContext } from "../../lib/useShopContext";
import { formatPriceFor, formatUsdt } from "../../lib/format";

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
  const { data: ctx } = useShopContext();
  const currency = ctx?.currency ?? null;
  const figure = formatPriceFor(value, currency, fx);
  // The "≈ $" hint only ever applies to the undecided (null) default — once
  // the viewer has picked a currency, that pick IS the one figure shown.
  const hint = currency === null ? formatUsdt(value, fx) : "";
  const figureColor = tone === "light" ? "text-white" : "text-pine";
  const hintColor = tone === "light" ? "text-white/70" : "text-ink-faint";
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className={`font-semibold ${figureColor} ${size}`}>{figure}</span>
      {hint && <span className={`${hintColor} text-xs`}>{hint}</span>}
    </span>
  );
}
