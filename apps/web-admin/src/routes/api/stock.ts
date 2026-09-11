import type { FastifyInstance } from "fastify";
import { logger } from "@app/core/logger";
import { CredentialKeyConfigError } from "@app/core/credentialCrypto";
import { formatIdr, formatUsdt, usdtFromIdr } from "@app/core/formatters";
import { StockStatus } from "@app/core/enums";
import {
  prisma,
  getUsdIdrRate,
  listAllDenominations,
  stockStatusCounts,
  getDenominationWithProduct,
  stockStatusCountsForProduct,
  listStockItemsForProductPage,
  countStockItemsForStatuses,
  searchStockCredentials,
  countAvailableStock,
  countRestockSubscribers,
  bulkAddStock,
  bulkMarkStockDead,
  bulkDeleteStock,
  deleteStockItem,
  listAvailableCredentials,
  getStockItem,
  markStockDead,
  setStockNote,
  restockSubscriberCounts,
  logAdminAction,
  enqueueRestockBroadcast,
  updateDenomination,
  revealStockCredentials,
} from "@app/db";
import { currentAdmin, csrfProtect, blockReadonlyReads } from "../../plugins/auth";
import { displayDate } from "../../dateDisplay";

/** Quotes a CSV field per RFC 4180: wrap in double quotes if it contains a
 * comma, quote, or newline, doubling any embedded quotes. Mirrors
 * apps/web-admin/src/routes/api/orders.ts's identical helper — not shared,
 * per that file's own per-route-file convention. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(",") + "\r\n";
}

/** Constant placeholder shown for every credential in the list/detail
 * payload — StockItem.credentials is encrypted at rest (Task 2) and this
 * route never decrypts a whole page of rows just to display them. A real
 * value is only ever returned by the explicit, audited
 * POST /api/stock/item/:stockId/reveal below. Deliberately NOT derived from
 * the stored value's length or a decrypted prefix — either would leak
 * partial plaintext (or its length) to a page load nobody asked to reveal
 * anything on. */
const MASKED_CREDENTIAL = "••••••••";

/** Page size for GET /api/stock/:productId's tab/page pagination — replaces
 * the old flat `take: 500` that spanned every status at once (the bug this
 * route was rewritten to fix: counts/tabs got stuck at 500 and rows past it
 * were invisible). Each tab is now counted and paginated independently. */
const PAGE_SIZE = 50;

/** Operator-facing message for `CredentialKeyConfigError` — the bulk-add and
 * reveal routes below (the ones that call into encryptCredentials/
 * decryptCredentials) catch that specific error (never a bare `catch` — a
 * real bug in the handler should still hit the generic HTML 500 in
 * server.ts) and return this as JSON instead, so a missing/malformed
 * `CREDENTIAL_ENCRYPTION_KEY` surfaces as a readable admin error instead of
 * `apiPost` failing to parse an HTML error page. */
const CREDENTIAL_KEY_ERROR_MESSAGE =
  "Stock credential encryption is not configured correctly — check CREDENTIAL_ENCRYPTION_KEY.";

/** Same `<5`/`===0` thresholds the client's Status column and KPI tiles use
 * (StockPage.tsx's `stockTier`) — kept in sync manually since this is a
 * tiny, stable threshold and the two sides don't share a module. */
function stockStatusLabel(available: number): string {
  if (available === 0) return "Out of Stock";
  if (available < 5) return "Low Stock";
  return "In Stock";
}

export default async function stockApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/stock", { preHandler: currentAdmin }, async (req, reply) => {
    const [denominations, counts, waiting] = await Promise.all([
      listAllDenominations(prisma),
      stockStatusCounts(prisma),
      restockSubscriberCounts(prisma),
    ]);
    return reply.send({ denominations, counts, waiting });
  });

  // Full, unfiltered inventory export — mirrors GET /api/stock's own data
  // source exactly, formatted as CSV. Read-only, so no CSRF check. Carries no
  // credentials (aggregate counts only), so it stays open to every
  // authenticated admin including readonly — explicitly out of scope for the
  // C-1 fix that gates /:productId and /:productId/download below.
  app.get("/api/stock/export", { preHandler: currentAdmin }, async (req, reply) => {
    const [denominations, counts, waiting, usdRate] = await Promise.all([
      listAllDenominations(prisma),
      stockStatusCounts(prisma),
      restockSubscriberCounts(prisma),
      getUsdIdrRate(prisma),
    ]);

    const header = [
      "Denomination",
      "Product",
      "Category",
      "Catalog Price (IDR)",
      "Catalog Price (USD)",
      "Available",
      "Reserved",
      "Sold",
      "Waiting",
      "Status",
    ];
    let csv = csvRow(header);
    for (const d of denominations) {
      const cnt = counts[d.id];
      const available = cnt?.available ?? 0;
      csv += csvRow([
        d.name,
        d.product?.name ?? "",
        d.product?.category?.name ?? "",
        formatIdr(d.price),
        usdRate ? formatUsdt(usdtFromIdr(d.price, usdRate)) : "",
        String(available),
        String(cnt?.reserved ?? 0),
        String(cnt?.sold ?? 0),
        String(waiting[d.id] ?? 0),
        stockStatusLabel(available),
      ]);
    }

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="stock.csv"');
    reply.header("Cache-Control", "no-store");
    return reply.send(csv);
  });

  // Tabbed + paginated stock detail. `tab` selects a status group (mirrors
  // StockProductPage.tsx's availableItems/soldItems/deadItems split — "sold"
  // includes RESERVED alongside SOLD), `page` paginates within that group,
  // and a non-empty `q` switches to a search-across-the-group mode instead
  // (page is then irrelevant). `statusCounts` is always computed for all
  // three tabs regardless of mode, so the tab bar's counts never depend on
  // which tab happens to be open.
  app.get("/api/stock/:productId", { preHandler: blockReadonlyReads }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const product = await getDenominationWithProduct(prisma, productId);
    if (!product) return reply.code(404).send({ error: "Product not found." });

    const query = req.query as Record<string, string | undefined>;
    const tab = query.tab === "sold" || query.tab === "dead" ? query.tab : "available";
    const statuses =
      tab === "sold"
        ? [StockStatus.SOLD, StockStatus.RESERVED]
        : tab === "dead"
          ? [StockStatus.DEAD]
          : [StockStatus.AVAILABLE];
    const page = Math.max(Number(query.page) || 1, 1);
    const q = (query.q ?? "").trim();

    const [statusCounts, waiting] = await Promise.all([
      stockStatusCountsForProduct(prisma, productId),
      countRestockSubscribers(prisma, productId),
    ]);

    let items;
    let total;
    if (q) {
      items = await searchStockCredentials(prisma, productId, statuses, q);
      total = items.length;
    } else {
      [items, total] = await Promise.all([
        listStockItemsForProductPage(prisma, productId, statuses, {
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        }),
        countStockItemsForStatuses(prisma, productId, statuses),
      ]);
    }

    // Stock items are timestamped `addedAt` in the DB/crud layer (not
    // `createdAt`) — the client's "Added" column had been reading a
    // nonexistent `createdAt` field (always undefined → Invalid Date).
    // Fixed here alongside adding the pre-formatted display string.
    // Shape the rows explicitly rather than spreading them: the page needs the
    // account credential, but not the order linkage (orderId/reservedAt/soldAt)
    // the raw row carries.
    const itemsWithDisplay = items.map((i) => ({
      id: i.id,
      status: i.status,
      note: i.note,
      // Masked by default — see MASKED_CREDENTIAL's own comment. The real
      // value is fetched per-row, on demand, via the reveal route below.
      credentials: MASKED_CREDENTIAL,
      createdAtDisplay: displayDate(i.addedAt),
    }));
    return reply.send({ product, items: itemsWithDisplay, statusCounts, total, page, waiting });
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

    let added: number, skipped: number;
    try {
      ({ added, skipped } = await prisma.$transaction((tx) => bulkAddStock(tx, productId, creds)));
    } catch (e) {
      if (e instanceof CredentialKeyConfigError) {
        logger.error({ err: e }, "Bulk stock upload failed — credential encryption is not configured correctly");
        return reply.code(500).send({ error: CREDENTIAL_KEY_ERROR_MESSAGE });
      }
      throw e;
    }
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
      const fullName = `${product.product.name} - ${product.name}`;
      const notified = await enqueueRestockBroadcast(prisma, {
        productName: fullName,
        stockCount,
        createdById: req.admin!.userId,
      });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "restock_broadcast",
        targetType: "product",
        targetId: productId,
        details: `Queued a restock broadcast for "${fullName}" to ${notified} customers.`,
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

    const count = await markStockDead(prisma, stockId, note || "marked dead via web");
    if (count === 0) {
      return reply.code(409).send({ error: "This item is already sold or dead and can no longer be changed." });
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_mark_dead",
      targetType: "stock_item",
      targetId: stockId,
      details: `Marked stock item dead. Note: "${note.slice(0, 200)}".`, // never the credentials
    });
    return reply.send({ ok: true });
  });

  // Hard-delete ONE stock item — the single-item sibling of bulk-delete above,
  // filling a gap where only bulk selection could delete a row. Same guard as
  // bulkDeleteStock: refuses a SOLD row or one tied to an order item. Uses 409
  // (not 422) to match `.../dead` just above and this file's other
  // delete-blocked-by-existing-state routes elsewhere in the repo (e.g.
  // catalog.ts's "Cannot delete a denomination with order history.",
  // vouchers.ts's "Cannot delete: this code has already been used.") — the
  // rejection here is a conflict with the row's current state/references, the
  // same framing as those, not a request-shape validation failure (422's use
  // elsewhere in this file, e.g. bulk-add's missing-credentials case).
  app.post("/api/stock/item/:stockId/delete", { preHandler: csrfProtect }, async (req, reply) => {
    const stockId = Number((req.params as { stockId: string }).stockId);
    const item = await getStockItem(prisma, stockId);
    if (!item) return reply.code(404).send({ error: "Stock item not found." });

    const deleted = await deleteStockItem(prisma, stockId);
    if (!deleted) {
      return reply.code(409).send({ error: "This item has been sold or is linked to an order and cannot be deleted." });
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "stock_item_delete",
      targetType: "stock_item",
      targetId: stockId,
      details: `Deleted stock item.`, // never the credentials
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

  // Explicit, audited reveal of ONE stock item's real credential — the only
  // route that ever returns a decrypted value from this file. csrfProtect
  // (not currentAdmin) even though it's read-only in effect: revealing a
  // secret is a privileged action same as the mutations above, and gating it
  // on the CSRF token keeps it out of reach of a bare cross-site GET/image
  // tag. Every call is audited as credential_revealed (lowercase snake_case,
  // like every other action in this file — see docs/LOGGING.md and
  // AuditPage.tsx's humanizeActionCode, which title-cases this convention;
  // an all-caps action would render as shouting-case next to every other
  // row) — including repeat reveals of the same item, so the trail shows
  // every time an admin actually looked, not just the first. One query
  // (revealStockCredentials) covers both the existence check and the read —
  // its null return doubles as "no such stock item".
  app.post("/api/stock/item/:stockId/reveal", { preHandler: csrfProtect }, async (req, reply) => {
    const stockId = Number((req.params as { stockId: string }).stockId);
    let credentials: string | null;
    try {
      credentials = await revealStockCredentials(prisma, stockId);
    } catch (e) {
      if (e instanceof CredentialKeyConfigError) {
        logger.error({ err: e }, "Credential reveal failed — credential encryption is not configured correctly");
        return reply.code(500).send({ error: CREDENTIAL_KEY_ERROR_MESSAGE });
      }
      throw e;
    }
    if (credentials === null) return reply.code(404).send({ error: "Stock item not found." });

    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "credential_revealed",
      targetType: "stock_item",
      targetId: stockId,
      details: `Admin revealed credentials for stock item #${stockId}.`, // never the credentials themselves
    });
    return reply.send({ ok: true, credentials });
  });

  // Download remaining (AVAILABLE) credentials as a plain-text file, one login
  // per line. Read-only, so no CSRF check; still audited by count. The
  // credentials themselves are never logged. Gated to non-readonly roles
  // (C-1, security audit 2026-08-21) since this dumps plaintext credentials.
  app.get("/api/stock/:productId/download", { preHandler: blockReadonlyReads }, async (req, reply) => {
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
