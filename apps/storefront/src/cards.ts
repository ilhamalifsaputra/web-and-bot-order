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
 * each product aggregates across its denominations: stock = sum, rating = the
 * cheapest (lead) denomination's summary, bulk badge = the best discount found.
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
    const lead = denoms[0]!; // cheapest → the "starting price" + lead rating
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
    cards.push({
      slug: p.slug,
      name: p.name,
      category_name: p.category.name,
      from_price: fromPrice.toString(),
      variant_count: denoms.length,
      image: p.webImageUrl ?? productImage(p, p.category.name),
      available,
      rating: ratings.get(lead.id)?.avg ?? null,
      rating_count: ratings.get(lead.id)?.count ?? 0,
      bulk_discount: bulkDiscount,
      bulk_min_qty: bulkMinQty,
    });
  }
  return cards;
}
