/**
 * TSX port of apps/storefront/views/catalog.njk — breadcrumb-free category
 * header, pills to switch category (active one highlighted), product grid,
 * empty state. Markup/classes copied verbatim apart from the mechanical
 * Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md).
 */
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { SORT_KEYS, type CategoryPageData, type SortKey } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import ProductCard from "../components/shop/ProductCard";
import ProductCardSkeleton from "../components/shop/ProductCardSkeleton";
import Skeleton from "../components/shop/Skeleton";
import SortSelect from "../components/shop/SortSelect";
import ErrorPage from "./ErrorPage";

const SKELETON_CARDS = Array.from({ length: 8 }, (_, i) => i);

export default function CategoryPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const { data: ctx } = useShopContext();
  const [params, setParams] = useSearchParams();
  const rawSort = params.get("sort");
  const sort: SortKey = SORT_KEYS.includes(rawSort as SortKey) ? (rawSort as SortKey) : "default";
  const { data, error } = useQuery({
    queryKey: ["category", slug, sort],
    queryFn: () => apiGet<CategoryPageData>(`/api/v1/pages/category/${slug}?sort=${sort}`),
    retry: false,
  });

  if (error) {
    if ((error as Error & { status?: number }).status === 404) return <ErrorPage />;
    return null;
  }
  // STO-006/performance.md: rendering nothing while the initial query is
  // pending reads as a blank/broken page on a slow connection — show a
  // skeleton shaped like the loaded layout instead (see AccountPage).
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <div className="mb-6">
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 mb-6">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-24 shrink-0 rounded-full" />
          ))}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {SKELETON_CARDS.map((i) => (
            <ProductCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  const { category, categories, products, low_threshold } = data;
  const fx = ctx?.fx;

  return (
    <>
      <div className="mb-6">
        <h1 className="page-title">
          {category.emoji ? `${category.emoji} ` : ""}
          {category.name}
        </h1>
      </div>

      {/* Pills for switching category */}
      <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 mb-6">
        {categories.map((c) => (
          <Link
            key={c.slug}
            to={`/c/${c.slug}`}
            className={`chip whitespace-nowrap px-3.5! py-1.5! transition-colors ${
              c.id === category.id ? "bg-pine text-white" : "bg-sand text-ink-soft hover:bg-pine-tint hover:text-pine-dark"
            }`}
          >
            {c.emoji ? `${c.emoji} ` : ""}
            {c.name}
          </Link>
        ))}
      </div>

      {products.length > 0 ? (
        <>
          {/* STO-007: cheapest/newest/rating sort — only worth showing once
              there's more than one product to reorder. */}
          {products.length > 1 && (
            <div className="flex justify-end mb-4">
              <SortSelect value={sort} onChange={(next) => setParams(next === "default" ? {} : { sort: next })} />
            </div>
          )}
          {/* STO-018: same fix as the homepage's "Latest products" grid — a
              single product left two-thirds of the row empty. */}
          <div className={`grid gap-4 ${products.length === 1 ? "max-w-xs" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"}`}>
            {products.map((p) => (
              <ProductCard key={p.slug} p={p} fx={fx} lowThreshold={low_threshold} />
            ))}
          </div>
        </>
      ) : (
        <div className="card card-pad text-center text-ink-faint py-14">{t("web.catalog_empty")}</div>
      )}
    </>
  );
}
