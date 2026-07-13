/**
 * Page view-models for the public catalog pages (home / category / product /
 * search) — lifted verbatim out of the former routes/home.ts and
 * routes/catalog.ts (deleted once those pages cut over to React) so the JSON
 * API (routes/apiPages.ts) has one shaping implementation to call. Each
 * helper returns exactly the keys its page needs.
 */
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { parseAdditionalFields } from "@app/core/deliveryFields";
import {
  prisma,
  getSetting,
  getCategoryBySlug,
  listActiveCategories,
  listNewestCatalogProducts,
  listCatalogProducts,
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
import { categoryImage, productImage } from "./images";
import { resolveBotUsername } from "./shop";
import { shapeProducts } from "./cards";

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
export async function categoryPageData(rawSlug: string) {
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
    products: cards,
    low_threshold: config.LOW_STOCK_THRESHOLD,
  };
}

/** Product detail page data, or null for the 404 branch (GET
 * /api/v1/pages/product/:slug). Reviews keep their Date here — the JSON
 * route (routes/apiPages.ts) pre-formats it with the same localize() the
 * Nunjucks localdt filter used to, so callers get a display string, not a
 * raw Date to serialize themselves. */
export async function productPageData(rawSlug: string) {
  const slug = (rawSlug ?? "").trim();
  const product = slug ? await getCatalogProductBySlugWithDenominations(prisma, slug) : null;
  if (!product || !product.isActive || product.denominations.length === 0) return null;

  // Per-denomination stock + bulk-pricing badge (price-asc order preserved).
  const [stock, bulkRules, reviews] = await Promise.all([
    stockStatusCounts(prisma),
    activeBulkPricingByDenomination(prisma),
    // Reviews are tied to the specific denomination the customer bought —
    // gather across every active denomination of this Product, not just
    // the cheapest, or reviews left on other plans silently disappear.
    listReviews(prisma, { productId: product.denominations.map((d) => d.id), hidden: false, limit: 10 }),
  ]);

  const catName = product.category.name;
  const denominations = product.denominations.map((d) => {
    const available = stock[d.id]?.available ?? 0;
    const rule = bulkRules[d.id];
    return {
      id: d.id,
      name: d.name,
      duration_label: d.durationLabel,
      price: new Decimal(d.price).toString(),
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

  return {
    product: {
      slug: product.slug,
      name: product.name,
      description: product.description,
      category_name: catName,
      category_slug: product.category.slug,
      image: product.webImageUrl ?? productImage(product, catName),
    },
    denominations,
    default_restock_denomination_id: defaultRestockDenominationId,
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
export async function searchPageData(rawQ: string) {
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
    products: cards,
    low_threshold: config.LOW_STOCK_THRESHOLD,
  };
}
