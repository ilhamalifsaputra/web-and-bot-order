/**
 * TSX port of apps/storefront/views/catalog.njk — breadcrumb-free category
 * header, pills to switch category (active one highlighted), product grid,
 * empty state. Markup/classes copied verbatim apart from the mechanical
 * Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md).
 */
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { CategoryPageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import ProductCard from "../components/shop/ProductCard";
import ErrorPage from "./ErrorPage";

export default function CategoryPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const { data: ctx } = useShopContext();
  const { data, error } = useQuery({
    queryKey: ["category", slug],
    queryFn: () => apiGet<CategoryPageData>(`/api/v1/pages/category/${slug}`),
    retry: false,
  });

  if (error) {
    if ((error as Error & { status?: number }).status === 404) return <ErrorPage />;
    return null;
  }
  if (!data) return null;

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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {products.map((p) => (
            <ProductCard key={p.slug} p={p} fx={fx} lowThreshold={low_threshold} />
          ))}
        </div>
      ) : (
        <div className="card card-pad text-center text-ink-faint py-14">{t("web.catalog_empty")}</div>
      )}
    </>
  );
}
