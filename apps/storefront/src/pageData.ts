/**
 * Page view-models for the public catalog pages (home / category / product /
 * search) — lifted verbatim out of the former routes/home.ts and
 * routes/catalog.ts (deleted once those pages cut over to React) so the JSON
 * API (routes/apiPages.ts) has one shaping implementation to call. Each
 * helper returns exactly the keys its page needs.
 */
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { activeFlashPercent, effectiveUnitPrice, flashPrice } from "@app/core/flash";
import { parseAdditionalFields } from "@app/core/deliveryFields";
import {
  prisma,
  getSetting,
  getCategoryBySlug,
  listActiveCategories,
  listNewestCatalogProducts,
  listCatalogProducts,
  listFlashSaleProducts,
  getCatalogProductBySlugWithDenominations,
  searchCatalog,
  stockStatusCounts,
  productRatingSummaries,
  activeBulkPricingByDenomination,
  listReviews,
  featuredReviews,
  overallRating,
  shopFulfilmentStats,
  type CatalogProduct,
} from "@app/db";
import { PRODUCT_VARIANT_WIDTHS, categoryImage, productImage, webpSrcset } from "./images";
import { resolveBotUsername } from "./shop";
import { shapeProducts, sortProductCards, type SortKey } from "./cards";

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

/** Home page data — shaped for the JSON API (GET /api/v1/pages/home). */
export async function homePageData() {
  const [categories, products, stock, ratings, bulk, reviews, rating, fulfil, waNumber, heroUrl] =
    await Promise.all([
      listActiveCategories(prisma),
      listNewestCatalogProducts(prisma, 12),
      stockStatusCounts(prisma),
      productRatingSummaries(prisma),
      activeBulkPricingByDenomination(prisma),
      featuredReviews(prisma, 4),
      overallRating(prisma),
      shopFulfilmentStats(prisma),
      // WhatsApp button on the contact section — set in web-admin Settings ›
      // Website; empty/unset hides the button.
      getSetting(prisma, "support_whatsapp"),
      // Hero banner — admin-uploaded image overrides the gradient default.
      getSetting(prisma, "web_hero_url"),
    ]);
  const ratingByDenom = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
  const cards = shapeProducts(products, stock, ratingByDenom, bulk);

  // Honest home-page figures: only show real numbers once a handful of orders
  // have actually shipped; before that the band falls back to value props so
  // we never display "0 customers". Satisfaction = visible-review average.
  const stats = {
    has_data: fulfil.deliveredOrders >= 5,
    customers: fulfil.customers,
    orders: fulfil.deliveredOrders,
    satisfaction: rating.count > 0 && rating.avg ? Math.round((rating.avg / 5) * 100) : null,
  };

  // Real testimonials from delivered-order reviews (≥4★ with a comment).
  const testimonials = reviews
    .filter((r) => (r.comment ?? "").trim().length > 0)
    .map((r) => {
      const name = reviewerName(r.user);
      return {
        name,
        initial: name.charAt(0).toUpperCase() || "?",
        product: r.product.name,
        rating: r.rating,
        comment: r.comment!.trim(),
      };
    });

  return {
    hero_image: heroUrl || null,
    categories: categories.map((c) => ({ ...c, image: categoryImage(c.name) })),
    products: cards,
    stats,
    testimonials,
    low_threshold: config.LOW_STOCK_THRESHOLD,
    bot_username: await resolveBotUsername(),
    wa_number: (waNumber ?? "").replace(/[^0-9]/g, ""),
  };
}

/** Category page data, or null for the 404 branch (GET /api/v1/pages/category/:slug). */
export async function categoryPageData(rawSlug: string, sort: SortKey = "default") {
  const slug = (rawSlug ?? "").trim();
  const category = slug ? await getCategoryBySlug(prisma, slug) : null;
  if (!category || !category.isActive) return null;
  const [categories, products, stock, ratings, bulk] = await Promise.all([
    listActiveCategories(prisma),
    listCatalogProducts(prisma, category.id),
    stockStatusCounts(prisma),
    productRatingSummaries(prisma),
    activeBulkPricingByDenomination(prisma),
  ]);
  const ratingByDenom = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
  // Same shaper as /search & home — one source of truth for grid cards.
  const cards = shapeProducts(products, stock, ratingByDenom, bulk);
  return {
    category,
    categories,
    products: sortProductCards(products, cards, sort),
    low_threshold: config.LOW_STOCK_THRESHOLD,
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
export async function productPageData(rawSlug: string, isReseller = false) {
  const slug = (rawSlug ?? "").trim();
  const product = slug ? await getCatalogProductBySlugWithDenominations(prisma, slug) : null;
  if (!product || !product.isActive || product.isArchived || product.denominations.length === 0) return null;

  // Per-denomination stock + bulk-pricing badge (price-asc order preserved).
  const [stock, bulkRules, reviews, sameCategoryProducts, ratings] = await Promise.all([
    stockStatusCounts(prisma),
    activeBulkPricingByDenomination(prisma),
    // Reviews are tied to the specific denomination the customer bought —
    // gather across every active denomination of this Product, not just
    // the cheapest, or reviews left on other plans silently disappear.
    listReviews(prisma, { productId: product.denominations.map((d) => d.id), hidden: false, limit: 10 }),
    // STO-011 "You might also like" — same category, current product excluded below.
    listCatalogProducts(prisma, product.categoryId),
    productRatingSummaries(prisma),
  ]);

  const catName = product.category.name;
  const denominations = product.denominations.map((d) => {
    const available = stock[d.id]?.available ?? 0;
    const rule = bulkRules[d.id];
    const salePrice = flashPrice(d);
    const unit = effectiveUnitPrice(d, isReseller);
    // Badge only when the flash price is the one this viewer actually gets —
    // the same rule flashViewFor applies to a cart line.
    const flashPct = salePrice !== null && unit.equals(salePrice) ? activeFlashPercent(d) : null;
    return {
      id: d.id,
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
      bulk: rule ? { min_quantity: rule.minQuantity, discount_percent: rule.discountPercent } : null,
      // Non-auto SKUs never have stock rows (Task 2 skips stock reservation
      // for them), so `available`/`in_stock` above are always 0/false by
      // design — the client gates purchasability on delivery_type instead
      // (see ProductPage.tsx's `purchasable`). additional_fields is the
      // parsed manual_with_info field spec ([] for auto/manual).
      delivery_type: d.deliveryType,
      additional_fields: parseAdditionalFields(d.additionalFields),
    };
  });
  // Default restock-form target (Task 10 fix): "first in-stock denomination,
  // else the first denomination" — the same selection order the React
  // ProductPage applies client-side, precomputed here so the initial
  // server-shaped payload already names a valid denomination id.
  // `denominations` is never empty here (guarded by the null return above).
  const defaultRestockDenominationId = (denominations.find((d) => d.in_stock) ?? denominations[0])!.id;

  // STO-011 "You might also like" — same category, current product excluded,
  // capped at a small shelf rather than the full category listing.
  const RELATED_PRODUCTS_LIMIT = 4;
  const ratingByDenom = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
  const relatedProducts = shapeProducts(
    sameCategoryProducts.filter((p) => p.id !== product.id),
    stock,
    ratingByDenom,
    bulkRules,
    isReseller,
  ).slice(0, RELATED_PRODUCTS_LIMIT);

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
      image: product.webImageUrl ?? productImage(product, catName),
      image_srcset: webpSrcset(product.webImageUrl, PRODUCT_VARIANT_WIDTHS),
    },
    denominations,
    default_restock_denomination_id: defaultRestockDenominationId,
    related_products: relatedProducts,
    reviews: reviews.map((r) => ({
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
export async function searchPageData(rawQ: string, sort: SortKey = "default") {
  const q = (rawQ ?? "").trim();
  const [products, stock, ratings, bulk] = await Promise.all([
    q ? searchCatalog(prisma, q, 24) : Promise.resolve([] as CatalogProduct[]),
    stockStatusCounts(prisma),
    productRatingSummaries(prisma),
    activeBulkPricingByDenomination(prisma),
  ]);
  const ratingByDenom = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
  const cards = shapeProducts(products, stock, ratingByDenom, bulk);
  return {
    q,
    products: sortProductCards(products, cards, sort),
    low_threshold: config.LOW_STOCK_THRESHOLD,
  };
}

/**
 * Shared tail of the two full-grid shelves below: shape a set of catalog rows
 * into sorted cards. The three companion queries (stock counts, ratings, bulk
 * rules) are catalog-wide, so they're the same work whichever shelf asked.
 */
async function shelfFrom(products: CatalogProduct[], sort: SortKey) {
  const [stock, ratings, bulk] = await Promise.all([
    stockStatusCounts(prisma),
    productRatingSummaries(prisma),
    activeBulkPricingByDenomination(prisma),
  ]);
  const ratingByDenom = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
  const cards = shapeProducts(products, stock, ratingByDenom, bulk);
  return {
    products: sortProductCards(products, cards, sort),
    low_threshold: config.LOW_STOCK_THRESHOLD,
  };
}

/** Every purchasable product — the "Browse products" shelf (GET /api/v1/pages/products). */
export async function allProductsPageData(sort: SortKey = "default") {
  return shelfFrom(await listCatalogProducts(prisma), sort);
}

/** Products with a flash sale running right now (GET /api/v1/pages/flash). An
 * empty list is a normal state — no sale is on — not an error. */
export async function flashPageData(sort: SortKey = "default") {
  return shelfFrom(await listFlashSaleProducts(prisma), sort);
}

/** The category index (GET /api/v1/pages/categories). `image` is resolved the
 * same way the homepage tiles do, so both surfaces show the same artwork. */
export async function categoriesPageData() {
  const categories = await listActiveCategories(prisma);
  return { categories: categories.map((c) => ({ ...c, image: categoryImage(c.name) })) };
}
