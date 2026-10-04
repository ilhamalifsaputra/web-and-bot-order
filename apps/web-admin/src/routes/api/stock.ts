import type { FastifyInstance } from "fastify";
import { csvRow } from "../../lib/csv";
import { parsePositiveId } from "../../lib/params";
import { logger } from "@app/core/logger";
import { config } from "@app/core/config";
import { CredentialKeyConfigError } from "@app/core/credentialCrypto";
import { formatIdr, formatUsdt, usdtFromIdr } from "@app/core/formatters";
import { StockStatus, DeadReason, DEAD_REASON_PHRASES, zDeadReason } from "@app/core/enums";
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
  SEARCH_RESULT_CAP,
  countAvailableStock,
  countRestockSubscribers,
  bulkAddStock,
  stockImportAuditDetails,
  type BulkAddStockResult,
  bulkMarkStockDead,
  bulkDeleteStock,
  deleteStockItem,
  exportAvailableCredentials,
  getStockItem,
  markStockDead,
  setStockNote,
  restockSubscriberCounts,
  logAdminAction,
  afterStockAdded,
  updateDenomination,
  revealStockCredentials,
  listStockItemEvents,
} from "@app/db";
import { currentAdmin, csrfProtect, blockReadonlyReads } from "../../plugins/auth";
import { displayDate } from "../../dateDisplay";

/** Constant placeholder shown for every credential in the list/detail
 * payload — StockItem.credentials is encrypted at rest (Task 2) and this
 * route never decrypts a whole page of rows just to display them. A real
 * value is only ever returned by the explicit, audited
 * POST /api/stock/item/:stockId/reveal below. Deliberately NOT derived from
 * the stored value's length or a decrypted prefix — either would leak
 * partial plaintext (or its length) to a page load nobody asked to reveal
 * anything on. */
export const MASKED_CREDENTIAL = "••••••••";

/** Absent reason defaults to OTHER (old clients, the bot); an unknown one is a 400. */
function parseDeadReason(raw: unknown): DeadReason | null {
  if (raw === undefined || raw === null || raw === "") return DeadReason.OTHER;
  const parsed = zDeadReason.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** " (password changed)" for a real reason; empty for OTHER, which says nothing. */
const reasonSuffix = (reason: DeadReason) => (reason === DeadReason.OTHER ? "" : ` (${DEAD_REASON_PHRASES[reason]})`);

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
export const CREDENTIAL_KEY_ERROR_MESSAGE =
  "Stock credential encryption is not configured correctly — check CREDENTIAL_ENCRYPTION_KEY.";

/** Single source of truth for "low stock": `config.LOW_STOCK_THRESHOLD`,
 * the same value GET /api/stock hands the client as `lowStockThreshold` for
 * StockPage's Status/Stock columns, and that the dashboard's inventory route
 * and the sidebar badge read too — `available === 0` is out, `available <=
 * threshold` is low. Previously each of those four places hard-coded its own
 * `<5` (this function) or `<threshold` (the sidebar), which could silently
 * disagree; unifying on `<=` is a small, deliberate behavior change from the
 * old `<5` here (see the T3 task brief/commit for the full comparison). */
function stockStatusLabel(available: number, threshold: number): string {
  if (available === 0) return "Out of Stock";
  if (available <= threshold) return "Low Stock";
  return "In Stock";
}

export default async function stockApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/stock", { preHandler: currentAdmin }, async (req, reply) => {
    const [denominations, counts, waiting] = await Promise.all([
      listAllDenominations(prisma),
      stockStatusCounts(prisma),
      restockSubscriberCounts(prisma),
    ]);
    return reply.send({ denominations, counts, waiting, lowStockThreshold: config.LOW_STOCK_THRESHOLD });
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
      "Restock Requests",
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
        // Same rule as the admin UI: blank unless out of stock with requests.
        available === 0 && waiting[d.id] ? String(waiting[d.id]) : "",
        stockStatusLabel(available, config.LOW_STOCK_THRESHOLD),
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
    const productId = parsePositiveId((req.params as { productId: string }).productId);
    if (productId === null) return reply.code(400).send({ error: "Invalid product id." });
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
    let capped = false;
    if (q) {
      try {
        items = await searchStockCredentials(prisma, productId, statuses, q);
      } catch (e) {
        if (e instanceof CredentialKeyConfigError) {
          logger.error({ err: e }, "Stock search failed — credential encryption is not configured correctly");
          return reply.code(500).send({ error: CREDENTIAL_KEY_ERROR_MESSAGE });
        }
        throw e;
      }
      total = items.length;
      capped = items.length === SEARCH_RESULT_CAP;
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
      deadReason: i.deadReason,
      // Masked by default — see MASKED_CREDENTIAL's own comment. The real
      // value is fetched per-row, on demand, via the reveal route below.
      credentials: MASKED_CREDENTIAL,
      createdAtDisplay: displayDate(i.addedAt),
    }));
    return reply.send({ product, items: itemsWithDisplay, statusCounts, total, capped, page, waiting });
  });

  app.post("/api/stock/:productId/bulk-add", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = parsePositiveId((req.params as { productId: string }).productId);
    if (productId === null) return reply.code(400).send({ error: "Invalid product id." });
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

    const adminId = req.admin!.userId;
    let res: BulkAddStockResult;
    try {
      res = await prisma.$transaction(async (tx) => {
        const r = await bulkAddStock(tx, productId, creds, { adminId });
        // Same transaction as the insert: stock, its IMPORTED events, the audit
        // row, subscriber DMs and the optional broadcast commit or roll back
        // together. Web only enqueues outbox rows.
        await logAdminAction(tx, {
          adminId,
          action: "stock_upload",
          targetType: "product",
          targetId: productId,
          details: stockImportAuditDetails(r),
        });
        await afterStockAdded(tx, productId, r.added, adminId);
        return r;
      });
    } catch (e) {
      if (e instanceof CredentialKeyConfigError) {
        logger.error({ err: e }, "Bulk stock upload failed — credential encryption is not configured correctly");
        return reply.code(500).send({ error: CREDENTIAL_KEY_ERROR_MESSAGE });
      }
      throw e;
    }
    const { added, skipped, duplicateInBatch, duplicateExisting, identityWarnings, unreadableExisting, batchId } = res;
    logger.info(
      `Bulk-added ${added} stock items to product ${productId} as import batch ${batchId} (skipped ${skipped} duplicate lines)`,
    );
    if (unreadableExisting > 0) {
      logger.warn(
        { productId, batchId, unreadableExisting },
        `Bulk stock upload to product ${productId} could not check ${unreadableExisting} existing stock rows for duplicates because they failed to decrypt; those rows need investigating.`,
      );
    }

    const parts = [`Added ${added} stock item(s) as import batch #${batchId}.`];
    if (skipped > 0) parts.push(`Skipped ${skipped} duplicate(s).`);
    if (identityWarnings > 0) {
      parts.push(`${identityWarnings} added item(s) use an account that is already in stock with a different password.`);
    }
    if (unreadableExisting > 0) {
      parts.push(`${unreadableExisting} existing item(s) could not be read, so they were not checked for duplicates.`);
    }
    const message = parts.join(" ");
    return reply.send({
      ok: true,
      added,
      skipped,
      duplicateInBatch,
      duplicateExisting,
      identityWarnings,
      unreadableExisting,
      batchId,
      message,
    });
  });

  // Toggle the "broadcast to all customers when I add stock" flag on this
  // product (default off). Separate small endpoint, same shape as the
  // isActive toggle at POST /api/catalog/denominations/:id/active.
  app.post("/api/stock/:productId/broadcast", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = parsePositiveId((req.params as { productId: string }).productId);
    if (productId === null) return reply.code(400).send({ error: "Invalid product id." });
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

  // Bulk mark selected stock items dead (one writer, audited once). The audit row
  // carries only the count — never the credentials or the admin-typed note.
  app.post("/api/stock/:productId/bulk-dead", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = parsePositiveId((req.params as { productId: string }).productId);
    if (productId === null) return reply.code(400).send({ error: "Invalid product id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? body.ids.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) return reply.code(400).send({ error: "Select at least one stock item." });
    const note = (typeof body.note === "string" ? body.note.trim() : "") || "bulk marked dead via web";
    const reason = parseDeadReason(body.reason);
    if (!reason) return reply.code(400).send({ error: "Unknown dead reason." });

    const adminId = req.admin!.userId;
    // One transaction: the status change, its MARKED_DEAD events and the audit row stand or fall together.
    const count = await prisma.$transaction(async (tx) => {
      const n = await bulkMarkStockDead(tx, ids, note, adminId, reason);
      await logAdminAction(tx, {
        adminId,
        action: "stock_bulk_dead",
        targetType: "product",
        targetId: productId,
        details: `Marked ${n} stock ${n === 1 ? "item" : "items"} dead${reasonSuffix(reason)}.`, // never the note — admins paste credentials into it
      });
      return n;
    });
    logger.info(`Bulk-marked ${count} stock items dead on product ${productId}`);
    return reply.send({ ok: true, count });
  });

  // Soft-delete selected stock items (one writer, audited once). The crud guard
  // refuses SOLD rows and anything tied to an order item, so the count returned
  // may be < the number selected.
  app.post("/api/stock/:productId/bulk-delete", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = parsePositiveId((req.params as { productId: string }).productId);
    if (productId === null) return reply.code(400).send({ error: "Invalid product id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? body.ids.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) return reply.code(400).send({ error: "Select at least one stock item." });

    const adminId = req.admin!.userId;
    const count = await prisma.$transaction(async (tx) => {
      const n = await bulkDeleteStock(tx, ids, adminId);
      await logAdminAction(tx, {
        adminId,
        action: "stock_bulk_delete",
        targetType: "product",
        targetId: productId,
        details: `Deleted ${n} of ${ids.length} requested stock items.`, // never the credentials
      });
      return n;
    });
    logger.info(`Bulk-deleted ${count} stock items on product ${productId}`);
    return reply.send({ ok: true, count, skipped: ids.length - count });
  });

  app.post("/api/stock/item/:stockId/dead", { preHandler: csrfProtect }, async (req, reply) => {
    const stockId = parsePositiveId((req.params as { stockId: string }).stockId);
    if (stockId === null) return reply.code(400).send({ error: "Invalid stock item id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const note = (typeof body.note === "string" ? body.note.trim() : "");
    const reason = parseDeadReason(body.reason);
    if (!reason) return reply.code(400).send({ error: "Unknown dead reason." });
    const item = await getStockItem(prisma, stockId);
    if (!item) return reply.code(404).send({ error: "Stock item not found." });

    const adminId = req.admin!.userId;
    const count = await prisma.$transaction(async (tx) => {
      const n = await markStockDead(tx, stockId, note || "marked dead via web", adminId, reason);
      if (n === 0) return 0; // nothing changed, so nothing to audit
      await logAdminAction(tx, {
        adminId,
        action: "stock_mark_dead",
        targetType: "stock_item",
        targetId: stockId,
        details: `Marked stock item #${stockId} dead${reasonSuffix(reason)}.`, // never the note — admins paste credentials into it
      });
      return n;
    });
    if (count === 0) {
      return reply.code(409).send({ error: "This item is already sold or dead and can no longer be changed." });
    }
    return reply.send({ ok: true });
  });

  // Soft-delete ONE stock item — the single-item sibling of bulk-delete above,
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
    const stockId = parsePositiveId((req.params as { stockId: string }).stockId);
    if (stockId === null) return reply.code(400).send({ error: "Invalid stock item id." });
    const item = await getStockItem(prisma, stockId);
    if (!item) return reply.code(404).send({ error: "Stock item not found." });

    const adminId = req.admin!.userId;
    const deleted = await prisma.$transaction(async (tx) => {
      if (!(await deleteStockItem(tx, stockId, adminId))) return false;
      await logAdminAction(tx, {
        adminId,
        action: "stock_item_delete",
        targetType: "stock_item",
        targetId: stockId,
        details: `Deleted stock item.`, // never the credentials
      });
      return true;
    });
    if (!deleted) {
      return reply.code(409).send({ error: "This item has been sold or is linked to an order and cannot be deleted." });
    }
    return reply.send({ ok: true });
  });

  app.post("/api/stock/item/:stockId/note", { preHandler: csrfProtect }, async (req, reply) => {
    const stockId = parsePositiveId((req.params as { stockId: string }).stockId);
    if (stockId === null) return reply.code(400).send({ error: "Invalid stock item id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const note = (typeof body.note === "string" ? body.note.trim() : "");
    const item = await getStockItem(prisma, stockId);
    if (!item) return reply.code(404).send({ error: "Stock item not found." });

    await prisma.$transaction(async (tx) => {
      await setStockNote(tx, stockId, note || null);
      await logAdminAction(tx, {
        adminId: req.admin!.userId,
        action: "stock_edit_note",
        targetType: "stock_item",
        targetId: stockId,
        details: `Updated the note on stock item #${stockId}.`, // never the note — admins paste credentials into it
      });
    });
    return reply.send({ ok: true });
  });

  // Read-only timeline of one stock item. Carries no credentials (and no raw event
  // meta), so any admin may read it and no audit row is written. A soft-deleted
  // item still has its history; only an id that never existed is a 404.
  app.get("/api/stock/item/:stockId/history", { preHandler: currentAdmin }, async (req, reply) => {
    const stockId = parsePositiveId((req.params as { stockId: string }).stockId);
    if (stockId === null) return reply.code(400).send({ error: "Invalid stock item id." });
    const events = await listStockItemEvents(prisma, stockId);
    if (events === null) return reply.code(404).send({ error: "Stock item not found." });
    return reply.send({
      events: events.map((e) => ({ ...e, occurredAt: undefined, occurredAtDisplay: displayDate(e.occurredAt) })),
    });
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
    const stockId = parsePositiveId((req.params as { stockId: string }).stockId);
    if (stockId === null) return reply.code(400).send({ error: "Invalid stock item id." });
    const adminId = req.admin!.userId;
    let credentials: string | null;
    try {
      // One transaction: the reveal's CREDENTIAL_REVEALED event and its audit row
      // exist together or not at all — and neither exists for a missing item or a
      // failed decrypt.
      credentials = await prisma.$transaction(async (tx) => {
        const revealed = await revealStockCredentials(tx, stockId, adminId);
        if (revealed === null) return null;
        await logAdminAction(tx, {
          adminId,
          action: "credential_revealed",
          targetType: "stock_item",
          targetId: stockId,
          details: `Admin revealed credentials for stock item #${stockId}.`, // never the credentials themselves
        });
        return revealed;
      });
    } catch (e) {
      if (e instanceof CredentialKeyConfigError) {
        logger.error({ err: e }, "Credential reveal failed — credential encryption is not configured correctly");
        return reply.code(500).send({ error: CREDENTIAL_KEY_ERROR_MESSAGE });
      }
      throw e;
    }
    if (credentials === null) return reply.code(404).send({ error: "Stock item not found." });
    return reply.send({ ok: true, credentials });
  });

  // Download remaining (AVAILABLE) credentials as a plain-text file, one login
  // per line. Read-only, so no CSRF check; still audited by count. The
  // credentials themselves are never logged. Gated to non-readonly roles
  // (C-1, security audit 2026-08-21) since this dumps plaintext credentials.
  app.get("/api/stock/:productId/download", { preHandler: blockReadonlyReads }, async (req, reply) => {
    const productId = parsePositiveId((req.params as { productId: string }).productId);
    if (productId === null) return reply.code(400).send({ error: "Invalid product id." });
    const product = await getDenominationWithProduct(prisma, productId);
    if (!product) return reply.code(404).send({ error: "Product not found." });

    // One CREDENTIAL_REVEALED event per exported row and the audit row, in
    // one transaction: if the audit write fails, no event is left behind and
    // no file is served.
    const creds = await prisma.$transaction(async (tx) => {
      const exported = await exportAvailableCredentials(tx, productId, req.admin!.userId);
      await logAdminAction(tx, {
        adminId: req.admin!.userId,
        action: "stock_download",
        targetType: "product",
        targetId: productId,
        details: `Downloaded ${exported.length} available credentials.`, // never the credentials
      });
      return exported;
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
