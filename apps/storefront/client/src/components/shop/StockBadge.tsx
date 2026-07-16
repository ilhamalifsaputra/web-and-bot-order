/**
 * TSX port of `stock_badge(count, low, lang)` in apps/storefront/views/_shop.njk
 * (design.md §4.3) — honest, real-time stock straight from the shared DB.
 */
import { t } from "../../lib/i18n";

export interface StockBadgeProps {
  available: number;
  lowThreshold: number;
  /** True when every denomination behind this card is a non-`auto` delivery
   * type (manual/manual_with_info) — those never carry a real stock count
   * and are always purchasable (mirrors ProductPage's `purchasable()` rule,
   * STO-001), so the badge should never read them as "out of stock". */
  allNonAuto?: boolean;
}

export default function StockBadge({ available, lowThreshold, allNonAuto }: StockBadgeProps) {
  if (allNonAuto) {
    return (
      <span className="rounded-full bg-grass-tint px-2.5 py-1 text-xs font-medium text-grass-dark">
        {t("web.stock_available")}
      </span>
    );
  }
  if (available > lowThreshold) {
    return (
      <span className="rounded-full bg-grass-tint px-2.5 py-1 text-xs font-medium text-grass-dark">
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
