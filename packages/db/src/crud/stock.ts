/**
 * Stock domain — port of the "Stock" section of Python crud.py, including the
 * reserved-stock allocation that prevents two buyers grabbing the same row.
 */
import { StockStatus } from "@app/core/enums";
import type { Db } from "./_types";

/**
 * Bulk-insert AVAILABLE stock, deduping against the incoming batch itself
 * (e.g. the same CSV pasted twice) AND against existing
 * AVAILABLE/RESERVED/SOLD rows for this product — two identical credential
 * strings stored as separate AVAILABLE rows could later be allocated to TWO
 * different buyers, delivering the same digital account twice (Stock-1 fix,
 * security audit 2026-06-23). `skipped` covers both kinds of duplicates so
 * the caller can report one honest total to the admin.
 */
export async function bulkAddStock(
  db: Db,
  productId: number,
  credentials: string[],
): Promise<{ added: number; skipped: number }> {
  if (credentials.length === 0) return { added: 0, skipped: 0 };

  const deduped = [...new Set(credentials)];
  const existing = new Set(
    (
      await db.stockItem.findMany({
        where: {
          productId,
          credentials: { in: deduped },
          status: { in: [StockStatus.AVAILABLE, StockStatus.RESERVED, StockStatus.SOLD] },
        },
        select: { credentials: true },
      })
    ).map((r) => r.credentials),
  );
  const fresh = deduped.filter((c) => !existing.has(c));

  if (fresh.length === 0) return { added: 0, skipped: credentials.length };

  const res = await db.stockItem.createMany({
    data: fresh.map((c) => ({
      productId,
      credentials: c,
      status: StockStatus.AVAILABLE,
    })),
  });
  return { added: res.count, skipped: credentials.length - res.count };
}

export async function markStockDead(db: Db, stockId: number, note: string) {
  await db.stockItem.update({
    where: { id: stockId },
    data: { status: StockStatus.DEAD, note },
  });
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
  return rows.map((r) => r.credentials);
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
