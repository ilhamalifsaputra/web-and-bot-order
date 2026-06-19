/**
 * Catalog pages (read-only, no login), 3-tier flow Category → Product →
 * Denomination on slug URLs:
 *   - `/c/:slug`  category page — Product cards only (never denomination rows);
 *   - `/p/:slug`  product detail — denomination cards (Buy Now / Add To Cart);
 *   - `/search`   products only (variants are chosen inside product detail).
 * Prices render as IDR (central price) + USDT info beside it (plan.md §15). The
 * card "starting price" is the cheapest active denomination.
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { t } from "@app/core/i18n";
import {
  prisma,
  getCategoryBySlug,
  listActiveCategories,
  listCatalogProducts,
  getCatalogProductBySlugWithDenominations,
  searchCatalog,
  stockStatusCounts,
  productRatingSummaries,
  activeBulkPricingByDenomination,
  listReviews,
  type CatalogProduct,
} from "@app/db";
import { productImage } from "../images";
import { shopContext } from "../shop";
import { shapeProducts } from "../cards";

const catalogRoutes: FastifyPluginAsync = async (app) => {
  // ---- Category page — Product cards only ----
  app.get<{ Params: { slug: string } }>("/c/:slug", async (req, reply) => {
    const slug = (req.params.slug ?? "").trim();
    const category = slug ? await getCategoryBySlug(prisma, slug) : null;
    const ctx = await shopContext(req, "/c");
    if (!category || !category.isActive) {
      return reply.code(404).view("error.njk", {
        ...ctx,
        status_code: 404,
        message: t("web.not_found", ctx.lang),
      });
    }
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

    return reply.view("catalog.njk", {
      ...ctx,
      category,
      categories,
      products: cards,
      low_threshold: config.LOW_STOCK_THRESHOLD,
    });
  });

  // ---- Product detail — denomination cards + Buy Now / Add To Cart ----
  app.get<{ Params: { slug: string } }>("/p/:slug", async (req, reply) => {
    const slug = (req.params.slug ?? "").trim();
    const product = slug ? await getCatalogProductBySlugWithDenominations(prisma, slug) : null;
    const ctx = await shopContext(req, "/p");
    if (!product || !product.isActive || product.denominations.length === 0) {
      return reply.code(404).view("error.njk", {
        ...ctx,
        status_code: 404,
        message: t("web.not_found", ctx.lang),
      });
    }

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
      };
    });

    return reply.view("product.njk", {
      ...ctx,
      product: {
        slug: product.slug,
        name: product.name,
        description: product.description,
        category_name: catName,
        category_slug: product.category.slug,
        image: product.webImageUrl ?? productImage(product, catName),
      },
      denominations,
      reviews: reviews.map((r) => ({
        rating: r.rating,
        comment: r.comment,
        // Mask the reviewer: first letter + *** (never leak usernames).
        author: `${(r.user.fullName ?? r.user.username ?? "A").slice(0, 1)}***`,
        created_at: r.createdAt,
      })),
      low_threshold: config.LOW_STOCK_THRESHOLD,
    });
  });

  // ---- Search — products only ----
  app.get<{ Querystring: { q?: string } }>("/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    const ctx = await shopContext(req, "/search");
    const [products, stock, ratings, bulk] = await Promise.all([
      q ? searchCatalog(prisma, q, 24) : Promise.resolve([] as CatalogProduct[]),
      stockStatusCounts(prisma),
      productRatingSummaries(prisma),
      activeBulkPricingByDenomination(prisma),
    ]);
    const ratingByDenom = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
    const cards = shapeProducts(products, stock, ratingByDenom, bulk);
    return reply.view("search.njk", {
      ...ctx,
      q,
      products: cards,
      low_threshold: config.LOW_STOCK_THRESHOLD,
    });
  });
};

export default catalogRoutes;
