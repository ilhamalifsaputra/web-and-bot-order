/**
 * TSX port of `product_card(p, fx, low, lang)` in apps/storefront/views/_shop.njk
 * (design.md §4.2) — the grid card used by home/category/search. Links to the
 * product detail page.
 */
import { Link } from "react-router-dom";
import { Tag, Zap } from "lucide-react";
import { t } from "../../lib/i18n";
import Price from "./Price";
import Stars from "./Stars";
import StockBadge from "./StockBadge";

/** Client-side twin of the server's ProductCard shape (apps/storefront/src/cards.ts)
 * — the JSON a grid endpoint returns for one card. Decimals arrive as strings. */
export interface ProductCardData {
  slug: string;
  name: string;
  category_name: string;
  from_price: string;
  variant_count: number;
  image: string;
  available: number;
  rating: number | null;
  rating_count: number;
  bulk_discount: string | null;
  bulk_min_qty: number | null;
}

export interface ProductCardProps {
  p: ProductCardData;
  fx: string | null | undefined;
  lowThreshold: number;
}

export default function ProductCard({ p, fx, lowThreshold }: ProductCardProps) {
  const bulkPercent = p.bulk_discount ? Math.round(Number(p.bulk_discount)) : null;
  return (
    <Link
      to={`/p/${p.slug}`}
      className="group overflow-hidden rounded-2xl border border-line bg-card shadow-xs transition hover:shadow-md hover:border-pine-tint flex flex-col"
    >
      <div className="relative flex h-44 items-center justify-center bg-sand overflow-hidden shrink-0">
        {p.image ? (
          <img
            src={p.image}
            alt={p.name}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
          />
        ) : (
          <>
            <div className="absolute inset-0 bg-linear-to-br from-ink to-ink-soft"></div>
            <span className="relative z-10 text-2xl font-bold text-white/90 px-4 text-center line-clamp-2">
              {p.name}
            </span>
          </>
        )}

        {p.bulk_discount && (
          <span className="absolute top-3 left-3 inline-flex items-center rounded-full bg-rust/90 px-2.5 py-1 text-xs font-medium text-white shadow-xs backdrop-blur-sm">
            −{bulkPercent}%
          </span>
        )}
        <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-black/40 px-2.5 py-1 text-xs font-medium text-amber-300 backdrop-blur-sm">
          <Zap className="w-3 h-3" /> {t("web.badge_instant")}
        </span>
      </div>
      <div className="p-4 flex flex-col flex-1">
        <h3 className="font-semibold text-ink line-clamp-1">{p.name}</h3>
        <p className="text-sm text-ink-faint">
          {p.category_name}
          {p.variant_count > 1 && (
            <>
              {" "}
              <span className="text-ink-soft">·</span>{" "}
              <span className="text-pine">{t("web.group_options", { count: p.variant_count })}</span>
            </>
          )}
        </p>

        {p.rating_count > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-ink-soft mt-1">
            <Stars rating={p.rating ?? 0} /> <span>{String(Math.round((p.rating ?? 0) * 10) / 10)}</span>
            <span className="text-ink-faint">· {t("web.review_count", { count: p.rating_count })}</span>
          </div>
        )}

        <div className="mt-auto pt-3 flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm text-ink-soft inline-flex items-baseline gap-1">
            {t("web.from_price")}
            <Price value={p.from_price} fx={fx} size="text-sm" />
          </p>
          <StockBadge available={p.available} lowThreshold={lowThreshold} />
        </div>

        {p.bulk_discount && p.bulk_min_qty && (
          <div className="text-[0.7rem] text-grass-dark font-medium flex items-center gap-1 mt-2">
            <Tag className="w-3 h-3" />
            {t("web.bulk_hint", { qty: p.bulk_min_qty, percent: bulkPercent ?? 0 })}
          </div>
        )}
      </div>
    </Link>
  );
}
