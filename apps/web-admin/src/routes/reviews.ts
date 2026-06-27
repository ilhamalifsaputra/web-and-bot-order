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
import { prisma, setReviewHidden, logAdminAction } from "@app/db";
import { csrfProtect } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

const truthy = (v: string | undefined) => ["1", "true", "on", "yes"].includes((v ?? "").toLowerCase());

export default async function reviewsRoutes(app: FastifyInstance): Promise<void> {
  // GET /reviews retired — now served by React SPA via GET /api/reviews.

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
