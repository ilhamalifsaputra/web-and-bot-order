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
import { StockStatus } from "@app/core/enums";
import { encryptCredentials, decryptCredentials } from "@app/core/credentialCrypto";
import type { Db } from "./_types";

/**
 * Bulk-insert AVAILABLE stock, deduping against the incoming batch itself
 * (e.g. the same CSV pasted twice) AND against existing
 * AVAILABLE/RESERVED/SOLD rows for this product — two identical credential
 * strings stored as separate AVAILABLE rows could later be allocated to TWO
 * different buyers, delivering the same digital account twice (Stock-1 fix,
 * security audit 2026-06-23). `skipped` covers both kinds of duplicates so
 * the caller can report one honest total to the admin.
 *
 * Dedup can no longer filter existing rows in SQL (`credentials: { in: ... }`):
 * each encryption uses a fresh random IV, so the same plaintext never
 * produces the same stored ciphertext twice, and there is nothing left in the
 * column for a plaintext `IN (...)` match to find. Instead this fetches every
 * existing AVAILABLE/RESERVED/SOLD row for the product and decrypts each to
 * compare — O(existing rows) per call, acceptable for what's documented
 * (Task 2 brief) as a low-volume table.
 */
export async function bulkAddStock(
  db: Db,
  productId: number,
  credentials: string[],
): Promise<{ added: number; skipped: number }> {
  if (credentials.length === 0) return { added: 0, skipped: 0 };

  const deduped = [...new Set(credentials)];
  const existingRows = await db.stockItem.findMany({
    where: {
      productId,
      status: { in: [StockStatus.AVAILABLE, StockStatus.RESERVED, StockStatus.SOLD] },
    },
    select: { credentials: true },
  });
  const existing = new Set(existingRows.map((r) => decryptCredentials(r.credentials)));
  const fresh = deduped.filter((c) => !existing.has(c));

  if (fresh.length === 0) return { added: 0, skipped: credentials.length };

  const res = await db.stockItem.createMany({
    data: fresh.map((c) => ({
      productId,
      credentials: encryptCredentials(c),
      status: StockStatus.AVAILABLE,
    })),
  });
  return { added: res.count, skipped: credentials.length - res.count };
}

/**
 * Mark a single stock item dead. Only touches it if still AVAILABLE or
 * RESERVED — SOLD/already-DEAD rows are left alone so a delivered credential
 * is never altered (mirrors `bulkMarkStockDead`'s guard). Returns 1 if the
 * item was updated, 0 if it wasn't eligible (already SOLD/DEAD, or the id
 * doesn't exist) — callers must check this instead of assuming success.
 */
export async function markStockDead(db: Db, stockId: number, note: string): Promise<number> {
  const res = await db.stockItem.updateMany({
    where: { id: stockId, status: { in: [StockStatus.AVAILABLE, StockStatus.RESERVED] } },
    data: { status: StockStatus.DEAD, note },
  });
  return res.count;
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
): Promise<number> {
  if (!ids.length) return 0;
  const res = await db.stockItem.updateMany({
    where: { id: { in: ids }, status: { in: [StockStatus.AVAILABLE, StockStatus.RESERVED] } },
    data: { status: StockStatus.DEAD, note },
  });
  return res.count;
}

/**
 * Hard-delete the selected stock rows. Two guards keep fulfilled-order history
 * intact: SOLD rows are never removed, and any row referenced by an order item
 * is skipped (so a delivered credential can never be deleted out from under an
 * order). Returns the number actually deleted. Idempotent on an empty list.
 */
export async function bulkDeleteStock(db: Db, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const res = await db.stockItem.deleteMany({
    where: {
      id: { in: ids },
      status: { not: StockStatus.SOLD },
      orderItems: { none: {} },
    },
  });
  return res.count;
}

/**
 * Hard-delete one stock row. Same guard as bulkDeleteStock: refuses a SOLD
 * row or one referenced by an order item (a delivered credential must
 * never be deleted out from under an order). Returns true if the row was
 * actually deleted, false if the guard rejected it or the row doesn't
 * exist.
 */
export async function deleteStockItem(db: Db, stockId: number): Promise<boolean> {
  const res = await db.stockItem.deleteMany({
    where: { id: stockId, status: { not: StockStatus.SOLD }, orderItems: { none: {} } },
  });
  return res.count === 1;
}

/**
 * The remaining ready-to-sell credentials for a product, oldest first — used to
 * build the downloadable export. AVAILABLE only (the "stok tersisa"); never
 * RESERVED/SOLD/DEAD. Caller is responsible for never logging the result.
 */
export async function listAvailableCredentials(db: Db, productId: number): Promise<string[]> {
  const rows = await db.stockItem.findMany({
    where: { productId, status: StockStatus.AVAILABLE },
    orderBy: { id: "asc" },
    select: { credentials: true },
  });
  return rows.map((r) => decryptCredentials(r.credentials));
}

/**
 * The single explicit-reveal read: decrypts ONE stock item's credential for
 * an admin who just asked to see it. Callers MUST audit this as
 * `credential_revealed` (see apps/web-admin/src/routes/api/stock.ts) — this
 * function itself does not write the audit row, since it has no admin id to
 * attribute it to. Returns null if the id doesn't exist.
 */
export async function revealStockCredentials(db: Db, stockId: number): Promise<string | null> {
  const item = await db.stockItem.findUnique({ where: { id: stockId }, select: { credentials: true } });
  if (!item) return null;
  return decryptCredentials(item.credentials);
}

export function listStockItemsForProduct(db: Db, productId: number, limit = 30) {
  return db.stockItem.findMany({
    where: { productId },
    orderBy: [{ status: "asc" }, { id: "asc" }],
    take: limit,
  });
}

export async function countAvailableStock(db: Db, productId: number): Promise<number> {
  return db.stockItem.count({
    where: { productId, status: StockStatus.AVAILABLE },
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
    where: { productId: { in: denominationIds }, status: StockStatus.AVAILABLE },
    _count: true,
  });
  for (const r of rows) {
    map.set(r.productId, r._count);
  }
  return map;
}

/**
 * Grab one AVAILABLE row, flip to RESERVED, link to the order. Returns the
 * reserved row or null if none available.
 *
 * SQLite serializes writers, so within a transaction this is race-free; we add
 * an optimistic guard (updateMany where status=AVAILABLE) and retry to be safe
 * under the interactive-transaction model. (migrate.md §5.4)
 */
export async function allocateOneAvailableStock(
  db: Db,
  productId: number,
  orderId: number,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = await db.stockItem.findFirst({
      where: { productId, status: StockStatus.AVAILABLE },
      orderBy: { id: "asc" },
    });
    if (!candidate) return null;

    const res = await db.stockItem.updateMany({
      where: { id: candidate.id, status: StockStatus.AVAILABLE },
      data: {
        status: StockStatus.RESERVED,
        orderId,
        reservedAt: new Date(),
      },
    });
    if (res.count === 1) {
      return db.stockItem.findUnique({ where: { id: candidate.id } });
    }
    // Lost the race for this row — try the next available one.
  }
  return null;
}

export function getStockItem(db: Db, stockId: number) {
  return db.stockItem.findUnique({
    where: { id: stockId },
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
