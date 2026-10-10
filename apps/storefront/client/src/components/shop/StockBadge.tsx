/**
 * TSX port of `stock_badge(count, low, lang)` in apps/storefront/views/_shop.njk
 * (design.md §4.3) — honest, real-time stock straight from the shared DB.
 */
import { t } from "../../lib/i18n";

export interface StockBadgeProps {
  available: number;
  lowThreshold: number;
  /** True when the server says there is no real stock count to show: a
   * provider or manual plan, or a product whose plans are not all local
   * inventory. Those are purchasable regardless of `available` (STO-001), so
   * the badge never reads them as "out of stock" or "N left". */
  allNonAuto?: boolean;
}

export default function StockBadge({ available, lowThreshold, allNonAuto }: StockBadgeProps) {
  if (allNonAuto) {
    return (
      // text-grass-dark-aa (#157e3b): shared grass-dark (#15803d) measures
      // 4.49:1 on grass-tint, 0.01 short of WCAG AA. This one-off nudge is a
      // §26.2 extension token scoped to this badge's foreground only — the
      // shared --color-grass-dark (StatusBadge, ProductCard, …) is untouched.
      // See src/styles/tokens.extensions.css + docs/archive/implementation/extensions.md.
      <span className="rounded-full bg-grass-tint px-2.5 py-1 text-xs font-medium text-grass-dark-aa">
        {t("web.stock_available")}
      </span>
    );
  }
  if (available > lowThreshold) {
    return (
      <span className="rounded-full bg-grass-tint px-2.5 py-1 text-xs font-medium text-grass-dark-aa">
        {t("web.stock_available")}
      </span>
    );
  }
  if (available > 0) {
    return (
      <span className="rounded-full bg-amberx-tint px-2.5 py-1 text-xs font-medium text-amberx">
        {t("web.stock_left", { count: available })}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-rust-tint px-2.5 py-1 text-xs font-medium text-rust-dark">
      {t("web.stock_out")}
    </span>
  );
}
