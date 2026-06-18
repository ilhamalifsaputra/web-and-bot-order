/**
 * Catalog pages (read-only, no login): category list, product detail, search.
 * Prices render as IDR (central price) + USDT info beside it (plan.md §15).
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "@app/core/config";
import { t } from "@app/core/i18n";
import {
  prisma,
  getCategory,
  getProductWithCategory,
  listActiveCategories,
  stockStatusCounts,
  countAvailableStock,
  productRating,
  productRatingSummaries,
  getBulkPricingForProduct,
  activeBulkPricingByProduct,
  listReviews,
  listCatalogEntries,
  getGroupWithActiveProducts,
  searchCatalogEntries,
  type CatalogEntry,
} from "@app/db";
import { productImage } from "../images";
import { shopContext } from "../shop";
import { shapeEntries } from "../cards";

const catalogRoutes: FastifyPluginAsync = async (app) => {
  // Category listing.
  app.get<{ Params: { id: string } }>("/c/:id", async (req, reply) => {
    const categoryId = Number(req.params.id);
    const category = Number.isInteger(categoryId) ? await getCategory(prisma, categoryId) : null;
    const ctx = await shopContext(req, "/c");
    if (!category || !category.isActive) {
      return reply.code(404).view("error.njk", {
        ...ctx,
        status_code: 404,
        message: t("web.not_found", ctx.lang),
      });
    }
    const [categories, entries, stock, ratings, bulk] = await Promise.all([
      listActiveCategories(prisma),
      listCatalogEntries(prisma, category.id),
      stockStatusCounts(prisma),
      productRatingSummaries(prisma),
      activeBulkPricingByProduct(prisma),
    ]);
    const ratingByProduct = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
    const catName = new Map(categories.map((c) => [c.id, c.name]));
    // Same shaper as /search & home — one source of truth for grid cards (A-04).
    const cards = shapeEntries(entries, catName, stock, ratingByProduct, bulk);

    return reply.view("catalog.njk", {
      ...ctx,
      category,
      categories,
      groups: cards.groups,
      products: cards.products,
      low_threshold: config.LOW_STOCK_THRESHOLD,
    });
  });

  // Group (denomination) detail.
  app.get<{ Params: { id: string } }>("/g/:id", async (req, reply) => {
    const groupId = Number(req.params.id);
    const ctx = await shopContext(req, "/g");
    const group = Number.isInteger(groupId) ? await getGroupWithActiveProducts(prisma, groupId) : null;
    if (!group || !group.isActive || group.products.length === 0) {
      return reply.code(404).view("error.njk", {
        ...ctx,
        status_code: 404,
        message: t("web.not_found", ctx.lang),
      });
    }
    const category = await getCategory(prisma, group.categoryId);
    return reply.view("group.njk", {
      ...ctx,
      group: { id: group.id, name: group.name, emoji: group.emoji, description: group.description },
      denominations: group.products.map((p) => ({
        id: p.id,
        duration_label: p.durationLabel,
        name: p.name,
        price: p.price.toString(),
        image: group.webImageUrl ?? productImage(p, category ? category.name : ""),
      })),
    });
  });

  // Product detail.
  app.get<{ Params: { id: string } }>("/p/:id", async (req, reply) => {
    const productId = Number(req.params.id);
    const product = Number.isInteger(productId)
      ? await getProductWithCategory(prisma, productId)
      : null;
    const ctx = await shopContext(req, "/p");
    if (!product || !product.isActive) {
      return reply.code(404).view("error.njk", {
        ...ctx,
        status_code: 404,
        message: t("web.not_found", ctx.lang),
      });
    }
    const [available, rating, bulk, reviews] = await Promise.all([
      countAvailableStock(prisma, product.id),
      productRating(prisma, product.id),
      getBulkPricingForProduct(prisma, product.id),
      listReviews(prisma, { productId: product.id, hidden: false, limit: 10 }),
    ]);
    return reply.view("product.njk", {
      ...ctx,
      product: {
        id: product.id,
        name: product.name,
        description: product.description,
        category_name: product.category.name,
        duration_label: product.durationLabel,
        warranty_days: product.warrantyDays,
        price: product.price.toString(),
        image: productImage(product, product.category.name),
      },
      available,
      rating: rating.avg,
      rating_count: rating.count,
      bulk: bulk
        ? { min_quantity: bulk.minQuantity, discount_percent: bulk.discountPercent.toString() }
        : null,
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

  // Search.
  app.get<{ Querystring: { q?: string } }>("/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    const ctx = await shopContext(req, "/search");
    const [entries, categories, stock, ratings, bulk] = await Promise.all([
      q ? searchCatalogEntries(prisma, q, 24) : Promise.resolve([] as CatalogEntry[]),
      listActiveCategories(prisma),
      stockStatusCounts(prisma),
      productRatingSummaries(prisma),
      activeBulkPricingByProduct(prisma),
    ]);
    const ratingByProduct = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
    const catName = new Map(categories.map((c) => [c.id, c.name]));
    const cards = shapeEntries(entries, catName, stock, ratingByProduct, bulk);
    return reply.view("search.njk", {
      ...ctx,
      q,
      groups: cards.groups,
      products: cards.products,
      low_threshold: config.LOW_STOCK_THRESHOLD,
    });
  });
};

export default catalogRoutes;
