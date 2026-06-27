import type { FastifyInstance } from "fastify";
import { prisma, listReviews, countReviews, productRatingSummaries } from "@app/db";
import { currentAdmin } from "../../plugins/auth";

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

    return reply.send({ reviews, total, page, hasNext: offset + reviews.length < total, summaries });
  });
}
