/**
 * Reviews + restock subscriptions — port of those sections of crud.py.
 */
import { OrderStatus, ReviewStatus, ReviewSentiment } from "@app/core/enums";
import { classifyReviewSentiment } from "@app/core/reviews";
import { ValidationError } from "@app/core/errors";
import type { Prisma } from "@prisma/client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";

/** Same OR-contains search shape as crud/users.ts's `likeContains`. */
const likeContains = (q: string) => ({ contains: q });

/** Reviewer projection for the `user` join on `featuredReviews`/`listReviews`
 * — display-name fields only. These results get spread straight into
 * web-admin's `/api/reviews` JSON response (reachable by the lowest-
 * privilege `readonly` admin role) and rendered as public testimonials on
 * the storefront home/product pages, so `passwordHash` and `email` must
 * NEVER be selectable here (backend audit finding H-4; mirrors USER_SELECT
 * in crud/users.ts). Every caller of either function only ever reads
 * fullName/username/loginUsername off the joined user (ReviewsPage.tsx,
 * storefront's reviewerName()/masked-author formatting in pageData.ts) —
 * confirmed by grepping every call site before narrowing this. */
const REVIEW_USER_SELECT = {
  fullName: true,
  username: true,
  loginUsername: true,
} as const;

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
        // status/source keep their Prisma defaults (PENDING_REPLY/CUSTOMER),
        // already correct for a real customer review. sentiment has no
        // meaningful schema default (it's a migration-time placeholder), so
        // it's always set explicitly here.
        sentiment: classifyReviewSentiment(args.rating),
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

/** Subscribers waiting on restock, joined with their user (needed to DM them)
 * and filtered to `telegramId != null` — a web-only subscriber has no chat to
 * send to, so they're excluded here rather than left for every caller to
 * special-case (mirrors the `telegramId: { not: null }` filter broadcasts use,
 * see crud/broadcasts.ts / crud/notifications.ts). */
export function listRestockSubscribers(db: Db, productId: number) {
  return db.restockSubscription.findMany({
    where: { productId, user: { telegramId: { not: null } } },
    include: { product: { include: { product: true } }, user: true },
  });
}

/** Consumes one restock subscription. Callers should only call this AFTER the
 * subscriber's notification DM has actually succeeded — never as a bulk
 * pre-delete before the send loop runs — so a DM failure (rate limit, bot
 * restart mid-loop) leaves the subscription in place to retry against the
 * next restock instead of silently losing the subscriber. */
export function deleteRestockSubscription(db: Db, id: number) {
  return db.restockSubscription.delete({ where: { id } });
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

/**
 * Newest VISIBLE reviews with a written comment and a high rating (≥4) — the
 * social-proof feed shown on the storefront home. Joined with buyer + product
 * so the card can show a name + which product was reviewed. Replaces the old
 * hard-coded testimonials so nothing on the page is invented.
 */
export function featuredReviews(db: Db, limit = 6) {
  return db.review.findMany({
    where: { hidden: false, rating: { gte: 4 }, comment: { not: null } },
    include: { user: { select: REVIEW_USER_SELECT }, product: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Shop-wide visible-review average + count — the honest figure behind the
 * "satisfaction" stat on the home page. */
export async function overallRating(db: Db): Promise<{ avg: number | null; count: number }> {
  const agg = await db.review.aggregate({
    where: { hidden: false },
    _avg: { rating: true },
    _count: { id: true },
  });
  return { avg: agg._avg.rating, count: agg._count.id };
}

// ---- Reviews moderation (web admin) --------------------------------------

export interface ReviewFilter {
  /** A single denomination id, or every denomination id of a Product (a
   * review is keyed by the specific plan bought, not the parent Product —
   * pass an array to gather every review across all of a Product's plans). */
  productId?: number | number[] | null;
  hidden?: boolean | null;
  userId?: number | null;
  status?: string | null;
  sentiment?: string | null;
  source?: string | null;
  /** Exact star rating (1-5), not a >= threshold. */
  rating?: number | null;
  /** Same OR-contains shape as crud/users.ts's UserFilter.q — matches
   * `comment` or the joined user's fullName/username/loginUsername. */
  search?: string | null;
  since?: Date | null; // createdAt >=
  until?: Date | null; // createdAt <=
}

function reviewWhere(f: ReviewFilter): Prisma.ReviewWhereInput {
  const where: Prisma.ReviewWhereInput = {};
  if (f.productId != null) where.productId = Array.isArray(f.productId) ? { in: f.productId } : f.productId;
  if (f.hidden != null) where.hidden = f.hidden;
  if (f.userId != null) where.userId = f.userId;
  if (f.status != null) where.status = f.status;
  if (f.sentiment != null) where.sentiment = f.sentiment;
  if (f.source != null) where.source = f.source;
  if (f.rating != null) where.rating = f.rating;
  if (f.since != null || f.until != null) {
    where.createdAt = {};
    if (f.since != null) where.createdAt.gte = f.since;
    if (f.until != null) where.createdAt.lte = f.until;
  }
  if (f.search) {
    const term = f.search.trim();
    if (term) {
      where.OR = [
        { comment: likeContains(term) },
        { user: { fullName: likeContains(term) } },
        { user: { username: likeContains(term) } },
        { user: { loginUsername: likeContains(term) } },
      ];
    }
  }
  return where;
}

/** Reviews with buyer + product joined, newest first, for the moderation list. */
export function listReviews(
  db: Db,
  opts: ReviewFilter & { limit?: number; offset?: number } = {},
) {
  return db.review.findMany({
    where: reviewWhere(opts),
    include: { user: { select: REVIEW_USER_SELECT }, product: true },
    orderBy: { createdAt: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 50,
  });
}

export function countReviews(db: Db, opts: ReviewFilter = {}) {
  return db.review.count({ where: reviewWhere(opts) });
}

/** A single review by id, or null — the existence check behind the
 * moderation panel's show/hide toggle. */
export function getReviewById(db: Db, reviewId: number) {
  return db.review.findUnique({ where: { id: reviewId } });
}

/**
 * Public rating for a product: average + count over VISIBLE reviews only
 * (hidden reviews, suppressed by the web moderation panel, are excluded). This
 * is the single source of truth for the rating the bot shows customers.
 */
export async function productRating(
  db: Db,
  productId: number,
): Promise<{ avg: number | null; count: number }> {
  const agg = await db.review.aggregate({
    where: { productId, hidden: false },
    _avg: { rating: true },
    _count: { id: true },
  });
  return { avg: agg._avg.rating, count: agg._count.id };
}

/** Show/hide a single review. Hidden reviews are excluded from the bot's
 * public per-product rating average. Returns the updated row. */
export function setReviewHidden(db: Db, reviewId: number, hidden: boolean) {
  return db.review.update({ where: { id: reviewId }, data: { hidden } });
}

/** Save (or overwrite) the admin's reply and flip the review to REPLIED.
 * Single-message reply, not a thread — doubles as create-and-edit, so there
 * is no separate "edit reply" function. Audit-agnostic: the route layer logs
 * the admin action after this succeeds. */
export function replyToReview(
  db: Db,
  reviewId: number,
  args: { reply: string; adminId: number },
) {
  return db.review.update({
    where: { id: reviewId },
    data: {
      adminReply: args.reply,
      repliedAt: new Date(),
      repliedByAdminId: args.adminId,
      status: ReviewStatus.REPLIED,
    },
  });
}

/** Clear a review's reply and revert it to PENDING_REPLY. Audit-agnostic —
 * see replyToReview. */
export function deleteReviewReply(db: Db, reviewId: number) {
  return db.review.update({
    where: { id: reviewId },
    data: {
      adminReply: null,
      repliedAt: null,
      repliedByAdminId: null,
      status: ReviewStatus.PENDING_REPLY,
    },
  });
}

/** Manual CLOSED/PENDING_REPLY transition. The route layer must reject
 * `REPLIED` here — that value is only ever set via replyToReview.
 * Audit-agnostic — see replyToReview. */
export function setReviewStatus(db: Db, reviewId: number, status: string) {
  return db.review.update({ where: { id: reviewId }, data: { status } });
}

/** Hard delete. Audit-agnostic — see replyToReview. */
export function deleteReview(db: Db, reviewId: number) {
  return db.review.delete({ where: { id: reviewId } });
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
  // Reviews are keyed by denomination (column is `product_id`).
  const products = await db.denomination.findMany({ select: { id: true, name: true } });
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

export interface ReviewsKpis {
  totalReviews: number;
  avgRating: number | null;
  pendingReplyCount: number;
  negativeCount: number;
  hiddenCount: number;
  ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

/**
 * Reviews moderation page KPI row. Every figure is scoped to VISIBLE
 * (hidden: false) reviews except `hiddenCount` itself, which is the count of
 * suppressed reviews — mirroring `productRating`'s hidden-exclusion
 * discipline and `customersKpis`' parallel-`Promise.all` shape.
 */
export async function reviewsKpis(db: Db): Promise<ReviewsKpis> {
  const visible = { hidden: false };
  const [agg, pendingReplyCount, negativeCount, hiddenCount, ratingGroups] = await Promise.all([
    db.review.aggregate({ where: visible, _count: { id: true }, _avg: { rating: true } }),
    db.review.count({ where: { ...visible, status: ReviewStatus.PENDING_REPLY } }),
    db.review.count({ where: { ...visible, sentiment: ReviewSentiment.NEGATIVE } }),
    db.review.count({ where: { hidden: true } }),
    db.review.groupBy({ by: ["rating"], where: visible, _count: { _all: true } }),
  ]);

  const ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const g of ratingGroups) {
    if (g.rating >= 1 && g.rating <= 5) {
      ratingDistribution[g.rating as 1 | 2 | 3 | 4 | 5] = g._count._all;
    }
  }

  return {
    totalReviews: agg._count.id,
    avgRating: agg._avg.rating,
    pendingReplyCount,
    negativeCount,
    hiddenCount,
    ratingDistribution,
  };
}
