/**
 * Stock domain — port of the "Stock" section of Python crud.py, including the
 * reserved-stock allocation that prevents two buyers grabbing the same row.
 *
 * `StockItem.credentials` is encrypted at rest (AES-256-GCM, Task 2 — see
 * @app/core/credentialCrypto): every write here encrypts, every read that
 * hands a plaintext credential back to a caller decrypts. Reads that only
 * need to KNOW a row exists (getStockItem, listStockItemsForProduct) do NOT
 * decrypt — those feed the admin masked-by-default list and the bot's admin
 * stock browser, neither of which should carry plaintext through unrelated
 * code paths. `revealStockCredentials` is the sole explicit-reveal read.
 */
import { StockStatus, StockEventType, StockActorType, DeadReason } from "@app/core/enums";
import {
  encryptCredentials,
  encryptStockCredentials,
  credentialEnvelopeWriteVersion,
  decryptStockCredentials,
  tryDecryptCredentials,
  computeCredentialFingerprint,
  computeIdentityFingerprint,
  computeImportSourceHash,
  type CredentialEnvelope,
} from "@app/core/credentialCrypto";
import type { Db } from "./_types";
import { recordStockEvent, recordStockEvents, type StockEventActor } from "./stockEvents";

/** Only reached while writers emit v1, which ignores its context; a v2 write always gets the row's id. */
const V1_STOCK_CREDENTIALS_AAD = "stock_items.credentials:v1";

/** Rows per INSERT: 11 columns each keeps a statement far below Postgres' 65535 bind-parameter limit. */
const STOCK_INSERT_CHUNK_ROWS = 2000;

/** Take `count` ids from stock_items' own sequence, so a v2 envelope can bind its row id before the insert. */
async function reserveStockItemIds(tx: Db, count: number): Promise<number[]> {
  const rows = await tx.$queryRaw<{ id: bigint }[]>`
    SELECT nextval(pg_get_serial_sequence('stock_items', 'id')) AS id FROM generate_series(1, ${count}::int)`;
  return rows.map((r) => Number(r.id));
}

/** Runs `fn` on the caller's transaction, or opens one when handed a bare client. */
async function inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  // A `Tx` has no `$transaction` (Prisma strips it from the interactive
  // transaction client), so its presence is what distinguishes the bare client.
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return db.$transaction((tx) => fn(tx));
  }
  return fn(db);
}

/** An admin's action, or SYSTEM when there is no admin to attribute it to. */
function adminActor(adminId: number | null | undefined): StockEventActor {
  return adminId == null
    ? { type: StockActorType.SYSTEM }
    : { type: StockActorType.ADMIN, adminId };
}

/**
 * Row-lock the named stock rows for the rest of the transaction, in id order so
 * two overlapping bulk calls cannot deadlock each other. Without it, the status
 * this reads and the status the update sees could differ (an order reserving
 * the row in between), and the event would name the wrong prior status.
 */
async function lockStockRows(tx: Db, ids: number[]): Promise<void> {
  await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ANY(${ids}::int[]) ORDER BY id FOR UPDATE`;
}

/** Namespace half of the two-key advisory lock `bulkAddStock` takes per denomination. */
const STOCK_IMPORT_LOCK_NAMESPACE = 0x53544b31; // "STK1"

/** Statuses in which a row still holds its credential (and its claim key). */
const LIVE_STOCK_STATUSES = [StockStatus.AVAILABLE, StockStatus.RESERVED, StockStatus.SOLD];

/** The `activeCredentialKey` a live row holds: one per credential per denomination. */
export function stockClaimKey(productId: number, credentialFingerprint: string): string {
  return `${productId}:${credentialFingerprint}`;
}

export interface BulkAddStockOptions {
  adminId?: number | null;
  /** Free-text label of where the upload came from (file name, supplier); never credentials. */
  sourceLabel?: string | null;
}

export interface BulkAddStockResult {
  added: number;
  /** Every submitted line that did not become a new row: duplicateInBatch + duplicateExisting. */
  skipped: number;
  /** Repeats of a credential earlier in the same upload. */
  duplicateInBatch: number;
  /** Credentials already live (AVAILABLE/RESERVED/SOLD) for this denomination. */
  duplicateExisting: number;
  /** Added rows whose account identity is already live here with a different password. */
  identityWarnings: number;
  /** Existing un-backfilled rows that could not be decrypted, so dedup could not check against them. */
  unreadableExisting: number;
  /** The StockImportBatch recorded for this upload; null only for an empty upload. */
  batchId: number | null;
}

/**
 * Bulk-insert AVAILABLE stock as one recorded StockImportBatch, deduping
 * against the incoming batch itself AND against live (AVAILABLE/RESERVED/SOLD)
 * rows for this denomination — two live rows holding one credential could be
 * allocated to TWO buyers, delivering the same account twice (Stock-1 fix,
 * security audit 2026-06-23). DEAD and soft-deleted rows don't count, so a
 * dead account may be re-imported.
 *
 * Dedup compares keyed credential fingerprints (@app/core/credentialCrypto),
 * so the same account with a differently-cased email or a "|" delimiter is
 * still a duplicate; the password is compared exactly. Rows that predate
 * fingerprints (not yet backfilled) are decrypted one by one and compared the
 * same way; a row that fails to decrypt is counted in `unreadableExisting`
 * and skipped rather than failing the whole upload (a missing/misconfigured
 * key still throws). A new credential whose identity is already live with a
 * different password is added and only counted in `identityWarnings`.
 *
 * Each new row holds `activeCredentialKey` (unique) while live, so even a
 * writer that bypasses the advisory lock below can't insert a second live
 * copy; a row that loses on that constraint is counted as a duplicate.
 *
 * With CREDENTIAL_ENVELOPE_WRITE_V2 on, each row's envelope is bound to its
 * own id (Fase 6d): the ids are reserved from the sequence in one statement
 * first, so the insert stays one statement per chunk either way.
 */
export async function bulkAddStock(
  db: Db,
  productId: number,
  credentials: string[],
  options?: number | null | BulkAddStockOptions,
): Promise<BulkAddStockResult> {
  const opts: BulkAddStockOptions =
    options != null && typeof options === "object" ? options : { adminId: options ?? null };
  const empty: BulkAddStockResult = {
    added: 0,
    skipped: 0,
    duplicateInBatch: 0,
    duplicateExisting: 0,
    identityWarnings: 0,
    unreadableExisting: 0,
    batchId: null,
  };
  if (credentials.length === 0) return empty;

  return inTransaction(db, async (tx) => {
    // Serialize imports per denomination: the dedup read below and the insert
    // are only atomic together under this lock. Two concurrent uploads of the
    // same credential would otherwise both read "not there yet" and both insert
    // it (Postgres runs writers in parallel; nothing serializes them for us).
    // Transaction-scoped, so it releases itself on commit or rollback, and the
    // statements after it each take a fresh READ COMMITTED snapshot, so the
    // second caller's dedup read sees the first caller's committed rows.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${STOCK_IMPORT_LOCK_NAMESPACE}::int, ${productId}::int)`;

    // First occurrence of each credential fingerprint wins within the upload.
    const incoming = new Map<string, { plain: string; identity: string }>();
    for (const plain of credentials) {
      const fp = computeCredentialFingerprint(plain);
      if (!incoming.has(fp)) incoming.set(fp, { plain, identity: computeIdentityFingerprint(plain) });
    }
    const duplicateInBatch = credentials.length - incoming.size;

    const live = { productId, deletedAt: null, status: { in: LIVE_STOCK_STATUSES } };
    const existingCredentials = new Set<string>();
    const existingIdentities = new Set<string>();
    const byFingerprint = await tx.stockItem.findMany({
      where: { ...live, credentialFingerprint: { in: [...incoming.keys()] } },
      select: { credentialFingerprint: true },
    });
    for (const r of byFingerprint) existingCredentials.add(r.credentialFingerprint!);
    const byIdentity = await tx.stockItem.findMany({
      where: { ...live, identityFingerprint: { in: [...new Set([...incoming.values()].map((v) => v.identity))] } },
      select: { identityFingerprint: true },
    });
    for (const r of byIdentity) existingIdentities.add(r.identityFingerprint!);

    // Rows not yet backfilled carry no fingerprint: decrypt-compare them one by one.
    let unreadableExisting = 0;
    const legacy = await tx.stockItem.findMany({
      where: { ...live, credentialFingerprint: null },
      select: { id: true, credentials: true },
    });
    for (const r of legacy) {
      const plain = tryDecryptCredentials(r.credentials, { stockItemId: r.id, purpose: "the stock import duplicate check" });
      if (plain === null) {
        unreadableExisting++;
        continue;
      }
      existingCredentials.add(computeCredentialFingerprint(plain));
      existingIdentities.add(computeIdentityFingerprint(plain));
    }

    const fresh = [...incoming].filter(([fp]) => !existingCredentials.has(fp));
    const freshKeys = fresh.map(([fp]) => stockClaimKey(productId, fp));

    // A DEAD/deleted row must never block re-import, even if some writer forgot to release its claim.
    if (freshKeys.length) {
      await tx.stockItem.updateMany({
        where: {
          activeCredentialKey: { in: freshKeys },
          OR: [{ deletedAt: { not: null } }, { status: { notIn: LIVE_STOCK_STATUSES } }],
        },
        data: { activeCredentialKey: null },
      });
    }

    const adminId = opts.adminId ?? null;
    const batch = await tx.stockImportBatch.create({
      data: {
        adminId,
        productId,
        sourceLabel: opts.sourceLabel ?? null,
        sourceHash: computeImportSourceHash(credentials),
        rowsSubmitted: credentials.length,
        rowsInserted: 0,
        rowsDuplicate: 0,
      },
      select: { id: true },
    });

    // v2 envelopes bind the row id as AAD, so with the flag on the ids are
    // reserved from the sequence first (same transaction and lock) and the
    // rows are inserted with them; with it off, v1 needs no id.
    // skipDuplicates: a claim held by a live row the dedup read didn't see is a duplicate, not a crash.
    const ids =
      fresh.length && credentialEnvelopeWriteVersion() === 2 ? await reserveStockItemIds(tx, fresh.length) : null;
    const rows = fresh.map(([fp, { plain, identity }], i) => {
      const stored = ids ? encryptStockCredentials(plain, ids[i]!) : encryptCredentials(plain, V1_STOCK_CREDENTIALS_AAD);
      return {
        ...(ids ? { id: ids[i]! } : {}),
        productId,
        credentials: stored,
        status: StockStatus.AVAILABLE,
        importBatchId: batch.id,
        addedByAdminId: adminId,
        credentialFingerprint: fp,
        identityFingerprint: identity,
        credentialKeyVersion: (JSON.parse(stored) as CredentialEnvelope).keyVersion,
        activeCredentialKey: stockClaimKey(productId, fp),
      };
    });
    const created: { id: number; identityFingerprint: string | null; credentialFingerprint: string | null }[] = [];
    for (let start = 0; start < rows.length; start += STOCK_INSERT_CHUNK_ROWS) {
      created.push(
        ...(await tx.stockItem.createManyAndReturn({
          data: rows.slice(start, start + STOCK_INSERT_CHUNK_ROWS),
          select: { id: true, identityFingerprint: true, credentialFingerprint: true },
          skipDuplicates: true,
        })),
      );
    }

    const identityCounts = new Map<string, number>();
    for (const r of created) identityCounts.set(r.identityFingerprint!, (identityCounts.get(r.identityFingerprint!) ?? 0) + 1);
    const identityWarnings = created.filter(
      (r) => existingIdentities.has(r.identityFingerprint!) || identityCounts.get(r.identityFingerprint!)! > 1,
    ).length;

    const actor = adminActor(adminId);
    await recordStockEvents(
      tx,
      created.map((row) => ({
        stockItemId: row.id,
        eventType: StockEventType.IMPORTED,
        toStatus: StockStatus.AVAILABLE,
        actor,
      })),
    );

    const duplicateExisting = incoming.size - created.length;
    await tx.stockImportBatch.update({
      where: { id: batch.id },
      data: { rowsInserted: created.length, rowsDuplicate: duplicateInBatch + duplicateExisting },
    });
    return {
      added: created.length,
      skipped: credentials.length - created.length,
      duplicateInBatch,
      duplicateExisting,
      identityWarnings,
      unreadableExisting,
      batchId: batch.id,
    };
  });
}

/** The shop-admin audit sentence for one bulk import (docs/LOGGING.md): counts only, never credentials. */
export function stockImportAuditDetails(r: BulkAddStockResult, invalidLines = 0): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const dups = n(r.skipped, "duplicate", "duplicates");
  const skipped = invalidLines > 0 ? `${n(invalidLines, "invalid line", "invalid lines")} and ${dups}` : dups;
  let details = `Added ${n(r.added, "stock item", "stock items")} in import batch #${r.batchId}; skipped ${skipped}.`;
  if (r.identityWarnings > 0) {
    const verb = r.identityWarnings === 1 ? "uses" : "use";
    details += ` ${r.identityWarnings} of the added items ${verb} an account already in stock with a different password.`;
  }
  if (r.unreadableExisting > 0) {
    const verb = r.unreadableExisting === 1 ? "item could not be read and was" : "items could not be read and were";
    details += ` ${r.unreadableExisting} existing ${verb} not checked for duplicates.`;
  }
  return details;
}

/**
 * Flip the still-AVAILABLE/RESERVED rows among `ids` to DEAD and record one
 * MARKED_DEAD event per row that actually changed, carrying that row's own
 * prior status. The rows are locked first, so the status the event names is
 * the status the update really replaced.
 *
 * The admin's `note` stays out of the event on purpose — admins paste
 * credentials into it. `reason` is the structured, credential-free why; it is
 * stored on the row and on the event, only for rows that really changed.
 */
async function markDead(db: Db, ids: number[], note: string, adminId: number, reason: DeadReason): Promise<number> {
  return inTransaction(db, async (tx) => {
    await lockStockRows(tx, ids);
    const eligible = { deletedAt: null, status: { in: [StockStatus.AVAILABLE, StockStatus.RESERVED] } };
    const rows = await tx.stockItem.findMany({
      where: { id: { in: ids }, ...eligible },
      select: { id: true, status: true },
    });
    if (!rows.length) return 0;
    const res = await tx.stockItem.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, ...eligible },
      // Releasing the claim lets the dead credential be imported again.
      data: { status: StockStatus.DEAD, note, deadReason: reason, activeCredentialKey: null },
    });
    const actor = adminActor(adminId);
    await recordStockEvents(
      tx,
      rows.map((r) => ({
        stockItemId: r.id,
        eventType: StockEventType.MARKED_DEAD,
        fromStatus: r.status,
        toStatus: StockStatus.DEAD,
        actor,
        reasonCode: reason,
      })),
    );
    return res.count;
  });
}

/**
 * Mark a single stock item dead. Only touches it if still AVAILABLE or
 * RESERVED — SOLD/already-DEAD rows are left alone so a delivered credential
 * is never altered (mirrors `bulkMarkStockDead`'s guard). Returns 1 if the
 * item was updated, 0 if it wasn't eligible (already SOLD/DEAD, or the id
 * doesn't exist) — callers must check this instead of assuming success.
 */
export async function markStockDead(
  db: Db,
  stockId: number,
  note: string,
  adminId: number,
  reason: DeadReason = DeadReason.OTHER,
): Promise<number> {
  return markDead(db, [stockId], note, adminId, reason);
}

/**
 * Bulk mark stock items dead in one writer. Only items still AVAILABLE or
 * RESERVED are touched — SOLD/already-DEAD rows are left alone so a delivered
 * credential is never altered. Returns the number actually updated.
 */
export async function bulkMarkStockDead(
  db: Db,
  ids: number[],
  note: string,
  adminId: number,
  reason: DeadReason = DeadReason.OTHER,
): Promise<number> {
  if (!ids.length) return 0;
  return markDead(db, ids, note, adminId, reason);
}

/**
 * Soft-delete the deletable rows among `ids` and record one SOFT_DELETED event
 * per row that actually was. A soft delete changes no status, so the event
 * carries none; the row's status is still on the row.
 */
async function softDelete(db: Db, ids: number[], adminId: number): Promise<number> {
  return inTransaction(db, async (tx) => {
    await lockStockRows(tx, ids);
    // SOLD rows and any row an order item points at are never deletable, so a
    // delivered credential can't be removed out from under an order.
    const deletable = { deletedAt: null, status: { not: StockStatus.SOLD }, orderItems: { none: {} } };
    const rows = await tx.stockItem.findMany({ where: { id: { in: ids }, ...deletable }, select: { id: true } });
    if (!rows.length) return 0;
    const res = await tx.stockItem.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, ...deletable },
      data: { deletedAt: new Date(), deletedByAdminId: adminId, activeCredentialKey: null },
    });
    const actor = adminActor(adminId);
    await recordStockEvents(
      tx,
      rows.map((r) => ({ stockItemId: r.id, eventType: StockEventType.SOFT_DELETED, actor })),
    );
    return res.count;
  });
}

/**
 * Soft-delete the selected stock rows (sets `deletedAt`/`deletedByAdminId`;
 * the row stays for the audit trail and every read filters it out). Two
 * guards keep fulfilled-order history intact: SOLD rows are never removed,
 * and any row referenced by an order item is skipped (so a delivered
 * credential can never be deleted out from under an order). Already-deleted
 * rows are left untouched. Returns the number actually deleted. Idempotent on
 * an empty list.
 */
export async function bulkDeleteStock(db: Db, ids: number[], adminId: number): Promise<number> {
  if (!ids.length) return 0;
  return softDelete(db, ids, adminId);
}

/**
 * Soft-delete one stock row. Same guard as bulkDeleteStock: refuses a SOLD
 * row, one referenced by an order item, or one already deleted. Returns true
 * if the row was actually deleted, false if the guard rejected it or the row
 * doesn't exist.
 */
export async function deleteStockItem(db: Db, stockId: number, adminId: number): Promise<boolean> {
  return (await softDelete(db, [stockId], adminId)) === 1;
}

/**
 * The remaining ready-to-sell credentials for a product, oldest first — used to
 * build the downloadable export. AVAILABLE only (the "stok tersisa"); never
 * RESERVED/SOLD/DEAD. An unreadable row is left out (and logged by id). Caller
 * is responsible for never logging the result.
 */
export async function listAvailableCredentials(db: Db, productId: number): Promise<string[]> {
  const rows = await db.stockItem.findMany({
    where: { productId, deletedAt: null, status: StockStatus.AVAILABLE },
    orderBy: { id: "asc" },
    select: { id: true, credentials: true },
  });
  return rows.flatMap((r) => {
    const plain = tryDecryptCredentials(r.credentials, { stockItemId: r.id, purpose: "the available-stock export" });
    return plain === null ? [] : [plain];
  });
}

/**
 * The single explicit-reveal read: decrypts ONE stock item's credential for
 * an admin who just asked to see it, and records a CREDENTIAL_REVEALED event
 * for every reveal (repeats included). Callers MUST also write the
 * `credential_revealed` audit row (see apps/web-admin/src/routes/api/stock.ts)
 * — that is what shop admins read; the event is the per-row traceability
 * trail — and should do both in one transaction. Nothing is recorded when the
 * decrypt throws. Returns null if the id doesn't exist or is soft-deleted.
 */
export async function revealStockCredentials(db: Db, stockId: number, adminId: number): Promise<string | null> {
  const item = await db.stockItem.findFirst({ where: { id: stockId, deletedAt: null }, select: { credentials: true } });
  if (!item) return null;
  const credentials = decryptStockCredentials(item.credentials, stockId);
  await recordStockEvent(db, {
    stockItemId: stockId,
    eventType: StockEventType.CREDENTIAL_REVEALED,
    actor: adminActor(adminId),
  });
  return credentials;
}

export function listStockItemsForProduct(db: Db, productId: number, limit = 30) {
  return db.stockItem.findMany({
    where: { productId, deletedAt: null },
    orderBy: [{ status: "asc" }, { id: "asc" }],
    take: limit,
  });
}

export async function countAvailableStock(db: Db, productId: number): Promise<number> {
  return db.stockItem.count({
    where: { productId, deletedAt: null, status: StockStatus.AVAILABLE },
  });
}

/**
 * Batched sibling of `countAvailableStock` — AVAILABLE stock counts for many
 * denominations in one grouped query (e.g. the Flash Sales admin table,
 * which needs a count per row without one query per row). A denomination
 * with zero AVAILABLE rows is simply absent from the Map; callers treat a
 * missing key as 0.
 */
export async function availableStockCountsByDenomination(
  db: Db,
  denominationIds: number[],
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (!denominationIds.length) return map;

  const rows = await db.stockItem.groupBy({
    by: ["productId"],
    where: { productId: { in: denominationIds }, deletedAt: null, status: StockStatus.AVAILABLE },
    _count: true,
  });
  for (const r of rows) {
    map.set(r.productId, r._count);
  }
  return map;
}

/**
 * Grab one AVAILABLE row, flip to RESERVED, link to the order, and record the
 * RESERVED event. Returns the reserved row or null if none available.
 *
 * SQLite serializes writers, so within a transaction this is race-free; we add
 * an optimistic guard (updateMany where status=AVAILABLE) and retry to be safe
 * under the interactive-transaction model. (migrate.md §5.4)
 *
 * The event is written only for the attempt that actually WON the conditional
 * update, so a row a caller lost the race for never gets a reservation it
 * doesn't hold. `orderItemId` is optional because not every caller knows the
 * line id (see approveOrder's substitution branch, which does); pass it
 * whenever it is known, since it is the only link back to the order line once
 * a release clears `OrderItem.stockItemId`.
 */
export async function allocateOneAvailableStock(
  db: Db,
  productId: number,
  orderId: number,
  actor: StockEventActor,
  orderItemId?: number | null,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = await db.stockItem.findFirst({
      where: { productId, deletedAt: null, status: StockStatus.AVAILABLE },
      orderBy: { id: "asc" },
    });
    if (!candidate) return null;

    const res = await db.stockItem.updateMany({
      where: { id: candidate.id, deletedAt: null, status: StockStatus.AVAILABLE },
      data: {
        status: StockStatus.RESERVED,
        orderId,
        reservedAt: new Date(),
      },
    });
    if (res.count === 1) {
      await recordStockEvent(db, {
        stockItemId: candidate.id,
        eventType: StockEventType.RESERVED,
        fromStatus: StockStatus.AVAILABLE,
        toStatus: StockStatus.RESERVED,
        orderId,
        orderItemId: orderItemId ?? null,
        actor,
      });
      return db.stockItem.findUnique({ where: { id: candidate.id } });
    }
    // Lost the race for this row — try the next available one.
  }
  return null;
}

/** A soft-deleted row reads as not found, so route guards need no extra check. */
export function getStockItem(db: Db, stockId: number) {
  return db.stockItem.findFirst({
    where: { id: stockId, deletedAt: null },
    include: { product: true },
  });
}

export async function setStockNote(db: Db, stockId: number, note: string | null) {
  await db.stockItem.update({ where: { id: stockId }, data: { note } });
}

/** product_id -> {available, reserved, sold, dead} via one grouped query. */
export async function stockStatusCounts(
  db: Db,
): Promise<Record<number, { available: number; reserved: number; sold: number; dead: number }>> {
  const rows = await db.stockItem.groupBy({
    by: ["productId", "status"],
    where: { deletedAt: null },
    _count: { id: true },
  });
  const result: Record<
    number,
    { available: number; reserved: number; sold: number; dead: number }
  > = {};
  for (const r of rows) {
    const bucket =
      result[r.productId] ??
      (result[r.productId] = { available: 0, reserved: 0, sold: 0, dead: 0 });
    const key = r.status.toLowerCase() as keyof typeof bucket;
    if (key in bucket) bucket[key] = r._count.id;
  }
  return result;
}

/** Scoped single-product sibling of stockStatusCounts — {available, reserved, sold, dead} for one product via one grouped query. */
export async function stockStatusCountsForProduct(
  db: Db,
  productId: number,
): Promise<{ available: number; reserved: number; sold: number; dead: number }> {
  const rows = await db.stockItem.groupBy({
    by: ["status"],
    where: { productId, deletedAt: null },
    _count: { id: true },
  });
  const result = { available: 0, reserved: 0, sold: 0, dead: 0 };
  for (const r of rows) {
    const key = r.status.toLowerCase() as keyof typeof result;
    if (key in result) result[key] = r._count.id;
  }
  return result;
}

/** Paginated list of stock items for a product, filtered by statuses, ordered by id. */
export function listStockItemsForProductPage(
  db: Db,
  productId: number,
  statuses: StockStatus[],
  opts: { limit: number; offset: number },
) {
  return db.stockItem.findMany({
    where: { productId, deletedAt: null, status: { in: statuses } },
    orderBy: { id: "asc" },
    take: opts.limit,
    skip: opts.offset,
  });
}

/** Count stock items for a product and status group — used for pagination total. */
export async function countStockItemsForStatuses(
  db: Db,
  productId: number,
  statuses: StockStatus[],
): Promise<number> {
  return db.stockItem.count({
    where: { productId, deletedAt: null, status: { in: statuses } },
  });
}

/** Search results are capped, not paginated (Task 2) — this scan is O(status
 * group) and unbounded rendering isn't worth supporting for an admin search
 * box. Exported so callers (the route) can detect the cap was hit instead of
 * presenting `matches.length` as if it were the real match count — the same
 * "silently capped number presented as exact" shape as the original bug this
 * branch fixes, just one layer up (final review, 2026-09-11). */
export const SEARCH_RESULT_CAP = 200;

/** Search stock credentials and notes by decrypted substring (case-insensitive). Scans the entire status group for correctness (encrypted columns can't be SQL-filtered), then caps returned results at SEARCH_RESULT_CAP. */
export async function searchStockCredentials(
  db: Db,
  productId: number,
  statuses: StockStatus[],
  query: string,
) {
  const rows = await db.stockItem.findMany({
    where: { productId, deletedAt: null, status: { in: statuses } },
    orderBy: { id: "asc" },
  });
  const q = query.toLowerCase();
  const matches = rows.filter((r) => {
    const plain = tryDecryptCredentials(r.credentials, { stockItemId: r.id, purpose: "the admin stock search" });
    // One unreadable row is a non-match, never an aborted scan.
    if (plain === null) return false;
    const cred = plain.toLowerCase();
    const note = (r.note ?? "").toLowerCase();
    return cred.includes(q) || note.includes(q);
  });
  return matches.slice(0, SEARCH_RESULT_CAP);
}
