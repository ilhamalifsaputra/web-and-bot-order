/**
 * Shared card-context shapers for the grid pages (home, category, search). A
 * storefront grid renders parent "group" cards (which drill into denominations
 * via /g/:id) plus plain "product" cards (/p/:id), both derived from the
 * CatalogEntry stream. Centralising the shaping keeps the three grids identical.
 */
import type { CatalogEntry } from "@app/db";
import { productImage } from "./images";

export type GroupCard = {
  id: number;
  name: string;
  emoji: string | null;
  from_price: string;
  count: number;
  image: string;
};

export type ProductCard = {
  id: number;
  name: string;
  category_name: string;
  price: string;
  image: string;
  available: number;
  rating: number | null;
  rating_count: number;
  bulk_discount: string | null;
  bulk_min_qty: number | null;
};

type StockMap = Record<number, { available: number }>;
type RatingMap = Map<number, { avg: number | null; count: number }>;
type BulkMap = Record<number, { minQuantity: number; discountPercent: string }>;

/** Split a CatalogEntry stream into the group + product card contexts a grid renders. */
export function shapeEntries(
  entries: CatalogEntry[],
  catName: Map<number, string>,
  stock: StockMap,
  ratings: RatingMap,
  bulk: BulkMap = {},
): { groups: GroupCard[]; products: ProductCard[] } {
  const groups: GroupCard[] = [];
  const products: ProductCard[] = [];
  for (const e of entries) {
    if (e.kind === "group") {
      const first = e.members[0]!; // members are price-asc → cheapest is "from"
      groups.push({
        id: e.group.id,
        name: e.group.name,
        emoji: e.group.emoji,
        from_price: first.price.toString(),
        count: e.members.length,
        image: e.group.webImageUrl ?? productImage(first, catName.get(first.categoryId) ?? ""),
      });
    } else {
      const p = e.product;
      const cn = catName.get(p.categoryId) ?? "";
      products.push({
        id: p.id,
        name: p.name,
        category_name: cn,
        price: p.price.toString(),
        image: productImage(p, cn),
        available: stock[p.id]?.available ?? 0,
        rating: ratings.get(p.id)?.avg ?? null,
        rating_count: ratings.get(p.id)?.count ?? 0,
        bulk_discount: bulk[p.id]?.discountPercent ?? null,
        bulk_min_qty: bulk[p.id]?.minQuantity ?? null,
      });
    }
  }
  return { groups, products };
}
