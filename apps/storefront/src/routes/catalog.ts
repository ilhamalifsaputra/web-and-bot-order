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
  listActiveProductsWithCategory,
  searchProductsWithCategory,
  stockStatusCounts,
  countAvailableStock,
  productRating,
  productRatingSummaries,
  getBulkPricingForProduct,
  activeBulkPricingByProduct,
  listReviews,
} from "@app/db";
import { productImage } from "../images";
import { shopContext } from "../shop";

type ProductWithCategory = NonNullable<Awaited<ReturnType<typeof getProductWithCategory>>>;

type BulkMap = Record<number, { minQuantity: number; discountPercent: string }>;

/** Shape a product row (+joined category) into the card context the grid uses. */
function card(
  p: ProductWithCategory,
  stock: Record<number, { available: number }>,
  ratings: Map<number, { avg: number | null; count: number }>,
  bulk: BulkMap = {},
) {
  return {
    id: p.id,
    name: p.name,
    category_name: p.category.name,
    price: p.price.toString(),
    image: productImage(p, p.category.name),
    available: stock[p.id]?.available ?? 0,
    rating: ratings.get(p.id)?.avg ?? null,
    rating_count: ratings.get(p.id)?.count ?? 0,
    bulk_discount: bulk[p.id]?.discountPercent ?? null,
    bulk_min_qty: bulk[p.id]?.minQuantity ?? null,
  };
}

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
    const [categories, products, stock, ratings, bulk] = await Promise.all([
      listActiveCategories(prisma),
      listActiveProductsWithCategory(prisma, category.id),
      stockStatusCounts(prisma),
      productRatingSummaries(prisma),
      activeBulkPricingByProduct(prisma),
    ]);
    const ratingByProduct = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
    return reply.view("catalog.njk", {
      ...ctx,
      category,
      categories,
      products: products.map((p) => card(p, stock, ratingByProduct, bulk)),
      low_threshold: config.LOW_STOCK_THRESHOLD,
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
    const [products, stock, ratings, bulk] = await Promise.all([
      q ? searchProductsWithCategory(prisma, q, 24) : Promise.resolve([]),
      stockStatusCounts(prisma),
      productRatingSummaries(prisma),
      activeBulkPricingByProduct(prisma),
    ]);
    const ratingByProduct = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
    return reply.view("search.njk", {
      ...ctx,
      q,
      products: products.map((p) => card(p, stock, ratingByProduct, bulk)),
      low_threshold: config.LOW_STOCK_THRESHOLD,
    });
  });
};

export default catalogRoutes;
