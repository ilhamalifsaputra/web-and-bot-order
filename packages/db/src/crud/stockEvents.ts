/**
 * StockItemEvent ledger writer. Callers MUST invoke these inside the same
 * transaction as the status change they describe, so an event never exists
 * without its change (or vice versa).
 */
import type { Prisma } from "@prisma/client";
import { StockEventType, StockActorType } from "@app/core/enums";
import type { Db } from "./_types";

/**
 * Who caused an event. Passed down explicitly through every mutator that can
 * move a stock row (allocate/release/cancel/approve) rather than inferred
 * from a free-text reason string, so attribution survives refactors.
 */
export interface StockEventActor {
  type: StockActorType;
  adminId?: number | null;
  customerId?: number | null;
}

export interface StockEventInput {
  stockItemId: number;
  eventType: StockEventType;
  fromStatus?: string | null;
  toStatus?: string | null;
  orderId?: number | null;
  orderItemId?: number | null;
  actor: StockEventActor;
  reasonCode?: string | null;
  correlationId?: string | null;
  meta?: Prisma.InputJsonValue;
  /** When the change happened, if the caller already has an authoritative
   *  instant (e.g. the one it also stamps on a ledger posting, so the two
   *  agree). Omitted means now() — the column's own default. */
  occurredAt?: Date;
}

function toRow(e: StockEventInput): Prisma.StockItemEventUncheckedCreateInput {
  // Columns are plain Strings in the schema, so the TS enums are the only guard.
  if (!Object.values(StockEventType).includes(e.eventType)) {
    throw new Error(`Unknown stock event type "${String(e.eventType)}".`);
  }
  if (!Object.values(StockActorType).includes(e.actor.type)) {
    throw new Error(`Unknown stock event actor type "${String(e.actor.type)}".`);
  }
  return {
    stockItemId: e.stockItemId,
    eventType: e.eventType,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    orderId: e.orderId ?? null,
    orderItemId: e.orderItemId ?? null,
    actorType: e.actor.type,
    actorAdminId: e.actor.adminId ?? null,
    actorCustomerId: e.actor.customerId ?? null,
    reasonCode: e.reasonCode ?? null,
    correlationId: e.correlationId ?? null,
    meta: e.meta,
    // undefined (not null) so Prisma falls through to the column default; the
    // column is NOT NULL, so an explicit null would be rejected.
    occurredAt: e.occurredAt ?? undefined,
  };
}

export async function recordStockEvent(db: Db, event: StockEventInput) {
  return db.stockItemEvent.create({ data: toRow(event) });
}

/** Batch sibling — returns the number of rows written. */
export async function recordStockEvents(db: Db, events: StockEventInput[]): Promise<number> {
  if (!events.length) return 0;
  const res = await db.stockItemEvent.createMany({ data: events.map(toRow) });
  return res.count;
}
