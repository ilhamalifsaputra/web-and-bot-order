/**
 * Stock — per-product overview, bulk add, mark dead, edit note.
 * Port of routers/stock.py. Never logs raw credentials.
 */
import type { FastifyInstance } from "fastify";
import { logger } from "@app/core/logger";
import {
  prisma,
  listAllProducts,
  stockStatusCounts,
  getProduct,
  listStockItemsForProduct,
  countAvailableStock,
  bulkAddStock,
  getStockItem,
  markStockDead,
  setStockNote,
  restockSubscriberCounts,
  countRestockSubscribers,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash, renderError } from "../flash";

export default async function stockRoutes(app: FastifyInstance): Promise<void> {
  app.get("/stock", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const products = await listAllProducts(prisma);
    const counts = await stockStatusCounts(prisma);
    const waiting = await restockSubscriberCounts(prisma);

    // Group products by category name for the table.
    const groups: Record<string, typeof products> = {};
    for (const p of products) {
      const catName = p.category ? p.category.name : "Uncategorized";
      (groups[catName] ??= []).push(p);
    }

    return reply.view("stock.njk", {
      admin: req.admin,
      active_nav: "/stock",
      groups,
      counts,
      waiting,
      products,
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  app.get("/stock/:productId", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const productId = Number((req.params as { productId: string }).productId);
    const product = await getProduct(prisma, productId);
    if (!product) {
      return renderError(reply, { statusCode: 404, title: "Not found", message: "Product not found." });
    }
    const items = await listStockItemsForProduct(prisma, productId, 500);
    const available = await countAvailableStock(prisma, productId);
    const waiting = await countRestockSubscribers(prisma, productId);

    return reply.view("stock_product.njk", {
      admin: req.admin,
      active_nav: "/stock",
      product,
      items,
      available,
      waiting,
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  app.post("/stock/:productId/add", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const raw = (req.body as Record<string, string>).credentials ?? "";
    const creds = raw.split(/\r?\n/).map((ln) => ln.trim()).filter(Boolean);
    if (creds.length === 0) {
      return redirectWithFlash(reply, `/stock/${productId}`, "No credentials provided.", "error");
    }
    const product = await getProduct(prisma, productId);
    if (!product) return redirectWithFlash(reply, "/stock", "Product not found.", "error");

    const added = await bulkAddStock(prisma, productId, creds);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_upload",
      targetType: "product",
      targetId: productId,
      details: `added=${added}`, // never log the credentials themselves
    });
    logger.info(`Bulk-added ${added} stock rows to product ${productId}`);
    return redirectWithFlash(reply, `/stock/${productId}`, `Added ${added} stock item(s).`, "success");
  });

  app.post("/stock/item/:stockId/dead", { preHandler: csrfProtect }, async (req, reply) => {
    const stockId = Number((req.params as { stockId: string }).stockId);
    const note = ((req.body as Record<string, string>).note ?? "").trim();
    const item = await getStockItem(prisma, stockId);
    if (!item) return redirectWithFlash(reply, "/stock", "Stock item not found.", "error");

    await markStockDead(prisma, stockId, note || "marked dead via web");
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_mark_dead",
      targetType: "stock_item",
      targetId: stockId,
      details: `note=${note.slice(0, 200)}`,
    });
    return redirectWithFlash(reply, `/stock/${item.productId}`, `Stock item #${stockId} marked dead.`, "success");
  });

  app.post("/stock/item/:stockId/note", { preHandler: csrfProtect }, async (req, reply) => {
    const stockId = Number((req.params as { stockId: string }).stockId);
    const note = ((req.body as Record<string, string>).note ?? "").trim();
    const item = await getStockItem(prisma, stockId);
    if (!item) return redirectWithFlash(reply, "/stock", "Stock item not found.", "error");

    await setStockNote(prisma, stockId, note || null);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_edit_note",
      targetType: "stock_item",
      targetId: stockId,
      details: `note=${note.slice(0, 200)}`,
    });
    return redirectWithFlash(reply, `/stock/${item.productId}`, `Note updated on item #${stockId}.`, "success");
  });
}
