/**
 * Reviews + restock subscriptions — port of those sections of crud.py.
 */
import { OrderStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";

export async function createReview(
  db: Db,
  args: {
    userId: number;
    orderId: number;
    productId: number;
    rating: number;
    comment: string | null;
  },
) {
  const order = await db.order.findUnique({ where: { id: args.orderId } });
  if (!order || order.userId !== args.userId) {
    throw new ValidationError("error.order_not_found");
  }
  if (order.status !== OrderStatus.DELIVERED) {
    throw new ValidationError("error.review_requires_delivered");
  }
  try {
    return await db.review.create({
      data: {
        userId: args.userId,
        orderId: args.orderId,
        productId: args.productId,
        rating: args.rating,
        comment: args.comment,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ValidationError("error.review_already_exists");
    }
    throw e;
  }
}

/** Returns true if newly subscribed, false if already subscribed. */
export async function subscribeToRestock(
  db: Db,
  userId: number,
  productId: number,
): Promise<boolean> {
  try {
    await db.restockSubscription.create({ data: { userId, productId } });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

export function listRestockSubscribers(db: Db, productId: number) {
  return db.restockSubscription.findMany({
    where: { productId },
    include: { product: true },
  });
}

/** Number of users waiting for restock, per product id. Products with no
 * subscribers are simply absent from the map. */
export async function restockSubscriberCounts(db: Db): Promise<Record<number, number>> {
  const grouped = await db.restockSubscription.groupBy({
    by: ["productId"],
    _count: { _all: true },
  });
  const out: Record<number, number> = {};
  for (const g of grouped) out[g.productId] = g._count._all;
  return out;
}

export function countRestockSubscribers(db: Db, productId: number): Promise<number> {
  return db.restockSubscription.count({ where: { productId } });
}

// ---- Reviews moderation (web admin) --------------------------------------

export interface ReviewFilter {
  productId?: number | null;
  hidden?: boolean | null;
}

function reviewWhere(f: ReviewFilter) {
  const where: Record<string, unknown> = {};
  if (f.productId != null) where.productId = f.productId;
  if (f.hidden != null) where.hidden = f.hidden;
  return where;
}

/** Reviews with buyer + product joined, newest first, for the moderation list. */
export function listReviews(
  db: Db,
  opts: ReviewFilter & { limit?: number; offset?: number } = {},
) {
  return db.review.findMany({
    where: reviewWhere(opts),
    include: { user: true, product: true },
    orderBy: { createdAt: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 50,
  });
}

export function countReviews(db: Db, opts: ReviewFilter = {}) {
  return db.review.count({ where: reviewWhere(opts) });
}

/** Show/hide a single review. Hidden reviews are excluded from the bot's
 * public per-product rating average. Returns the updated row. */
export function setReviewHidden(db: Db, reviewId: number, hidden: boolean) {
  return db.review.update({ where: { id: reviewId }, data: { hidden } });
}

export interface ProductRatingSummary {
  productId: number;
  productName: string;
  count: number;
  hiddenCount: number;
  avg: number | null;
}

/** Per-product visible-review count + average (hidden rows excluded from the
 * average, but counted separately so the operator sees what's suppressed). */
export async function productRatingSummaries(db: Db): Promise<ProductRatingSummary[]> {
  const grouped = await db.review.groupBy({
    by: ["productId", "hidden"],
    _count: { _all: true },
    _avg: { rating: true },
  });
  const products = await db.product.findMany({ select: { id: true, name: true } });
  const nameById = new Map(products.map((p) => [p.id, p.name]));
  const byProduct = new Map<number, ProductRatingSummary>();
  for (const g of grouped) {
    const s =
      byProduct.get(g.productId) ??
      { productId: g.productId, productName: nameById.get(g.productId) ?? `#${g.productId}`, count: 0, hiddenCount: 0, avg: null };
    if (g.hidden) {
      s.hiddenCount += g._count._all;
    } else {
      s.count += g._count._all;
      s.avg = g._avg.rating;
    }
    byProduct.set(g.productId, s);
  }
  return [...byProduct.values()].sort((a, b) => b.count - a.count);
}
