/**
 * TSX port of `stock_badge(count, low, lang)` in apps/storefront/views/_shop.njk
 * (design.md §4.3) — honest, real-time stock straight from the shared DB.
 */
import { t } from "../../lib/i18n";

export interface StockBadgeProps {
  available: number;
  lowThreshold: number;
}

export default function StockBadge({ available, lowThreshold }: StockBadgeProps) {
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
