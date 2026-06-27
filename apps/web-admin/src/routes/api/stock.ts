import type { FastifyInstance } from "fastify";
import { logger } from "@app/core/logger";
import {
  prisma,
  listAllDenominations,
  stockStatusCounts,
  getDenominationWithProduct,
  listStockItemsForProduct,
  countAvailableStock,
  countRestockSubscribers,
  bulkAddStock,
  restockSubscriberCounts,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";

export default async function stockApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/stock", { preHandler: currentAdmin }, async (req, reply) => {
    const [denominations, counts, waiting] = await Promise.all([
      listAllDenominations(prisma),
      stockStatusCounts(prisma),
      restockSubscriberCounts(prisma),
    ]);
    return reply.send({ denominations, counts, waiting });
  });

  app.get("/api/stock/:productId", { preHandler: currentAdmin }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const product = await getDenominationWithProduct(prisma, productId);
    if (!product) return reply.code(404).send({ error: "Product not found." });
    const [items, available, waiting] = await Promise.all([
      listStockItemsForProduct(prisma, productId, 500),
      countAvailableStock(prisma, productId),
      countRestockSubscribers(prisma, productId),
    ]);
    return reply.send({ product, items, available, waiting });
  });

  app.post("/api/stock/:productId/bulk-add", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const body = (req.body ?? {}) as Record<string, string>;
    const raw = body.credentials ?? "";
    const creds = raw
      .split(/\r?\n/)
      .map((ln) => ln.trim())
      .filter(Boolean);
    if (creds.length === 0) {
      return reply.code(400).send({ error: "No credentials provided." });
    }
    const product = await getDenominationWithProduct(prisma, productId);
    if (!product) return reply.code(404).send({ error: "Product not found." });

    const { added, skipped } = await bulkAddStock(prisma, productId, creds);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_upload",
      targetType: "product",
      targetId: productId,
      details: `Added ${added} stock items; skipped ${skipped} duplicates.`,
    });
    logger.info(
      `Bulk-added ${added} stock items to product ${productId} (skipped ${skipped} duplicate lines)`,
    );
    const message =
      skipped > 0
        ? `Added ${added} stock item(s). Skipped ${skipped} duplicate(s).`
        : `Added ${added} stock item(s).`;
    return reply.send({ ok: true, added, skipped, message });
  });
}
