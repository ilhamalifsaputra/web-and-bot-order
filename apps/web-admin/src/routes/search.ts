/**
 * Global search / quick-jump — WEB.md roadmap Tier 3 §13. One box resolves an
 * order by code, a user by TG id / username / name, or a product by name, and
 * either jumps straight to a unique order match or renders a grouped results
 * page. Read-only; reuses existing crud (no new helpers).
 */
import type { FastifyInstance } from "fastify";
import {
  prisma,
  getOrderByCode,
  searchUsers,
  searchDenominations,
} from "@app/db";
import { currentAdmin } from "../plugins/auth";

export default async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/search", { preHandler: currentAdmin }, async (req, reply) => {
    const q = ((req.query as Record<string, string | undefined>).q ?? "").trim();
    if (!q) {
      return reply.view("search.njk", { admin: req.admin, active_nav: "/search", q: "", order: null, users: [], products: [] });
    }

    // Fast path: an exact order code → jump straight to the order detail.
    const exact = await getOrderByCode(prisma, q);
    if (exact) {
      return reply.redirect(`/orders/${exact.id}`, 302);
    }

    const order = await getOrderByCode(prisma, q.toUpperCase());
    if (order) return reply.redirect(`/orders/${order.id}`, 302);

    const users = await searchUsers(prisma, q, 25);
    const products = await searchDenominations(prisma, q, 25);

    return reply.view("search.njk", {
      admin: req.admin,
      active_nav: "/search",
      q,
      order: null,
      users,
      products,
    });
  });
}
