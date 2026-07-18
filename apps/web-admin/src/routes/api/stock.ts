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
  bulkMarkStockDead,
  bulkDeleteStock,
  listAvailableCredentials,
  getStockItem,
  markStockDead,
  setStockNote,
  restockSubscriberCounts,
  logAdminAction,
  enqueueRestockBroadcast,
  updateDenomination,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { displayDate } from "../../dateDisplay";

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
    // Stock items are timestamped `addedAt` in the DB/crud layer (not
    // `createdAt`) — the client's "Added" column had been reading a
    // nonexistent `createdAt` field (always undefined → Invalid Date).
    // Fixed here alongside adding the pre-formatted display string.
    const itemsWithDisplay = items.map((i) => ({ ...i, createdAtDisplay: displayDate(i.addedAt) }));
    return reply.send({ product, items: itemsWithDisplay, available, waiting });
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

    const { added, skipped } = await prisma.$transaction((tx) => bulkAddStock(tx, productId, creds));
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

    // Broadcast to ALL non-banned customers, separate from and in addition
    // to the RestockSubscription opt-in DM — only when the admin turned the
    // per-product flag on. The web NEVER sends Telegram itself; this just
    // enqueues rows for the notifier/bot to deliver.
    if (added > 0 && product.broadcastOnRestock) {
      const stockCount = await countAvailableStock(prisma, productId);
      const notified = await enqueueRestockBroadcast(prisma, {
        productName: product.name,
        stockCount,
        createdById: req.admin!.userId,
      });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "restock_broadcast",
        targetType: "product",
        targetId: productId,
        details: `Queued a restock broadcast for "${product.name}" to ${notified} customers.`,
      });
    }

    const message =
      skipped > 0
        ? `Added ${added} stock item(s). Skipped ${skipped} duplicate(s).`
        : `Added ${added} stock item(s).`;
    return reply.send({ ok: true, added, skipped, message });
  });

  // Toggle the "broadcast to all customers when I add stock" flag on this
  // product (default off). Separate small endpoint, same shape as the
  // isActive toggle at POST /api/catalog/denominations/:id/active.
  app.post("/api/stock/:productId/broadcast", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean." });
    }
    const product = await getDenominationWithProduct(prisma, productId);
    if (!product) return reply.code(404).send({ error: "Product not found." });

    await updateDenomination(prisma, productId, { broadcastOnRestock: body.enabled });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_broadcast_toggle",
      targetType: "product",
      targetId: productId,
      details: `${body.enabled ? "Enabled" : "Disabled"} restock broadcast for "${product.name}".`,
    });
    return reply.send({ ok: true, broadcastOnRestock: body.enabled });
  });

  // Bulk mark selected stock items dead (one writer, audited once). Never logs
  // credentials — only the count and ids.
  app.post("/api/stock/:productId/bulk-dead", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? body.ids.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) return reply.code(400).send({ error: "Select at least one stock item." });
    const note = (typeof body.note === "string" ? body.note.trim() : "") || "bulk marked dead via web";

    const count = await bulkMarkStockDead(prisma, ids, note);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_bulk_dead",
      targetType: "product",
      targetId: productId,
      details: `Marked ${count} stock items dead. Note: "${note.slice(0, 160)}".`, // never the credentials
    });
    logger.info(`Bulk-marked ${count} stock items dead on product ${productId}`);
    return reply.send({ ok: true, count });
  });

  // Hard-delete selected stock items (one writer, audited once). The crud guard
  // refuses SOLD rows and anything tied to an order item, so the count returned
  // may be < the number selected.
  app.post("/api/stock/:productId/bulk-delete", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? body.ids.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) return reply.code(400).send({ error: "Select at least one stock item." });

    const count = await bulkDeleteStock(prisma, ids);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_bulk_delete",
      targetType: "product",
      targetId: productId,
      details: `Deleted ${count} of ${ids.length} requested stock items.`, // never the credentials
    });
    logger.info(`Bulk-deleted ${count} stock items on product ${productId}`);
    return reply.send({ ok: true, count, skipped: ids.length - count });
  });

  app.post("/api/stock/item/:stockId/dead", { preHandler: csrfProtect }, async (req, reply) => {
    const stockId = Number((req.params as { stockId: string }).stockId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const note = (typeof body.note === "string" ? body.note.trim() : "");
    const item = await getStockItem(prisma, stockId);
    if (!item) return reply.code(404).send({ error: "Stock item not found." });

    await markStockDead(prisma, stockId, note || "marked dead via web");
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_mark_dead",
      targetType: "stock_item",
      targetId: stockId,
      details: `Marked stock item dead. Note: "${note.slice(0, 200)}".`, // never the credentials
    });
    return reply.send({ ok: true });
  });

  app.post("/api/stock/item/:stockId/note", { preHandler: csrfProtect }, async (req, reply) => {
    const stockId = Number((req.params as { stockId: string }).stockId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const note = (typeof body.note === "string" ? body.note.trim() : "");
    const item = await getStockItem(prisma, stockId);
    if (!item) return reply.code(404).send({ error: "Stock item not found." });

    await setStockNote(prisma, stockId, note || null);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_edit_note",
      targetType: "stock_item",
      targetId: stockId,
      details: `Updated stock item note to: "${note.slice(0, 200)}".`, // never the credentials
    });
    return reply.send({ ok: true });
  });

  // Download remaining (AVAILABLE) credentials as a plain-text file, one login
  // per line. Read-only, so currentAdmin (not csrfProtect); still audited by
  // count. The credentials themselves are never logged.
  app.get("/api/stock/:productId/download", { preHandler: currentAdmin }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const product = await getDenominationWithProduct(prisma, productId);
    if (!product) return reply.code(404).send({ error: "Product not found." });

    const creds = await listAvailableCredentials(prisma, productId);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_download",
      targetType: "product",
      targetId: productId,
      details: `Downloaded ${creds.length} available credentials.`, // never the credentials
    });
    const slug = product.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "stock";
    const body = creds.length ? creds.join("\n") + "\n" : "";
    return reply
      .header("Content-Type", "text/plain; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="stock-${slug}-${productId}.txt"`)
      .header("Cache-Control", "no-store")
      .send(body);
  });
}
