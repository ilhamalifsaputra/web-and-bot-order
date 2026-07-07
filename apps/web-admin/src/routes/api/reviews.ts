import type { FastifyInstance } from "fastify";
import { prisma, listReviews, countReviews, productRatingSummaries, setReviewHidden, getReviewById, logAdminAction } from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { displayDate } from "../../dateDisplay";

const PAGE_SIZE = 50;

export default async function reviewsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/reviews", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const productId = q.product && /^\d+$/.test(q.product) ? Number(q.product) : null;
    const hidden = q.hidden === "1" ? true : q.hidden === "0" ? false : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const filter = { productId, hidden };
    const [reviews, total, summaries] = await Promise.all([
      listReviews(prisma, { ...filter, limit: PAGE_SIZE, offset }),
      countReviews(prisma, filter),
      productRatingSummaries(prisma),
    ]);

    const reviewsWithDisplay = reviews.map((r) => ({ ...r, createdAtDisplay: displayDate(r.createdAt) }));
    return reply.send({ reviews: reviewsWithDisplay, total, page, hasNext: offset + reviews.length < total, summaries });
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
    await setReviewHidden(prisma, reviewId, hide);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: hide ? "review_hide" : "review_unhide",
      targetType: "review",
      targetId: reviewId,
    });
    return reply.send({ ok: true, hidden: hide });
  });
}
