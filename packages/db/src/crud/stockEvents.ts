/**
 * StockItemEvent ledger writer. Callers MUST invoke these inside the same
 * transaction as the status change they describe, so an event never exists
 * without its change (or vice versa).
 */
import type { Prisma } from "@prisma/client";
import { StockEventType, StockActorType } from "@app/core/enums";
import type { Db } from "./_types";

export interface StockEventInput {
  stockItemId: number;
  eventType: StockEventType;
  fromStatus?: string | null;
  toStatus?: string | null;
  orderId?: number | null;
  orderItemId?: number | null;
  actor: { type: StockActorType; adminId?: number | null; customerId?: number | null };
  reasonCode?: string | null;
  correlationId?: string | null;
  meta?: Prisma.InputJsonValue;
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
