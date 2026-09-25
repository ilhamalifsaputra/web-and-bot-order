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

/**
 * `count` is the true total (not capped); `sampleIds` is a bounded preview of
 * it, capped at SAMPLE_LIMIT.
 *
 * `count`'s unit is NOT the same across every field of StockIntegrityReport —
 * each field's own doc comment says which of these two conventions it uses:
 *   - "duplicate TARGETS": one offending id counts once no matter how many
 *     other rows point at it (duplicateStockItemPointers — a StockItem
 *     pointed at by 3 OrderItems still counts as 1, because there is exactly
 *     one StockItem an operator needs to go fix).
 *   - "duplicate PARTICIPANTS": every row that took part in a duplicate group
 *     counts (duplicateActiveCredentialFingerprints — 2 StockItem rows
 *     sharing one fingerprint report count:2, because there are two rows an
 *     operator has to go inspect/reassign).
 * They were kept as-is rather than unified because the two checks disagree on
 * what "the thing found" even is (a StockItem being pointed at, vs. a
 * StockItem participating in a duplicate pair) — see each field's comment.
 */
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
   * pointer duplication Fase 4b's unique constraint will forbid.
   * COUNT CONVENTION: duplicate TARGETS, not participants — one StockItem id
   * referenced by 3 OrderItems still counts as 1 here (there's exactly one
   * StockItem an operator needs to fix), not 3. `sampleIds` is StockItem ids,
   * a literal subset of what `count` counts. */
  duplicateStockItemPointers: IntegrityFinding;
  /** StockItem rows that are soft-deleted but still show RESERVED. */
  softDeletedStillReserved: IntegrityFinding;
  /** StockItem rows whose latest STATUS-TRANSITION StockItemEvent.toStatus
   * (i.e. an event with toStatus not null — CREDENTIAL_REVEALED/REENCRYPTED
   * and any other non-transition event type are skipped when finding "the
   * latest") disagrees with the row's own status column. Rows with zero
   * events are legacy data predating the event ledger and are excluded here
   * — see legacyRowsWithoutEvents. */
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
   * counts as a duplicate.
   * COUNT CONVENTION: duplicate PARTICIPANTS, not targets — a 2-row duplicate
   * group reports count:2 (both rows), not 1, because there is no single
   * "canonical" row in a fingerprint collision; every participating row is
   * something an operator has to go inspect. This differs from
   * duplicateStockItemPointers above; see IntegrityFinding's doc comment. */
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
 * A row's latest STATUS TRANSITION event by (occurredAt, id) — id as the
 * tiebreaker for events written in the same instant. Deliberately restricted
 * to `to_status IS NOT NULL` events: recordStockEvent defaults `toStatus` to
 * NULL for event types that aren't a status change at all (CREDENTIAL_REVEALED
 * — stock.ts's revealStockCredentials — and REENCRYPTED — the backfill
 * script), and reveals in particular are routine, frequent admin actions. If
 * "latest event" meant "latest event of any type", a reveal or re-encrypt
 * landing after the real last transition would make every such row look like
 * drift, even though its status is perfectly consistent with its transition
 * history — this is not "skip flagging when the latest happens to be null",
 * it is "keep looking further back until a real transition event is found".
 * Split into a count query and a bounded sample query (rather than fetching
 * every StockItem row) so this scales against a production-sized table.
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
      WHERE e.stock_item_id = si.id AND e.to_status IS NOT NULL
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
      WHERE e.stock_item_id = si.id AND e.to_status IS NOT NULL
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
