import type { FastifyInstance } from "fastify";
import { prisma, getOrder, getOrderByCode, searchUsers, searchDenominations } from "@app/db";
import { currentAdmin } from "../../plugins/auth";

export default async function searchApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/search", { preHandler: currentAdmin }, async (req, reply) => {
    const q = ((req.query as Record<string, string | undefined>).q ?? "").trim();
    if (!q) return reply.send({ q: "", exactOrderId: null, users: [], products: [] });

    const cleanQ = q.replace(/^#/, "").trim();

    // Exact order-code match or numeric order ID → return the id so the client can navigate directly.
    let exact =
      (await getOrderByCode(prisma, q)) ??
      (await getOrderByCode(prisma, q.toUpperCase())) ??
      (cleanQ !== q ? ((await getOrderByCode(prisma, cleanQ)) ?? (await getOrderByCode(prisma, cleanQ.toUpperCase()))) : null);

    if (!exact && /^\d+$/.test(cleanQ)) {
      const num = Number(cleanQ);
      if (Number.isSafeInteger(num) && num > 0) {
        exact = await getOrder(prisma, num);
      }
    }

    if (exact) return reply.send({ q, exactOrderId: exact.id, users: [], products: [] });

    const [users, products] = await Promise.all([
      searchUsers(prisma, q, 25),
      searchDenominations(prisma, q, 25),
    ]);

    return reply.send({ q, exactOrderId: null, users, products });
  });
}
