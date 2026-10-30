/**
 * Shared card-context shaper for the grid pages (home, category, search). In the
 * 3-tier catalog a grid renders ONE kind of card: a Product (mid-tier) card that
 * links to the product detail page `/p/:slug`. Denominations (the SKUs with a
 * price/stock) are NEVER shown on a grid — they are chosen only inside product
 * detail. The card's headline price is the product's "starting price" = its
 * cheapest active denomination. Centralising the shaping keeps the three grids
 * identical.
 */
import { compareBestseller, compareNewest, type BestsellerSnapshot, type CatalogProduct } from "@app/db";
import { Decimal } from "@app/core/money";
import { activeFlashPercent, effectiveUnitPrice, flashPrice } from "@app/core/flash";
import type { PricingTier } from "@app/core/bulk";
import { hasSellableStock, usesLocalInventory } from "@app/core/productAvailability";
import { PRODUCT_VARIANT_WIDTHS, defaultThumbKind, webpSrcset, type ThumbnailKind } from "./images";
import { bestTierBadge, type TierBadge } from "./tierView";

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
  /** Available stock across this product's local-inventory denominations. */
  available: number;
  rating: number | null;
  rating_count: number;
  /** The best volume-tier saving across the product's plans, as a percent
   * string — exact for a percent tier, a whole percent rounded down for a
   * fixed-amount/fixed-price tier (see `bulk_up_to`). Null when no tier saves. */
  bulk_discount: string | null;
  /** The quantity that best saving starts at. */
  bulk_min_qty: number | null;
  /** True when `bulk_discount` was derived from a fixed-amount or fixed-price
   * tier, so the badge reads "up to". Additive. */
  bulk_up_to: boolean;
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
  /** True when no active denomination draws from local inventory
   * (@app/core/productAvailability: provider SKUs such as auto + Digiflazz,
   * and manual/manual_with_info), so this product never carries a real stock
   * count and is always purchasable (STO-001). The name predates provider
   * SKUs; it is kept so the payload shape does not change. */
  all_non_auto: boolean;
  /** True when every active denomination draws from local inventory. Only
   * then is `available` the product's real stock; a mixed product (some
   * provider/manual plans) is purchasable regardless of it, so its card must
   * not present the partial local count as the product's stock. Additive. */
  all_local_inventory: boolean;
  /** True when the product was created within NEW_PRODUCT_WINDOW_MS of the
   * pricing instant — the "New" badge. */
  is_new: boolean;
  /** Flash cards only (`shapeFlashCards`): the denomination this card
   * advertises, so its link can preselect it. Null on every other card. */
  promo_denomination_id: number | null;
  promo_denomination_name: string | null;
  /** Flash cards only: how many OTHER denominations of the product are on a
   * live flash sale ("+N more deals"). 0 on every other card. */
  other_promo_count: number;
};

/** How long after creation a product carries the "New" badge. */
export const NEW_PRODUCT_WINDOW_MS = 14 * 24 * 3600_000;

/** Available stock keyed by denomination id. */
type StockMap = Record<number, { available: number }>;
/** Rating summaries keyed by denomination id (`productId` column = SKU). */
type RatingMap = Map<number, { avg: number | null; count: number }>;
/** Effective volume tiers keyed by denomination id (`activeTiersByDenomination`). */
export type TierMap = Record<number, PricingTier[]>;

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
  tiers: TierMap = {},
  isReseller = false,
  // One pricing instant for the whole grid.
  now: Date = new Date(),
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
    const livePrice = (d: (typeof denoms)[number]) => effectiveUnitPrice(d, isReseller, now);
    let cheapest = denoms[0]!;
    for (const d of denoms) {
      if (livePrice(d).lessThan(livePrice(cheapest))) cheapest = d;
    }
    const fromPrice = livePrice(cheapest);
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
    const leadSale = flashPrice(cheapest, now);
    const leadFlash = leadSale !== null && fromPrice.equals(leadSale) ? activeFlashPercent(cheapest, now) : null;
    cards.push({
      ...cardBase(p, stock, ratings, tiers, isReseller, now),
      from_price: fromPrice.toString(),
      flash_discount: leadFlash ? leadFlash.toString() : null,
      from_base_price: leadFlash ? new Decimal(cheapest.price).toString() : null,
      flash_ends_at: leadFlash ? cheapest.flashEndsAt!.toISOString() : null,
      promo_denomination_id: null,
      promo_denomination_name: null,
      other_promo_count: 0,
    });
  }
  return cards;
}

/** The card fields that depend on which denomination the card advertises. */
type LeadFields =
  | "from_price"
  | "flash_discount"
  | "from_base_price"
  | "flash_ends_at"
  | "promo_denomination_id"
  | "promo_denomination_name"
  | "other_promo_count";

/**
 * Every card field that describes the PRODUCT as a whole — identity, image,
 * stock, rating, bulk badge, "New" badge — shared by grid cards
 * (`shapeProducts`) and flash cards (`shapeFlashCards`) so the two can never
 * compute them differently.
 */
function cardBase(
  p: CatalogProduct,
  stock: StockMap,
  ratings: RatingMap,
  tiers: TierMap,
  isReseller: boolean,
  now: Date,
): Omit<ProductCard, LeadFields> {
  const denoms = p.denominations;
  // Only local-inventory SKUs carry a real stock count; a provider SKU's
  // stray rows (if any) must not inflate the product's figure.
  const localDenoms = denoms.filter((d) => usesLocalInventory(d));
  const available = localDenoms.reduce((sum, d) => sum + (stock[d.id]?.available ?? 0), 0);
  // Best volume-tier saving across this product's denominations, priced by
  // the engine for THIS shopper (a fixed-amount tier's percent depends on
  // the unit it comes off). Only the effective tier set reaches here
  // (toggle on, enabled, valid on read — effectiveTiersByDenomination), so
  // the badge never advertises a tier checkout would refuse to honour.
  let best: TierBadge | null = null;
  for (const d of denoms) {
    const badge = bestTierBadge(d, tiers[d.id] ?? [], isReseller, now);
    if (badge && (best === null || badge.percent.greaterThan(best.percent))) best = badge;
  }
  // Weighted average rating across every denomination (a review is left
  // against the specific plan bought, not the product), so the card's star
  // rating reflects the WHOLE product, never just its cheapest plan.
  const { avg: rating, count: ratingCount } = aggregateRating(
    denoms.map((d) => d.id),
    ratings,
  );
  return {
    slug: p.slug,
    name: p.name,
    category_name: p.category.name,
    variant_count: denoms.length,
    image: p.webImageUrl ?? null,
    image_srcset: webpSrcset(p.webImageUrl, PRODUCT_VARIANT_WIDTHS),
    image_kind: defaultThumbKind(p, p.category),
    available,
    rating,
    rating_count: ratingCount,
    bulk_discount: best ? best.percent.toString() : null,
    bulk_min_qty: best ? best.minQuantity : null,
    bulk_up_to: best?.upTo ?? false,
    all_non_auto: localDenoms.length === 0,
    all_local_inventory: localDenoms.length === denoms.length,
    is_new: now.getTime() - p.createdAt.getTime() < NEW_PRODUCT_WINDOW_MS,
  };
}

/**
 * Flash-sale cards (home Flash Sale section and /flash). Unlike a grid card,
 * which leads with the cheapest plan, a flash card advertises the DEAL: the
 * flash-active denomination with the largest percent off (tie: the sale ending
 * soonest, then the lowest id), preferring a plan that can be bought
 * (hasSellableStock) and only falling back to a sold-out one when no deal is
 * buyable; priced for a non-reseller like every grid. Its id/name ride along
 * so the card can link straight to that plan, and `other_promo_count` counts
 * the other deals in the pool it was chosen from. Products with no
 * live flash sale at `now` produce no card.
 */
export function shapeFlashCards(
  products: CatalogProduct[],
  stock: StockMap,
  ratings: RatingMap,
  tiers: TierMap,
  now: Date,
): ProductCard[] {
  const cards: ProductCard[] = [];
  for (const p of products) {
    const deals = p.denominations
      .map((d) => ({ d, percent: activeFlashPercent(d, now) }))
      .filter((x): x is { d: (typeof x)["d"]; percent: Decimal } => x.percent !== null);
    if (deals.length === 0) continue;
    deals.sort(
      (a, b) =>
        b.percent.comparedTo(a.percent) ||
        a.d.flashEndsAt!.getTime() - b.d.flashEndsAt!.getTime() ||
        a.d.id - b.d.id,
    );
    // Never advertise a sold-out plan while a buyable deal exists: choose
    // among the buyable deals, and only when none is buyable fall back to
    // every deal. "+N more deals" counts the rest of that same pool.
    const buyable = deals.filter((x) => hasSellableStock(x.d, stock[x.d.id]?.available ?? 0));
    const pool = buyable.length > 0 ? buyable : deals;
    const { d: promo, percent } = pool[0]!;
    cards.push({
      ...cardBase(p, stock, ratings, tiers, false, now),
      from_price: effectiveUnitPrice(promo, false, now).toString(),
      flash_discount: percent.toString(),
      from_base_price: new Decimal(promo.price).toString(),
      flash_ends_at: promo.flashEndsAt!.toISOString(),
      promo_denomination_id: promo.id,
      promo_denomination_name: promo.name,
      other_promo_count: pool.length - 1,
    });
  }
  return cards;
}

/** Sort keys offered on the storefront grids; `bestseller` is the default. */
export const SORT_KEYS = ["bestseller", "newest", "cheapest"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/**
 * A `?sort=` value as the effective sort. Unknown and legacy keys (`default`,
 * `rating`) fall back to `bestseller`, as does `cheapest` on a page that does
 * not offer it (Game Top Up) — never an error.
 */
export function parseSortKey(raw: unknown, opts: { allowCheapest: boolean }): SortKey {
  if (raw === "newest") return "newest";
  if (raw === "cheapest" && opts.allowCheapest) return "cheapest";
  return "bestseller";
}

/**
 * Search's effective sort. With no explicit sort key (missing, legacy or
 * unknown) search keeps `searchCatalog`'s own relevance order; an explicit
 * key works as on every other page. Search-only: "relevance" is not a
 * SortKey and no other page offers it.
 */
export type SearchSort = SortKey | "relevance";
export function parseSearchSort(raw: unknown): SearchSort {
  return (SORT_KEYS as readonly unknown[]).includes(raw) ? parseSortKey(raw, { allowCheapest: true }) : "relevance";
}

/** Sold out: every active plan draws from local inventory and none is left
 * (mirrors the client's StockBadge rule). */
export function isOutOfStock(card: ProductCard): boolean {
  return card.all_local_inventory && card.available === 0;
}

/** Stable partition: sold-out cards move to the back, every other order kept. */
export function soldOutLast(cards: readonly ProductCard[]): ProductCard[] {
  return [...cards.filter((c) => !isOutOfStock(c)), ...cards.filter(isOutOfStock)];
}

/**
 * The one ordering every grid uses. Sorts in memory (the catalog is loaded
 * whole and `from_price` is computed per card, not a column): `bestseller` by
 * the ranking snapshot, `newest` by product creation, `cheapest` by
 * `from_price` as a Decimal (tie: newest). Then a stable partition moves
 * out-of-stock cards to the back, keeping their relative order. `products`
 * must contain the product behind every card (matched by slug).
 */
export function rankCards(
  products: readonly CatalogProduct[],
  cards: readonly ProductCard[],
  sort: SortKey,
  snapshot: BestsellerSnapshot,
): ProductCard[] {
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  const productOf = (card: ProductCard): CatalogProduct => {
    const p = bySlug.get(card.slug);
    if (!p) throw new Error(`The card "${card.slug}" was ranked without the product it was shaped from.`);
    return p;
  };
  const bestseller = compareBestseller(snapshot);
  const compare = (a: ProductCard, b: ProductCard): number => {
    const pa = productOf(a);
    const pb = productOf(b);
    if (sort === "newest") return compareNewest(pa, pb);
    if (sort === "cheapest") return new Decimal(a.from_price).comparedTo(new Decimal(b.from_price)) || compareNewest(pa, pb);
    return bestseller(pa, pb);
  };
  return soldOutLast([...cards].sort(compare));
}
