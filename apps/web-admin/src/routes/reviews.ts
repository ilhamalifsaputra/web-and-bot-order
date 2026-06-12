/**
 * Reviews moderation — WEB.md roadmap Tier 2 §5. Lists reviews (rating, comment,
 * product, buyer), shows a per-product average + count, and lets the operator
 * hide/unhide abusive ones. Hidden reviews are excluded from the per-product
 * rating average the order bot shows customers (see handlers/customer.ts).
 *
 * Like every web route it never sends Telegram messages; every mutation is
 * audited.
 */
import type { FastifyInstance } from "fastify";
import {
  prisma,
  listReviews,
  countReviews,
  setReviewHidden,
  productRatingSummaries,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

const PAGE_SIZE = 50;
const truthy = (v: string | undefined) => ["1", "true", "on", "yes"].includes((v ?? "").toLowerCase());

export default async function reviewsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/reviews", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const productId = q.product && /^\d+$/.test(q.product) ? Number(q.product) : null;
    const hidden = q.hidden === "1" ? true : q.hidden === "0" ? false : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const filter = { productId, hidden };
    const reviews = await listReviews(prisma, { ...filter, limit: PAGE_SIZE, offset });
    const total = await countReviews(prisma, filter);
    const summaries = await productRatingSummaries(prisma);

    return reply.view("reviews.njk", {
      admin: req.admin,
      active_nav: "/reviews",
      reviews,
      total,
      page,
      page_size: PAGE_SIZE,
      has_next: offset + reviews.length < total,
      summaries,
      f: { product: q.product ?? "", hidden: q.hidden ?? "" },
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  app.post("/reviews/:reviewId/hide", { preHandler: csrfProtect }, async (req, reply) => {
    const reviewId = Number((req.params as { reviewId: string }).reviewId);
    const hide = truthy((req.body as Record<string, string>).hidden);
    const existing = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!existing) {
      return redirectWithFlash(reply, "/reviews", "Review not found.", "error");
    }
    await setReviewHidden(prisma, reviewId, hide);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: hide ? "review_hide" : "review_unhide",
      targetType: "review",
      targetId: reviewId,
    });
    return redirectWithFlash(reply, "/reviews", hide ? "Review hidden." : "Review restored.", "success");
  });
}
