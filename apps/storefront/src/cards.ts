/**
 * Shared card-context shaper for the grid pages (home, category, search). In the
 * 3-tier catalog a grid renders ONE kind of card: a Product (mid-tier) card that
 * links to the product detail page `/p/:slug`. Denominations (the SKUs with a
 * price/stock) are NEVER shown on a grid — they are chosen only inside product
 * detail. The card's headline price is the product's "starting price" = its
 * cheapest active denomination. Centralising the shaping keeps the three grids
 * identical.
 */
import type { CatalogProduct } from "@app/db";
import { Decimal } from "@app/core/money";
import { productImage } from "./images";

export type ProductCard = {
  slug: string;
  name: string;
  category_name: string;
  /** Cheapest active denomination price (Decimal as string) — "starting from". */
  from_price: string;
  /** Number of denominations (plans) the product offers. */
  variant_count: number;
  image: string;
  /** Available stock across all denominations of this product. */
  available: number;
  rating: number | null;
  rating_count: number;
  bulk_discount: string | null;
  bulk_min_qty: number | null;
  /** True when every active denomination is a non-`auto` delivery type
   * (manual/manual_with_info), so this product never carries a real stock
   * count and is always purchasable — mirrors the product page's own
   * `purchasable()` rule (STO-001). The card's stock badge should skip its
   * red "out of stock" state in that case rather than reading `available`. */
  all_non_auto: boolean;
};

/** Available stock keyed by denomination id. */
type StockMap = Record<number, { available: number }>;
/** Rating summaries keyed by denomination id (`productId` column = SKU). */
type RatingMap = Map<number, { avg: number | null; count: number }>;
/** Active bulk-pricing rules keyed by denomination id. */
type BulkMap = Record<number, { minQuantity: number; discountPercent: string }>;

/**
 * Shape a `CatalogProduct[]` (Product + its active denominations, price asc)
 * into product cards. Stock/rating/bulk maps are keyed by denomination id, so
 * each product aggregates across its denominations: stock = sum, rating =
 * count-weighted average across every denomination's summary (a review is
 * left against the specific plan bought — picking only the lead/cheapest
 * plan would silently drop every review left on the others), bulk badge =
 * the best discount found.
 */
export function shapeProducts(
  products: CatalogProduct[],
  stock: StockMap,
  ratings: RatingMap,
  bulk: BulkMap = {},
): ProductCard[] {
  const cards: ProductCard[] = [];
  for (const p of products) {
    const denoms = p.denominations; // active, price-asc (cheapest first)
    if (denoms.length === 0) continue; // listCatalogProducts already filters these out
    const lead = denoms[0]!; // cheapest → the "starting price"
    const fromPrice = denoms.reduce(
      (min, d) => Decimal.min(min, new Decimal(d.price)),
      new Decimal(lead.price),
    );
    const available = denoms.reduce((sum, d) => sum + (stock[d.id]?.available ?? 0), 0);
    // Best (largest) active bulk discount across this product's denominations.
    let bulkDiscount: string | null = null;
    let bulkMinQty: number | null = null;
    for (const d of denoms) {
      const rule = bulk[d.id];
      if (rule && (bulkDiscount === null || new Decimal(rule.discountPercent).greaterThan(bulkDiscount))) {
        bulkDiscount = rule.discountPercent;
        bulkMinQty = rule.minQuantity;
      }
    }
    // Weighted average rating across every denomination (a review is left
    // against the specific plan bought, not the product), so the card's star
    // rating reflects the WHOLE product, never just its cheapest plan.
    let ratingCount = 0;
    let weightedSum = 0;
    for (const d of denoms) {
      const r = ratings.get(d.id);
      if (r && r.count > 0 && r.avg != null) {
        ratingCount += r.count;
        weightedSum += r.avg * r.count;
      }
    }
    cards.push({
      slug: p.slug,
      name: p.name,
      category_name: p.category.name,
      from_price: fromPrice.toString(),
      variant_count: denoms.length,
      image: p.webImageUrl ?? productImage(p, p.category.name),
      available,
      rating: ratingCount > 0 ? weightedSum / ratingCount : null,
      rating_count: ratingCount,
      bulk_discount: bulkDiscount,
      bulk_min_qty: bulkMinQty,
      all_non_auto: denoms.every((d) => d.deliveryType !== "auto"),
    });
  }
  return cards;
}

/** STO-007: sort keys offered on the Category/Search grids. */
export const SORT_KEYS = ["default", "cheapest", "newest", "rating"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export function isSortKey(value: unknown): value is SortKey {
  return typeof value === "string" && (SORT_KEYS as readonly string[]).includes(value);
}

/**
 * Re-orders already-shaped cards by the chosen criterion. Runs in memory
 * (not a DB `ORDER BY`) because `from_price`/`rating` are computed across a
 * product's denominations by `shapeProducts` above, not columns the DB can
 * sort on directly; catalog sizes here are small enough (a few dozen active
 * products) that this is cheap. `products` must be the same array (order and
 * length) `shapeProducts` was called with, so `createdAt` can be looked up
 * by slug for the "newest" sort.
 */
export function sortProductCards(products: CatalogProduct[], cards: ProductCard[], sort: SortKey): ProductCard[] {
  if (sort === "default") return cards;
  const createdAtBySlug = new Map(products.map((p) => [p.slug, p.createdAt.getTime()]));
  const sorted = [...cards];
  if (sort === "cheapest") {
    sorted.sort((a, b) => new Decimal(a.from_price).comparedTo(new Decimal(b.from_price)));
  } else if (sort === "newest") {
    sorted.sort((a, b) => (createdAtBySlug.get(b.slug) ?? 0) - (createdAtBySlug.get(a.slug) ?? 0));
  } else if (sort === "rating") {
    sorted.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  }
  return sorted;
}
