/**
 * TSX port of apps/storefront/views/search.njk — query echoed in the title,
 * product grid, empty state. Markup/classes copied verbatim apart from the
 * mechanical Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md).
 */
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { SearchPageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import ProductCard from "../components/shop/ProductCard";

export default function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";
  const { data: ctx } = useShopContext();
  const { data } = useQuery({
    queryKey: ["search", q],
    queryFn: () => apiGet<SearchPageData>(`/api/v1/pages/search?q=${encodeURIComponent(q)}`),
  });

  if (!data) return null;

  const { products, low_threshold } = data;
  const fx = ctx?.fx;

  return (
    <>
      <div className="mb-6">
        <h1 className="page-title">{t("web.search_results", { q: data.q })}</h1>
      </div>

      {products.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {products.map((p) => (
            <ProductCard key={p.slug} p={p} fx={fx} lowThreshold={low_threshold} />
          ))}
        </div>
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
