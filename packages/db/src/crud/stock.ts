/**
 * Stock domain — port of the "Stock" section of Python crud.py, including the
 * reserved-stock allocation that prevents two buyers grabbing the same row.
 */
import { StockStatus } from "@app/core/enums";
import type { Db } from "./_types";

export async function bulkAddStock(
  db: Db,
  productId: number,
  credentials: string[],
): Promise<number> {
  if (credentials.length === 0) return 0;
  const res = await db.stockItem.createMany({
    data: credentials.map((c) => ({
      productId,
      credentials: c,
      status: StockStatus.AVAILABLE,
    })),
  });
  return res.count;
}

export async function markStockDead(db: Db, stockId: number, note: string) {
  await db.stockItem.update({
    where: { id: stockId },
    data: { status: StockStatus.DEAD, note },
  });
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
