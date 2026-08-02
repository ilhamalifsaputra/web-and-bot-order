import type { FastifyInstance } from "fastify";
import { ReviewStatus, ReviewSentiment, ReviewSource } from "@app/core/enums";
import {
  prisma,
  listReviews,
  countReviews,
  productRatingSummaries,
  setReviewHidden,
  getReviewById,
  getDenomination,
  logAdminAction,
  reviewsKpis,
  replyToReview,
  deleteReviewReply,
  setReviewStatus,
  deleteReview,
  type ReviewFilter,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { displayDate } from "../../dateDisplay";

const PAGE_SIZE = 50;
const STATUS_VALUES = Object.values(ReviewStatus) as string[];
const SENTIMENT_VALUES = Object.values(ReviewSentiment) as string[];
const SOURCE_VALUES = Object.values(ReviewSource) as string[];
// Manual status transitions only — REPLIED is exclusively set via the
// /reply route (replyToReview), never via this route directly.
const MANUAL_STATUS_VALUES = [ReviewStatus.PENDING_REPLY, ReviewStatus.CLOSED] as string[];

/** Shared by the list route so the filter can't silently diverge from what
 * the query params say — mirrors support.ts's buildTicketFilter. */
function buildReviewFilter(q: Record<string, string | undefined>): ReviewFilter {
  const productId = q.product && /^\d+$/.test(q.product) ? Number(q.product) : null;
  const hidden = q.hidden === "1" ? true : q.hidden === "0" ? false : null;
  const rating = q.rating && /^[1-5]$/.test(q.rating) ? Number(q.rating) : null;
  const status = q.status && STATUS_VALUES.includes(q.status) ? q.status : null;
  const sentiment = q.sentiment && SENTIMENT_VALUES.includes(q.sentiment) ? q.sentiment : null;
  const source = q.source && SOURCE_VALUES.includes(q.source) ? q.source : null;
  const since = q.since && !Number.isNaN(Date.parse(q.since)) ? new Date(q.since) : null;
  const until = q.until && !Number.isNaN(Date.parse(q.until)) ? new Date(q.until) : null;
  const search = q.q?.trim() || null;
  return { productId, hidden, rating, status, sentiment, source, since, until, search };
}

export default async function reviewsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/reviews", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const filter = buildReviewFilter(q);
    const [reviews, total, summaries] = await Promise.all([
      listReviews(prisma, { ...filter, limit: PAGE_SIZE, offset }),
      countReviews(prisma, filter),
      productRatingSummaries(prisma),
    ]);

    const reviewsWithDisplay = reviews.map((r) => ({ ...r, createdAtDisplay: displayDate(r.createdAt) }));
    return reply.send({ reviews: reviewsWithDisplay, total, page, hasNext: offset + reviews.length < total, summaries });
  });

  // Global snapshot for the Reviews page's KPI row — mirrors GET /api/users/kpis.
  app.get("/api/reviews/kpis", { preHandler: currentAdmin }, async (_req, reply) => {
    const kpis = await reviewsKpis(prisma);
    return reply.send(kpis);
  });

  // JSON counterpart of the legacy POST /reviews/:reviewId/hide
  // (routes/reviews.ts) — see api/outbox.ts's retry route for why a parallel
  // JSON route exists instead of reusing the legacy 303-redirect one.
  app.post("/api/reviews/:reviewId/hide", { preHandler: csrfProtect }, async (req, reply) => {
    const reviewId = Number((req.params as { reviewId: string }).reviewId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.hidden !== "boolean") return reply.code(400).send({ error: "hidden must be a boolean." });
    const hide = body.hidden;
    const existing = await getReviewById(prisma, reviewId);
    if (!existing) return reply.code(404).send({ error: "Review not found." });
    const product = await getDenomination(prisma, existing.productId);
    await setReviewHidden(prisma, reviewId, hide);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: hide ? "review_hide" : "review_unhide",
      targetType: "review",
      targetId: reviewId,
      details: `${hide ? "Hid" : "Unhid"} a ${existing.rating}-star review for "${product?.name ?? "an unknown product"}".`,
    });
    return reply.send({ ok: true, hidden: hide });
  });

  // Save (or overwrite) the admin's reply — flips the review to REPLIED.
  app.post("/api/reviews/:reviewId/reply", { preHandler: csrfProtect }, async (req, reply) => {
    const reviewId = Number((req.params as { reviewId: string }).reviewId);
    const replyText = ((req.body as Record<string, unknown>)?.reply as string | undefined)?.trim() ?? "";
    if (!replyText) return reply.code(400).send({ error: "Reply cannot be empty." });
    const existing = await getReviewById(prisma, reviewId);
    if (!existing) return reply.code(404).send({ error: "Review not found." });
    const product = await getDenomination(prisma, existing.productId);
    const isEdit = existing.adminReply != null;
    await replyToReview(prisma, reviewId, { reply: replyText, adminId: req.admin!.userId });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: isEdit ? "review_reply_edit" : "review_reply",
      targetType: "review",
      targetId: reviewId,
      details: `${isEdit ? "Edited the reply to" : "Replied to"} a ${existing.rating}-star review for "${product?.name ?? "an unknown product"}".`,
    });
    return reply.send({ ok: true });
  });

  // Clears a review's reply and reverts it to PENDING_REPLY.
  app.delete("/api/reviews/:reviewId/reply", { preHandler: csrfProtect }, async (req, reply) => {
    const reviewId = Number((req.params as { reviewId: string }).reviewId);
    const existing = await getReviewById(prisma, reviewId);
    if (!existing || existing.adminReply == null) return reply.code(404).send({ error: "Review not found or has no reply." });
    const product = await getDenomination(prisma, existing.productId);
    await deleteReviewReply(prisma, reviewId);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "review_reply_delete",
      targetType: "review",
      targetId: reviewId,
      details: `Deleted the reply to a ${existing.rating}-star review for "${product?.name ?? "an unknown product"}".`,
    });
    return reply.send({ ok: true });
  });

  // Manual CLOSED/PENDING_REPLY transition — REPLIED is only ever reached via
  // the /reply route above, so it's rejected here even though setReviewStatus
  // itself doesn't guard against it.
  app.post("/api/reviews/:reviewId/status", { preHandler: csrfProtect }, async (req, reply) => {
    const reviewId = Number((req.params as { reviewId: string }).reviewId);
    const status = (req.body as Record<string, unknown>)?.status as string | undefined;
    if (!status || !MANUAL_STATUS_VALUES.includes(status)) {
      return reply.code(400).send({ error: 'status must be "CLOSED" or "PENDING_REPLY".' });
    }
    const existing = await getReviewById(prisma, reviewId);
    if (!existing) return reply.code(404).send({ error: "Review not found." });
    const product = await getDenomination(prisma, existing.productId);
    await setReviewStatus(prisma, reviewId, status);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "review_status_change",
      targetType: "review",
      targetId: reviewId,
      details: `Set a ${existing.rating}-star review for "${product?.name ?? "an unknown product"}" to ${status === ReviewStatus.CLOSED ? "Closed" : "Pending Reply"}.`,
    });
    return reply.send({ ok: true });
  });

  // Hard delete — no soft-delete/undo, matches the brief.
  app.delete("/api/reviews/:reviewId", { preHandler: csrfProtect }, async (req, reply) => {
    const reviewId = Number((req.params as { reviewId: string }).reviewId);
    const existing = await getReviewById(prisma, reviewId);
    if (!existing) return reply.code(404).send({ error: "Review not found." });
    const product = await getDenomination(prisma, existing.productId);
    await deleteReview(prisma, reviewId);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "review_delete",
      targetType: "review",
      targetId: reviewId,
      details: `Deleted a ${existing.rating}-star review for "${product?.name ?? "an unknown product"}".`,
    });
    return reply.send({ ok: true });
  });
}
