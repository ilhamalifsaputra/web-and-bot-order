/**
 * Shared catalog query. Catalog, Categories and the product-create page all
 * read the same `GET /api/catalog` payload, so they share one query key —
 * a product moved on one page shows its new category on the others without
 * a refetch, and category product counts can never disagree between pages.
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./client";

export interface CategoryRow {
  id: number;
  name: string;
  /** Frozen at creation — storefront `/c/:slug` links and the sitemap depend on it. */
  slug: string;
  emoji: string | null;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  checkoutFlow: "catalog" | "instant";
}

export interface ProductRow {
  id: number;
  name: string;
  isActive: boolean;
  isArchived: boolean;
  webImageUrl: string | null;
  createdAt: string;
  category: { id: number; name: string; emoji: string | null } | null;
  _count: { denominations: number };
}

export interface CatalogData {
  categories: CategoryRow[];
  products: ProductRow[];
}

export const CATALOG_QUERY_KEY = ["catalog"] as const;

export function useCatalog() {
  return useQuery<CatalogData>({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: async () => apiGet<CatalogData>("/api/catalog"),
  });
}

/** How many non-archived products sit in a category — the count both pages show. */
export function countProductsInCategory(products: ProductRow[], categoryId: number): number {
  return products.filter((p) => !p.isArchived && p.category?.id === categoryId).length;
}
