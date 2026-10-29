/**
 * Page view-models for the public catalog pages (home / category / product /
 * search) — lifted verbatim out of the former routes/home.ts and
 * routes/catalog.ts (deleted once those pages cut over to React) so the JSON
 * API (routes/apiPages.ts) has one shaping implementation to call. Each
 * helper returns exactly the keys its page needs.
 */
import { config } from "@app/core/config";
import { canonicalProduct, type CanonicalProductContext } from "@app/core/canonicalProduct";
import { Decimal } from "@app/core/money";
import { activeFlashPercent, effectiveUnitPrice, flashPrice, hasLiveFlash } from "@app/core/flash";
import { hasSellableStock, usesLocalInventory } from "@app/core/productAvailability";
import {
  GROUP_ORDER_SETTING_KEY,
  groupForCategory,
  productGroup,
  productGroupBySlug,
  resolveGroupOrder,
  type ProductGroupDef,
} from "@app/core";
import { checkoutInputConfiguration } from "./inputConfiguration";
import {
  prisma,
  getSetting,
  getBestsellerSnapshot,
  getBestsellerSnapshotByVersion,
  isServiceActive,
  type BestsellerSnapshot,
  getCanonicalRateContext,
  getCategoryBySlug,
  listActiveCategories,
  listNewestCatalogProducts,
  listCatalogProducts,
  listFlashSaleProducts,
  getCatalogProductBySlugWithDenominations,
  searchCatalog,
  stockStatusCounts,
  productRatingSummaries,
  activeTiersByDenomination,
  listReviews,
  featuredReviews,
  type CatalogProduct,
} from "@app/db";
import { PRODUCT_VARIANT_WIDTHS, defaultThumbKind, webpSrcset } from "./images";
import { resolveDenomIconKind } from "./denomIcon";
import { productTemplate } from "./productTemplate";
import { resolveBotUsername, resolveSupportTelegramUrl } from "./shop";
import {
  aggregateRating,
  isOutOfStock,
  parseSortKey,
  rankCards,
  shapeFlashCards,
  shapeProducts,
  soldOutLast,
  type ProductCard,
  type SearchSort,
  type SortKey,
  type TierMap,
} from "./cards";
import { groupCategories, homeSections, type RankedEntry } from "./homeSections";
import { legacyBulkView, tierLadder, tierRuleView } from "./tierView";

/**
 * The effective volume tiers of every denomination on a set of catalog rows,
 * in ONE query (activeTiersByDenomination batches by id) — never one per card.
 */
async function tiersForProducts(products: readonly CatalogProduct[]): Promise<TierMap> {
  return activeTiersByDenomination(prisma, products.flatMap((p) => p.denominations.map((d) => d.id)));
}

/**
 * Everything a set of grid cards needs besides the products: catalog-wide
 * stock counts and rating summaries, plus ONE batched tier query for exactly
 * these products' denominations.
 */
async function cardInputs(products: readonly CatalogProduct[]) {
  const [stock, ratings, tiers] = await Promise.all([
    stockStatusCounts(prisma),
    productRatingSummaries(prisma),
    tiersForProducts(products),
  ]);
  const ratingByDenom = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
  return { stock, ratingByDenom, tiers };
}

/** Shape and rank a product list as grid cards (always priced for a non-reseller). */
async function rankedGrid(products: CatalogProduct[], sort: SortKey, snapshot?: BestsellerSnapshot): Promise<ProductCard[]> {
  const now = new Date();
  const [{ stock, ratingByDenom, tiers }, ranking] = await Promise.all([
    cardInputs(products),
    snapshot ?? getBestsellerSnapshot(prisma, { now }),
  ]);
  return rankCards(products, shapeProducts(products, stock, ratingByDenom, tiers, false, now), sort, ranking);
}

/** The JSON shape of a product group's identity. */
function groupView(def: ProductGroupDef) {
  return { key: def.key, slug: def.slug, label_key: def.labelKey, emoji: def.emoji };
}

/** Each catalog product's card in ranked order, tagged with the product's category. */
function rankedEntries(products: readonly CatalogProduct[], ranked: readonly ProductCard[]): Array<RankedEntry & { product: CatalogProduct }> {
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  return ranked.map((card) => {
    const product = bySlug.get(card.slug)!;
    return { product, categoryId: product.categoryId, card };
  });
}

/** At most this many flash cards on the home page's Flash Sale section. */
const HOME_FLASH_LIMIT = 8;
/** At most this many hero preview cards (one per group). */
const HERO_PRODUCTS_LIMIT = 3;

/**
 * A privacy-safe display name for a public testimonial: prefer the buyer's full
 * name, fall back to their web login / Telegram handle, and mask everything
 * after the first word to an initial ("Ahmad Fauzi" → "Ahmad F."). Never leaks
 * an email or a full handle.
 */
function reviewerName(user: { fullName: string | null; loginUsername: string | null; username: string | null }): string {
  const raw = (user.fullName || user.loginUsername || user.username || "").trim();
  if (!raw) return "Pelanggan";
  const parts = raw.split(/\s+/);
  const first = parts[0] ?? raw;
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

/**
 * The catalog part of the home page: one entry per rendered group (admin
 * order; a group with no products — its web service is off, or it has none
 * yet — is left out), the hero preview cards, the flash cards and the
 * ranking version. Shared by the JSON API (homePageData) and the crawler shell
 * (routes/spaShell.ts) so both always describe the same page.
 */
export async function homeCatalogData() {
  // One pricing instant, one catalog load and one ranking snapshot for the
  // whole page — never one per group.
  const now = new Date();
  const [categories, products, storedGroupOrder, snapshot] = await Promise.all([
    listActiveCategories(prisma, "web"),
    // Already drops products of a service switched off for the website.
    listCatalogProducts(prisma, "web"),
    getSetting(prisma, GROUP_ORDER_SETTING_KEY),
    getBestsellerSnapshot(prisma, { now }),
  ]);
  const { stock, ratingByDenom, tiers } = await cardInputs(products);
  const ranked = rankedEntries(
    products,
    rankCards(products, shapeProducts(products, stock, ratingByDenom, tiers, false, now), "bestseller", snapshot),
  );

  const groups = [];
  const groupEntries: RankedEntry[][] = [];
  for (const key of resolveGroupOrder(storedGroupOrder)) {
    const def = productGroup(key);
    const entries = ranked.filter((e) => groupForCategory(e.product.category.group) === key);
    if (entries.length === 0) continue;
    const groupCats = groupCategories(def, categories, entries);
    groups.push({
      ...groupView(def),
      layout: def.homeLayout,
      category_count: groupCats.length,
      single_category_slug: groupCats.length === 1 ? groupCats[0]!.slug : null,
      sections: homeSections(def, entries, categories),
    });
    groupEntries.push(entries);
  }

  const flashProducts = products.filter((p) => hasLiveFlash(p, now));
  const flash = rankCards(
    flashProducts,
    shapeFlashCards(flashProducts, stock, ratingByDenom, tiers, now),
    "bestseller",
    snapshot,
  ).slice(0, HOME_FLASH_LIMIT);

  return {
    groups,
    hero_products: heroCards(groupEntries.map((entries) => entries.map((e) => e.card))),
    flash,
    ranking_version: snapshot.version,
  };
}

/** The hero's preview cards: the top in-stock card of each group (group order). */
export function heroCards(groups: readonly (readonly ProductCard[])[]): ProductCard[] {
  const picked: ProductCard[] = [];
  for (const cards of groups) {
    const lead = cards.find((c) => !isOutOfStock(c));
    if (lead && picked.length < HERO_PRODUCTS_LIMIT) picked.push(lead);
  }
  return picked;
}

/** Home page data — shaped for the JSON API (GET /api/v1/pages/home). */
export async function homePageData() {
  const [catalog, reviews, waNumber, heroUrl] = await Promise.all([
    homeCatalogData(),
    featuredReviews(prisma, 4),
    // WhatsApp button on the contact section — set in web-admin Settings ›
    // Website; empty/unset hides the button.
    getSetting(prisma, "support_whatsapp"),
    // Hero banner — admin-uploaded image overrides the gradient default.
    getSetting(prisma, "web_hero_url"),
  ]);

  // Real testimonials from delivered-order reviews (≥4★ with a comment).
  const testimonials = reviews
    .filter((r) => (r.comment ?? "").trim().length > 0)
    .map((r) => {
      const name = reviewerName(r.user);
      return {
        id: r.id,
        name,
        initial: name.charAt(0).toUpperCase() || "?",
        product: r.product.name,
        rating: r.rating,
        comment: r.comment!.trim(),
      };
    });

  return {
    hero_image: heroUrl || null,
    hero_products: catalog.hero_products,
    groups: catalog.groups,
    flash: catalog.flash,
    ranking_version: catalog.ranking_version,
    testimonials,
    low_threshold: config.LOW_STOCK_THRESHOLD,
    bot_username: await resolveBotUsername(),
    support_telegram_url: await resolveSupportTelegramUrl(),
    wa_number: (waNumber ?? "").replace(/[^0-9]/g, ""),
  };
}

/** Category page data, or null for the 404 branch (GET /api/v1/pages/category/:slug). */
export async function categoryPageData(rawSlug: string, rawSort?: unknown) {
  const slug = (rawSlug ?? "").trim();
  const category = slug ? await getCategoryBySlug(prisma, slug, "web") : null;
  if (!category || !category.isActive) return null;
  // The category's group decides which sorts it offers (no cheapest on Game Top Up).
  const def = productGroup(groupForCategory(category.group));
  const sort = parseSortKey(rawSort, { allowCheapest: def.allowCheapestSort });
  const [categories, products] = await Promise.all([
    listActiveCategories(prisma, "web"),
    listCatalogProducts(prisma, "web", category.id),
  ]);
  return {
    category,
    categories,
    group: def.key,
    allow_cheapest: def.allowCheapestSort,
    // Same shaper and ordering as every other grid.
    products: await rankedGrid(products, sort),
    low_threshold: config.LOW_STOCK_THRESHOLD,
  };
}

/** Raw `?category=&sort=&offset=&limit=&v=` of GET /api/v1/pages/group/:slug. */
export interface GroupPageQuery {
  /** Comma-separated slugs; the parameter may also repeat (string[]). */
  category?: string | string[];
  sort?: unknown;
  offset?: unknown;
  limit?: unknown;
  v?: unknown;
}

const GROUP_PAGE_DEFAULT_LIMIT = 20;
const GROUP_PAGE_MAX_LIMIT = 40;

/** A whole-number query value, or null when absent or malformed. */
function intParam(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^-?\d{1,9}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/**
 * Group page data (GET /api/v1/pages/group/:slug), or null for an unknown
 * slug. Paging is an in-memory slice of the ranked group (the catalog is
 * loaded whole). A `v` naming a ranking snapshot still held keeps the order
 * stable across pages; otherwise the current snapshot ranks, and the version
 * actually used is always returned.
 */
export async function groupPageData(rawSlug: string, query: GroupPageQuery = {}) {
  const def = productGroupBySlug((rawSlug ?? "").trim());
  if (!def) return null;
  const sort = parseSortKey(query.sort, { allowCheapest: def.allowCheapestSort });
  const offset = Math.max(0, intParam(query.offset) ?? 0);
  const limit = Math.min(GROUP_PAGE_MAX_LIMIT, Math.max(1, intParam(query.limit) ?? GROUP_PAGE_DEFAULT_LIMIT));
  const requestedVersion = intParam(query.v);
  const snapshot =
    (requestedVersion !== null ? await getBestsellerSnapshotByVersion(prisma, requestedVersion) : null) ??
    (await getBestsellerSnapshot(prisma));
  const head = {
    group: { ...groupView(def), allow_cheapest: def.allowCheapestSort },
    sort,
    ranking_version: snapshot.version,
    low_threshold: config.LOW_STOCK_THRESHOLD,
  };
  if (!(await isServiceActive(prisma, def.key, "web"))) {
    return { ...head, unavailable: true, categories: [], products: [], total: 0, next_offset: null };
  }

  const [categories, catalog] = await Promise.all([listActiveCategories(prisma, "web"), listCatalogProducts(prisma, "web")]);
  const inGroup = catalog.filter((p) => groupForCategory(p.category.group) === def.key);
  const groupCats = groupCategories(def, categories, inGroup);
  // Unknown slugs and other groups' categories are ignored; nothing known left = every category.
  // `?category=a,b` and a repeated `?category=a&category=b` mean the same.
  const rawCategories = Array.isArray(query.category) ? query.category : [query.category];
  const wanted = new Set(
    rawCategories.flatMap((v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()) : [])),
  );
  const picked = groupCats.filter((c) => wanted.has(c.slug));
  const pickedIds = new Set((picked.length > 0 ? picked : groupCats).map((c) => c.id));
  const products = inGroup.filter((p) => pickedIds.has(p.categoryId));

  const ranked = await rankedGrid(products, sort, snapshot);
  const end = offset + limit;
  return {
    ...head,
    unavailable: false,
    categories: groupCats.map((c) => ({ slug: c.slug, name: c.name, emoji: c.emoji })),
    products: ranked.slice(offset, end),
    total: ranked.length,
    next_offset: end < ranked.length ? end : null,
  };
}

/** Product detail page data, or null for the 404 branch (GET
 * /api/v1/pages/product/:slug). Reviews keep their Date here — the JSON
 * route (routes/apiPages.ts) pre-formats it with the same localize() the
 * Nunjucks localdt filter used to, so callers get a display string, not a
 * raw Date to serialize themselves. */
/**
 * `isReseller` prices the page for the signed-in viewer: a reseller is charged
 * `min(resellerPrice, flashPrice)` at checkout (@app/core/flash), so pricing the
 * page with the everyone-price would quote them a figure that isn't theirs —
 * higher than they pay whenever their standing price is the cheaper of the two.
 * Guests and signed-out visitors keep the everyone price (the default).
 */
export async function productPageData(rawSlug: string, isReseller = false, display: { preferredCurrency?: "IDR" | "USD"; locale?: string } = {}) {
  const slug = (rawSlug ?? "").trim();
  const product = slug ? await getCatalogProductBySlugWithDenominations(prisma, slug, "web") : null;
  if (!product || !product.isActive || product.isArchived || product.denominations.length === 0) return null;

  // Per-denomination stock + bulk-pricing badge (price-asc order preserved).
  const [stock, productTiers, reviews, sameCategoryProducts, ratings, rateContext] = await Promise.all([
    stockStatusCounts(prisma),
    activeTiersByDenomination(prisma, product.denominations.map((d) => d.id)),
    // Reviews are tied to the specific denomination the customer bought —
    // gather across every active denomination of this Product, not just
    // the cheapest, or reviews left on other plans silently disappear.
    listReviews(prisma, { productId: product.denominations.map((d) => d.id), hidden: false, limit: 10 }),
    // STO-011 "You might also like" — same category, current product excluded below.
    listCatalogProducts(prisma, "web", product.categoryId),
    productRatingSummaries(prisma),
    getCanonicalRateContext(prisma),
  ]);
  const displayContext: Omit<CanonicalProductContext, "effectivePriceIDR"> = { ...rateContext, preferredCurrency: display.preferredCurrency ?? "IDR", locale: display.locale ?? "id", generatedAt: new Date().toISOString() };

  const catName = product.category.name;
  // One pricing instant for every plan and tier rung on the page.
  const pricedAt = new Date();
  const denominations = product.denominations.map((d) => {
    const available = stock[d.id]?.available ?? 0;
    const tiers = productTiers[d.id] ?? [];
    const salePrice = flashPrice(d, pricedAt);
    const unit = effectiveUnitPrice(d, isReseller, pricedAt);
    // Badge only when the flash price is the one this viewer actually gets —
    // the same rule flashViewFor applies to a cart line.
    const flashPct = salePrice !== null && unit.equals(salePrice) ? activeFlashPercent(d, pricedAt) : null;
    const canonical = canonicalProduct({ denomination: { ...d, createdAt: d.createdAt.toISOString() }, product, category: product.category, stockAvailable: hasSellableStock(d, available) }, { ...displayContext, effectivePriceIDR: unit.toString() });
    return {
      id: d.id,
      canonical,
      name: d.name,
      duration_label: d.durationLabel,
      // Always the price a shopper actually pays — the pre-sale figure lives
      // in `flash.base_price` for the strike-through, so a client that ignores
      // `flash` still quotes the correct amount.
      price: unit.toString(),
      flash:
        flashPct && salePrice
          ? {
              discount_percent: flashPct.toString(),
              base_price: new Decimal(d.price).toString(),
              ends_at: d.flashEndsAt!.toISOString(),
            }
          : null,
      warranty_days: d.warrantyDays,
      available,
      in_stock: available > 0,
      // From @app/core/productAvailability (additive). `uses_local_inventory`
      // is false for provider (e.g. auto + Digiflazz) and manual SKUs, which
      // never hold stock rows: the client must not show their stock count,
      // "N left" or "Notify me". `purchasable` is the canonical verdict the
      // client gates buying on, so it never re-derives the rule itself.
      uses_local_inventory: usesLocalInventory(d),
      purchasable: canonical.availability.purchasable,
      // Legacy single-rule view (older clients): the lowest-threshold percent
      // tier, derived from the tiers exactly like the `bulk_pricing` mirror.
      bulk: legacyBulkView(tiers),
      // Every effective volume tier of this plan (toggle on, enabled, valid),
      // lowest threshold first — the rules as configured.
      tiers: tiers.map(tierRuleView),
      // The ladder the plan picker shows: each tier with the unit price the
      // engine charges this viewer at its threshold (server-priced; the client
      // never derives a price from `tiers`). Rungs that save nothing are left out.
      tier_ladder: tierLadder(d, tiers, isReseller, pricedAt),
      // Provider and manual SKUs never have stock rows, so `available`/
      // `in_stock` above are 0/false for them by design — the client gates
      // purchasability on `purchasable` instead. additional_fields is the
      // parsed manual_with_info field spec ([] for auto/manual).
      delivery_type: d.deliveryType,
      ...checkoutInputConfiguration(d),
    };
  });
  // Default restock-form target (Task 10 fix): "first in-stock denomination,
  // else the first denomination" — the same selection order the React
  // ProductPage applies client-side, precomputed here so the initial
  // server-shaped payload already names a valid denomination id.
  // `denominations` is never empty here (guarded by the null return above).
  const defaultRestockDenominationId = (denominations.find((d) => d.purchasable) ?? denominations[0])!.id;

  // STO-011 "You might also like" — same category, current product excluded,
  // capped at a small shelf rather than the full category listing.
  const RELATED_PRODUCTS_LIMIT = 4;
  const ratingByDenom = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
  const relatedProducts = shapeProducts(
    sameCategoryProducts.filter((p) => p.id !== product.id),
    stock,
    ratingByDenom,
    await tiersForProducts(sameCategoryProducts),
    isReseller,
  ).slice(0, RELATED_PRODUCTS_LIMIT);
  // Same weighted-average-across-denominations logic ProductCard's rating
  // comes from (shapeProducts, above) — reused via aggregateRating rather
  // than a second calculation, so the detail page's summary can never
  // disagree with the card that linked here. `count` is the TRUE total of
  // non-hidden reviews across every denomination (productRatingSummaries
  // groups the whole table), not `reviews.length` below, which is capped
  // at 10 fetched rows.
  const { avg: productRatingAvg, count: productRatingCount } = aggregateRating(
    product.denominations.map((d) => d.id),
    ratingByDenom,
  );

  return {
    product: {
      slug: product.slug,
      name: product.name,
      description: product.description,
      what_you_get: product.whatYouGet,
      terms: product.terms,
      warranty_note: product.warrantyNote,
      category_name: catName,
      category_slug: product.category.slug,
      image: product.webImageUrl ?? null,
      image_srcset: webpSrcset(product.webImageUrl, PRODUCT_VARIANT_WIDTHS),
      image_kind: defaultThumbKind(product, product.category),
      // Per-product currency chip on DenominationCard — resolved ONCE here
      // (not per-denomination) since every plan under one product shares the
      // same in-game currency. `product.denominations` is already sorted
      // price-asc (getCatalogProductBySlugWithDenominations's query), so
      // `[0]` is the cheapest/first one without a new sort.
      icon_kind: resolveDenomIconKind(product, product.category, product.denominations[0]?.qtyUnit ?? null),
      rating: productRatingAvg,
      rating_count: productRatingCount,
      // Already fetched via getCatalogProductBySlugWithDenominations's
      // `include: { category: true }` — no crud-layer change needed.
      checkout_flow: product.category.checkoutFlow,
      // The server picks the page template; the client branches on this, not
      // on checkout_flow (kept above only for cached older clients).
      template: productTemplate(product.category),
    },
    denominations,
    default_restock_denomination_id: defaultRestockDenominationId,
    related_products: relatedProducts,
    reviews: reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      // Mask the reviewer: first letter + *** (never leak usernames).
      author: `${(r.user.fullName ?? r.user.username ?? "A").slice(0, 1)}***`,
      created_at: r.createdAt,
    })),
    low_threshold: config.LOW_STOCK_THRESHOLD,
  };
}

/** Search page data — shaped for the JSON API (GET /api/v1/pages/search). */
export async function searchPageData(rawQ: string, sort: SearchSort = "relevance") {
  const q = (rawQ ?? "").trim();
  const products = q ? await searchCatalog(prisma, q, "web", 24) : [];
  let cards: ProductCard[];
  if (sort === "relevance") {
    // searchCatalog's own order, with only the sold-out partition applied.
    const { stock, ratingByDenom, tiers } = await cardInputs(products);
    cards = soldOutLast(shapeProducts(products, stock, ratingByDenom, tiers));
  } else {
    cards = await rankedGrid(products, sort);
  }
  return {
    q,
    sort,
    products: cards,
    low_threshold: config.LOW_STOCK_THRESHOLD,
  };
}

/** Every purchasable product — the "Browse products" shelf (GET /api/v1/pages/products). */
export async function allProductsPageData(sort: SortKey = "bestseller") {
  return {
    products: await rankedGrid(await listCatalogProducts(prisma, "web"), sort),
    low_threshold: config.LOW_STOCK_THRESHOLD,
  };
}

/**
 * Task 10 (E4): the small "you might like" shelf EmptyState.tsx renders below
 * its card on pages where shopping is genuinely the next step (an empty cart,
 * no orders yet, a search with no results — see the client's
 * lib/useSuggestedProducts.ts for the full list of callers). The shop's
 * newest products (listNewestCatalogProducts' own order, kept as-is), capped
 * small since this is a secondary element, not the page's main content — and
 * shaped by the same shapeProducts() every other grid uses, so a suggested
 * card can never disagree with the "real" grid it's standing in for.
 */
const SUGGESTED_PRODUCTS_LIMIT = 4;
export async function suggestionsPageData() {
  const products = await listNewestCatalogProducts(prisma, "web", SUGGESTED_PRODUCTS_LIMIT);
  const { stock, ratingByDenom, tiers } = await cardInputs(products);
  return {
    products: shapeProducts(products, stock, ratingByDenom, tiers),
    low_threshold: config.LOW_STOCK_THRESHOLD,
  };
}

/** Products with a flash sale running right now (GET /api/v1/pages/flash), as
 * the same flash cards the home Flash Sale section shows. An empty list is a
 * normal state — no sale is on — not an error. */
export async function flashPageData(sort: SortKey = "bestseller") {
  const now = new Date();
  const products = await listFlashSaleProducts(prisma, "web", now);
  const [{ stock, ratingByDenom, tiers }, snapshot] = await Promise.all([
    cardInputs(products),
    getBestsellerSnapshot(prisma, { now }),
  ]);
  return {
    products: rankCards(products, shapeFlashCards(products, stock, ratingByDenom, tiers, now), sort, snapshot),
    low_threshold: config.LOW_STOCK_THRESHOLD,
  };
}

/** The category index (GET /api/v1/pages/categories). No stock-photo fallback
 * for `image` anymore (Fase 12) — same raw (always-null-today) Category.image
 * column the homepage tiles now pass through. */
export async function categoriesPageData() {
  const categories = await listActiveCategories(prisma, "web");
  return { categories };
}
