/**
 * Read-only StockItem/OrderItem integrity report (stock traceability
 * hardening plan, Fase 4a). Every check here is a SELECT/COUNT — nothing in
 * this file ever writes a row, and no query touches or returns
 * `StockItem.credentials` (encrypted) or its decrypted form, only ids and
 * status/enum values.
 *
 * These checks stand in for DB-level CHECK constraints and a partial unique
 * index, which this repo cannot rely on: the real deploy path is
 * `prisma db push`, not `prisma migrate deploy` (docs/MIGRATIONS.md), and
 * `db push` never applies raw-SQL-only constructs (precedent:
 * schema.prisma's abandoned partial unique index on Payment). Findings from
 * this checker — and from scripts/audit-stock-duplicates.sql run against
 * production — gate Fase 4b's `@unique` column on OrderItem.stockItemId.
 *
 * Each finding reports a `count` (the true total) and a `sampleIds` array
 * capped at SAMPLE_LIMIT, so a large production table never turns this report
 * itself into an unbounded id dump.
 */
import { StockStatus, OrderStatus } from "@app/core/enums";
import type { Db } from "./_types";

const SAMPLE_LIMIT = 20;

/** `SELECT COUNT(*)...` always returns exactly one row; this only exists to
 * satisfy noUncheckedIndexedAccess without an `!` at every call site. */
function firstCount(rows: { count: number }[]): number {
  return rows[0]?.count ?? 0;
}

export interface IntegrityFinding {
  count: number;
  sampleIds: number[];
}

export interface StockIntegrityReport {
  /** StockItem rows RESERVED or SOLD with no owning order. */
  reservedOrSoldWithoutOrderId: IntegrityFinding;
  /** StockItem rows SOLD with no soldAt timestamp. */
  soldWithoutSoldAt: IntegrityFinding;
  /** StockItem rows whose status column is not one of the StockStatus values. */
  statusOutsideEnum: IntegrityFinding;
  /** StockItem ids referenced by more than one OrderItem.stockItemId — the
   * pointer duplication Fase 4b's unique constraint will forbid. */
  duplicateStockItemPointers: IntegrityFinding;
  /** StockItem rows that are soft-deleted but still show RESERVED. */
  softDeletedStillReserved: IntegrityFinding;
  /** StockItem rows whose latest StockItemEvent.toStatus disagrees with the
   * row's own status column. Rows with zero events are legacy data predating
   * the event ledger and are excluded here — see legacyRowsWithoutEvents. */
  statusEventMismatch: IntegrityFinding;
  /** Count of StockItem rows with zero StockItemEvent rows — legacy data
   * written before the event ledger existed. Reported as a plain count (not a
   * defect), and never mixed into statusEventMismatch. */
  legacyRowsWithoutEvents: number;
  /** OrderItem rows still pointing at a StockItem while their order is
   * CANCELLED/REJECTED. releaseOrderHolds (Fase 3b) nulls this pointer on
   * cancel/reject going forward; a non-zero count here is pre-3b legacy data. */
  cancelledOrRejectedOrderItemsStillLinked: IntegrityFinding;
  /** StockItem rows sharing a credentialFingerprint with another active
   * (non-DEAD, non-deleted) row of the SAME denomination. All-NULL tolerant:
   * Fase 5 has not populated this column yet, so a NULL fingerprint never
   * counts as a duplicate. */
  duplicateActiveCredentialFingerprints: IntegrityFinding;
}

async function checkReservedOrSoldWithoutOrderId(db: Db): Promise<IntegrityFinding> {
  const where = { status: { in: [StockStatus.RESERVED, StockStatus.SOLD] as string[] }, orderId: null };
  const count = await db.stockItem.count({ where });
  if (count === 0) return { count, sampleIds: [] };
  const rows = await db.stockItem.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, take: SAMPLE_LIMIT });
  return { count, sampleIds: rows.map((r) => r.id) };
}

async function checkSoldWithoutSoldAt(db: Db): Promise<IntegrityFinding> {
  const where = { status: StockStatus.SOLD, soldAt: null };
  const count = await db.stockItem.count({ where });
  if (count === 0) return { count, sampleIds: [] };
  const rows = await db.stockItem.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, take: SAMPLE_LIMIT });
  return { count, sampleIds: rows.map((r) => r.id) };
}

async function checkStatusOutsideEnum(db: Db): Promise<IntegrityFinding> {
  const where = { status: { notIn: Object.values(StockStatus) } };
  const count = await db.stockItem.count({ where });
  if (count === 0) return { count, sampleIds: [] };
  const rows = await db.stockItem.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, take: SAMPLE_LIMIT });
  return { count, sampleIds: rows.map((r) => r.id) };
}

async function checkSoftDeletedStillReserved(db: Db): Promise<IntegrityFinding> {
  const where = { status: StockStatus.RESERVED, deletedAt: { not: null } };
  const count = await db.stockItem.count({ where });
  if (count === 0) return { count, sampleIds: [] };
  const rows = await db.stockItem.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, take: SAMPLE_LIMIT });
  return { count, sampleIds: rows.map((r) => r.id) };
}

async function checkDuplicateStockItemPointers(db: Db): Promise<IntegrityFinding> {
  const count = firstCount(await db.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM (
      SELECT stock_item_id
      FROM order_items
      WHERE stock_item_id IS NOT NULL
      GROUP BY stock_item_id
      HAVING COUNT(*) > 1
    ) dup
  `);
  if (count === 0) return { count: 0, sampleIds: [] };
  const rows = await db.$queryRaw<{ stock_item_id: number }[]>`
    SELECT stock_item_id
    FROM order_items
    WHERE stock_item_id IS NOT NULL
    GROUP BY stock_item_id
    HAVING COUNT(*) > 1
    ORDER BY stock_item_id ASC
    LIMIT ${SAMPLE_LIMIT}
  `;
  return { count, sampleIds: rows.map((r) => r.stock_item_id) };
}

/**
 * A row's latest event by (occurredAt, id) — id as the tiebreaker for events
 * written in the same millisecond, same ordering `stock_events.test.ts`
 * asserts the ledger keeps. Split into a count query and a bounded sample
 * query (rather than fetching every StockItem row) so this scales against a
 * production-sized table.
 */
async function checkStatusEventMismatchAndLegacy(
  db: Db,
): Promise<{ mismatch: IntegrityFinding; legacyCount: number }> {
  // Sequential, not Promise.all: `db` may be an interactive transaction
  // client, which Prisma only allows one in-flight query on at a time.
  const legacyCount = firstCount(await db.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM stock_items si
    WHERE NOT EXISTS (SELECT 1 FROM stock_item_events e WHERE e.stock_item_id = si.id)
  `);
  const mismatchCount = firstCount(await db.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM stock_items si
    JOIN LATERAL (
      SELECT to_status FROM stock_item_events e
      WHERE e.stock_item_id = si.id
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1
    ) e ON true
    WHERE e.to_status IS DISTINCT FROM si.status
  `);

  if (mismatchCount === 0) return { mismatch: { count: 0, sampleIds: [] }, legacyCount };

  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT si.id
    FROM stock_items si
    JOIN LATERAL (
      SELECT to_status FROM stock_item_events e
      WHERE e.stock_item_id = si.id
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1
    ) e ON true
    WHERE e.to_status IS DISTINCT FROM si.status
    ORDER BY si.id ASC
    LIMIT ${SAMPLE_LIMIT}
  `;
  return { mismatch: { count: mismatchCount, sampleIds: rows.map((r) => r.id) }, legacyCount };
}

async function checkCancelledOrRejectedOrderItemsStillLinked(db: Db): Promise<IntegrityFinding> {
  const where = {
    stockItemId: { not: null },
    order: { status: { in: [OrderStatus.CANCELLED, OrderStatus.REJECTED] as string[] } },
  };
  const count = await db.orderItem.count({ where });
  if (count === 0) return { count: 0, sampleIds: [] };
  const rows = await db.orderItem.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, take: SAMPLE_LIMIT });
  return { count, sampleIds: rows.map((r) => r.id) };
}

/**
 * "Active" = not DEAD and not soft-deleted. "Duplicate" = another active row
 * of the SAME denomination shares this exact fingerprint. NULL-tolerant by
 * construction: the WHERE clause requires `credential_fingerprint IS NOT
 * NULL`, so two NULLs are never compared as equal (Fase 5 has not populated
 * this column yet — every row is NULL today, and that must report zero).
 */
async function checkDuplicateActiveCredentialFingerprints(db: Db): Promise<IntegrityFinding> {
  const dead = StockStatus.DEAD;
  const count = firstCount(await db.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM stock_items si
    WHERE si.credential_fingerprint IS NOT NULL
      AND si.status != ${dead}
      AND si.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM stock_items other
        WHERE other.product_id = si.product_id
          AND other.credential_fingerprint = si.credential_fingerprint
          AND other.status != ${dead}
          AND other.deleted_at IS NULL
          AND other.id != si.id
      )
  `);
  if (count === 0) return { count: 0, sampleIds: [] };

  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT si.id
    FROM stock_items si
    WHERE si.credential_fingerprint IS NOT NULL
      AND si.status != ${dead}
      AND si.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM stock_items other
        WHERE other.product_id = si.product_id
          AND other.credential_fingerprint = si.credential_fingerprint
          AND other.status != ${dead}
          AND other.deleted_at IS NULL
          AND other.id != si.id
      )
    ORDER BY si.id ASC
    LIMIT ${SAMPLE_LIMIT}
  `;
  return { count, sampleIds: rows.map((r) => r.id) };
}

export async function checkStockIntegrity(db: Db): Promise<StockIntegrityReport> {
  const reservedOrSoldWithoutOrderId = await checkReservedOrSoldWithoutOrderId(db);
  const soldWithoutSoldAt = await checkSoldWithoutSoldAt(db);
  const statusOutsideEnum = await checkStatusOutsideEnum(db);
  const duplicateStockItemPointers = await checkDuplicateStockItemPointers(db);
  const softDeletedStillReserved = await checkSoftDeletedStillReserved(db);
  const { mismatch: statusEventMismatch, legacyCount: legacyRowsWithoutEvents } =
    await checkStatusEventMismatchAndLegacy(db);
  const cancelledOrRejectedOrderItemsStillLinked = await checkCancelledOrRejectedOrderItemsStillLinked(db);
  const duplicateActiveCredentialFingerprints = await checkDuplicateActiveCredentialFingerprints(db);

  return {
    reservedOrSoldWithoutOrderId,
    soldWithoutSoldAt,
    statusOutsideEnum,
    duplicateStockItemPointers,
    softDeletedStillReserved,
    statusEventMismatch,
    legacyRowsWithoutEvents,
    cancelledOrRejectedOrderItemsStillLinked,
    duplicateActiveCredentialFingerprints,
  };
}
