/**
 * TSX port of apps/storefront/views/search.njk — query echoed in the title,
 * product grid, empty state. Markup/classes copied verbatim apart from the
 * mechanical Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md).
 */
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { SORT_KEYS, type SearchPageData, type SortKey } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import ProductCard from "../components/shop/ProductCard";
import ProductCardSkeleton from "../components/shop/ProductCardSkeleton";
import Skeleton from "../components/shop/Skeleton";
import SortSelect from "../components/shop/SortSelect";

const SKELETON_CARDS = Array.from({ length: 8 }, (_, i) => i);

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const rawSort = params.get("sort");
  const sort: SortKey = SORT_KEYS.includes(rawSort as SortKey) ? (rawSort as SortKey) : "default";
  const { data: ctx } = useShopContext();
  const { data } = useQuery({
    queryKey: ["search", q, sort],
    queryFn: () => apiGet<SearchPageData>(`/api/v1/pages/search?q=${encodeURIComponent(q)}&sort=${sort}`),
  });

  // STO-006/performance.md: same rationale as CategoryPage/AccountPage — show
  // a skeleton shaped like the loaded layout instead of a blank page.
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <div className="mb-6">
          <Skeleton className="h-8 w-56" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {SKELETON_CARDS.map((i) => (
            <ProductCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  const { products, low_threshold } = data;
  const fx = ctx?.fx;

  return (
    <>
      <div className="mb-6">
        <h1 className="page-title">{t("web.search_results", { q: data.q })}</h1>
      </div>

      {products.length > 0 ? (
        <>
          {/* STO-007: cheapest/newest/rating sort — only worth showing once
              there's more than one result to reorder. */}
          {products.length > 1 && (
            <div className="flex justify-end mb-4">
              <SortSelect
                value={sort}
                onChange={(next) =>
                  setParams(next === "default" ? { q } : { q, sort: next })
                }
              />
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {products.map((p) => (
              <ProductCard key={p.slug} p={p} fx={fx} lowThreshold={low_threshold} />
            ))}
          </div>
        </>
      ) : (
        <div className="card card-pad text-center py-14">
          <div className="text-ink-faint">{t("web.search_empty")}</div>
          <Link to="/" className="btn btn-soft mt-4">
            {t("web.back_home")}
          </Link>
        </div>
      )}
    </>
  );
}
