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
  bulkDeleteStock,
  listAvailableCredentials,
  getStockItem,
  markStockDead,
  bulkMarkStockDead,
  setStockNote,
  restockSubscriberCounts,
  countRestockSubscribers,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash, renderError, safeReturnTo } from "../flash";

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
    const body = (req.body ?? {}) as Record<string, string>;
    // Land back on the Inventory tab when posted from the product detail page;
    // else the standalone /stock/:id page (unchanged default).
    const back = safeReturnTo(body.return_to, `/stock/${productId}`);
    const raw = body.credentials ?? "";
    const creds = raw.split(/\r?\n/).map((ln) => ln.trim()).filter(Boolean);
    if (creds.length === 0) {
      return redirectWithFlash(reply, back, "No credentials provided.", "error");
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
    return redirectWithFlash(reply, back, `Added ${added} stock item(s).`, "success");
  });

  // Bulk mark selected stock items dead (one writer, audited once). Never logs
  // credentials — only the count and ids.
  app.post("/stock/:productId/bulk-dead", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const body = (req.body ?? {}) as Record<string, string>;
    const back = safeReturnTo(body.return_to, `/stock/${productId}`);
    const ids = (body.ids ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) {
      return redirectWithFlash(reply, back, "Select at least one stock item.", "error");
    }
    const note = (body.note ?? "").trim() || "bulk marked dead via web";
    const count = await bulkMarkStockDead(prisma, ids, note);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_bulk_dead",
      targetType: "product",
      targetId: productId,
      details: `count=${count} note=${note.slice(0, 160)}`, // never the credentials
    });
    logger.info(`Bulk-marked ${count} stock rows dead on product ${productId}`);
    return redirectWithFlash(reply, back, `${count} stock item(s) marked dead.`, "success");
  });

  // Hard-delete selected stock items (one writer, audited once). The crud guard
  // refuses SOLD rows and anything tied to an order item, so the count returned
  // may be < the number selected — the flash reflects what actually went.
  app.post("/stock/:productId/bulk-delete", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const body = (req.body ?? {}) as Record<string, string>;
    const back = safeReturnTo(body.return_to, `/stock/${productId}`);
    const ids = (body.ids ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) {
      return redirectWithFlash(reply, back, "Select at least one stock item.", "error");
    }
    const count = await bulkDeleteStock(prisma, ids);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_bulk_delete",
      targetType: "product",
      targetId: productId,
      details: `requested=${ids.length} deleted=${count}`, // never the credentials
    });
    logger.info(`Bulk-deleted ${count} stock rows on product ${productId}`);
    const skipped = ids.length - count;
    const tail = skipped > 0 ? ` (${skipped} skipped — sold or in an order)` : "";
    return redirectWithFlash(reply, back, `${count} stock item(s) deleted${tail}.`, "success");
  });

  // Download remaining (AVAILABLE) credentials as a plain-text file, one login
  // per line — same shape as the upload box. Read-only, so currentAdmin (not
  // csrfProtect); still audited by count. The credentials themselves are never
  // logged.
  app.get("/stock/:productId/download", { preHandler: currentAdmin }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const product = await getProduct(prisma, productId);
    if (!product) {
      return renderError(reply, { statusCode: 404, title: "Not found", message: "Product not found." });
    }
    const creds = await listAvailableCredentials(prisma, productId);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_download",
      targetType: "product",
      targetId: productId,
      details: `count=${creds.length}`, // never the credentials
    });
    const slug = product.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "stock";
    const body = creds.length ? creds.join("\n") + "\n" : "";
    return reply
      .header("Content-Type", "text/plain; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="stock-${slug}-${productId}.txt"`)
      .header("Cache-Control", "no-store")
      .send(body);
  });

  app.post("/stock/item/:stockId/dead", { preHandler: csrfProtect }, async (req, reply) => {
    const stockId = Number((req.params as { stockId: string }).stockId);
    const body = (req.body ?? {}) as Record<string, string>;
    const note = (body.note ?? "").trim();
    const item = await getStockItem(prisma, stockId);
    if (!item) return redirectWithFlash(reply, "/stock", "Stock item not found.", "error");
    const back = safeReturnTo(body.return_to, `/stock/${item.productId}`);

    await markStockDead(prisma, stockId, note || "marked dead via web");
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_mark_dead",
      targetType: "stock_item",
      targetId: stockId,
      details: `note=${note.slice(0, 200)}`,
    });
    return redirectWithFlash(reply, back, `Stock item #${stockId} marked dead.`, "success");
  });

  app.post("/stock/item/:stockId/note", { preHandler: csrfProtect }, async (req, reply) => {
    const stockId = Number((req.params as { stockId: string }).stockId);
    const body = (req.body ?? {}) as Record<string, string>;
    const note = (body.note ?? "").trim();
    const item = await getStockItem(prisma, stockId);
    if (!item) return redirectWithFlash(reply, "/stock", "Stock item not found.", "error");
    const back = safeReturnTo(body.return_to, `/stock/${item.productId}`);

    await setStockNote(prisma, stockId, note || null);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_edit_note",
      targetType: "stock_item",
      targetId: stockId,
      details: `note=${note.slice(0, 200)}`,
    });
    return redirectWithFlash(reply, back, `Note updated on item #${stockId}.`, "success");
  });
}
