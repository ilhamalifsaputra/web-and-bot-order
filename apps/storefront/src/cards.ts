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
import { activeFlashPercent, effectiveUnitPrice, flashPrice } from "@app/core/flash";
import { activeBulkPercent } from "@app/core/bulk";
import { PRODUCT_VARIANT_WIDTHS, defaultThumbKind, webpSrcset, type ThumbnailKind } from "./images";

export type ProductCard = {
  slug: string;
  name: string;
  category_name: string;
  /** Cheapest active denomination price (Decimal as string) — "starting from". */
  from_price: string;
  /** Number of denominations (plans) the product offers. */
  variant_count: number;
  /** The admin's real photo, or null — no stock-photo fallback of any kind.
   * A null renders the DefaultThumb design-system placeholder client-side,
   * keyed by `image_kind`. */
  image: string | null;
  /** WebP `srcset` for `image`, or null when no derivatives exist — see
   *  webpSrcset(). Null means "render a plain <img>", never a broken image. */
  image_srcset: string | null;
  /** Which DefaultThumb icon to show when `image` is null — see
   *  defaultThumbKind() in ./images. Always populated, even when `image` is
   *  set, so a client that later loses the photo still has a kind to fall
   *  back to. */
  image_kind: ThumbnailKind;
  /** Available stock across all denominations of this product. */
  available: number;
  rating: number | null;
  rating_count: number;
  bulk_discount: string | null;
  bulk_min_qty: number | null;
  /** Live flash discount on the SAME denomination that set `from_price`, or
   * null. Deliberately not "the biggest discount on the product": the card
   * shows one headline price, and a badge describing a different plan would
   * make the struck-through figure below it a number that never existed. */
  flash_discount: string | null;
  /** That denomination's pre-sale price, for the strike-through. Null when no
   * flash sale is behind `from_price`. */
  from_base_price: string | null;
  /** When the flash sale behind `flash_discount` ends (ISO), for the countdown. */
  flash_ends_at: string | null;
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
 * Weighted average rating + true count across a set of denomination ids. A
 * review is left against the specific plan bought, not the parent Product, so
 * a product's honest rating combines every plan's summary rather than only
 * its cheapest/lead one — count-weighted so a plan with many reviews isn't
 * diluted to the same voice as one with a single review. `ratings` come from
 * `productRatingSummaries` (packages/db/src/crud/reviews.ts), which groups
 * over EVERY non-hidden review in the DB — never capped by a page's fetch
 * limit — so `count` here is always the true total.
 *
 * Shared by `shapeProducts` (grid/related-product cards) and
 * `pageData.ts`'s `productPageData` (the detail page's own aggregate), so the
 * two can never compute this differently.
 */
export function aggregateRating(
  denominationIds: number[],
  ratings: RatingMap,
): { avg: number | null; count: number } {
  let count = 0;
  let weightedSum = 0;
  for (const id of denominationIds) {
    const r = ratings.get(id);
    if (r && r.count > 0 && r.avg != null) {
      count += r.count;
      weightedSum += r.avg * r.count;
    }
  }
  return { avg: count > 0 ? weightedSum / count : null, count };
}

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
  isReseller = false,
): ProductCard[] {
  const cards: ProductCard[] = [];
  for (const p of products) {
    const denoms = p.denominations; // active, price-asc (cheapest first)
    if (denoms.length === 0) continue; // listCatalogProducts already filters these out
    // "Starting price" is the cheapest price THIS shopper can actually pay right
    // now, so a flash sale can reorder which denomination leads — take each
    // one's live price rather than its list price. effectiveUnitPrice (not
    // flashPrice) is what checkout charges: a reseller pays whichever of their
    // standing price and the flash price is cheaper, so quoting the flash price
    // to a reseller whose own price is lower advertised MORE than they'd pay.
    const livePrice = (d: (typeof denoms)[number]) => effectiveUnitPrice(d, isReseller);
    let cheapest = denoms[0]!;
    for (const d of denoms) {
      if (livePrice(d).lessThan(livePrice(cheapest))) cheapest = d;
    }
    const fromPrice = livePrice(cheapest);
    const available = denoms.reduce((sum, d) => sum + (stock[d.id]?.available ?? 0), 0);
    // Best (largest) active bulk discount across this product's denominations.
    let bulkDiscount: string | null = null;
    let bulkMinQty: number | null = null;
    for (const d of denoms) {
      const rule = bulk[d.id];
      // activeBulkPercent, not the raw column: a badge must never advertise a
      // rule checkout would refuse to honour (@app/core/bulk validates the
      // stored row on read, the way activeFlashPercent does).
      const percent = rule ? activeBulkPercent(rule, rule.minQuantity) : null;
      if (percent && (bulkDiscount === null || percent.greaterThan(bulkDiscount))) {
        bulkDiscount = rule!.discountPercent;
        bulkMinQty = rule!.minQuantity;
      }
    }
    // The flash badge describes the plan behind `from_price` — NOT the biggest
    // discount on the product, the way the bulk badge above does. The two
    // differ deliberately: bulk_discount is a standalone claim ("buy 5+, save
    // 20%"), while the flash badge sits next to the headline price and its
    // struck-through original. Sourcing them from different denominations
    // would print a "was" price that no plan was ever sold at.
    //
    // The badge also only appears when the flash price is the one that actually
    // won `from_price` — the same rule flashViewFor applies on the cart line. A
    // reseller keeping their cheaper standing price sees no badge, because for
    // them nothing was discounted and the struck-through "was" price would be
    // a number they were never going to pay.
    const leadSale = flashPrice(cheapest);
    const leadFlash = leadSale !== null && fromPrice.equals(leadSale) ? activeFlashPercent(cheapest) : null;
    const flashDiscount = leadFlash ? leadFlash.toString() : null;
    const fromBasePrice = leadFlash ? new Decimal(cheapest.price).toString() : null;
    const flashEndsAt = leadFlash ? cheapest.flashEndsAt!.toISOString() : null;
    // Weighted average rating across every denomination (a review is left
    // against the specific plan bought, not the product), so the card's star
    // rating reflects the WHOLE product, never just its cheapest plan.
    const { avg: rating, count: ratingCount } = aggregateRating(
      denoms.map((d) => d.id),
      ratings,
    );
    cards.push({
      slug: p.slug,
      name: p.name,
      category_name: p.category.name,
      from_price: fromPrice.toString(),
      variant_count: denoms.length,
      image: p.webImageUrl ?? null,
      image_srcset: webpSrcset(p.webImageUrl, PRODUCT_VARIANT_WIDTHS),
      image_kind: defaultThumbKind(p, p.category),
      available,
      rating,
      rating_count: ratingCount,
      bulk_discount: bulkDiscount,
      bulk_min_qty: bulkMinQty,
      flash_discount: flashDiscount,
      from_base_price: fromBasePrice,
      flash_ends_at: flashEndsAt,
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
