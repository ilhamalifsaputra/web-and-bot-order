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

/** One row of a stock item's timeline. Deliberately has no credentials and no
 *  raw `meta`: the history is safe to show to any admin without a reveal audit. */
export interface StockItemEventView {
  id: number;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  reasonCode: string | null;
  actorType: string;
  /** Admin/customer display name; null for SYSTEM events or an unset name. */
  actorName: string | null;
  orderId: number | null;
  orderCode: string | null;
  occurredAt: Date;
}

const displayName = (u: { fullName: string | null; username: string | null; loginUsername: string | null; id: number }) =>
  u.fullName || u.username || u.loginUsername || `User #${u.id}`;

/**
 * Full event timeline of one stock item, oldest first (occurredAt, then id).
 * Returns null when the stock item does not exist at all; a soft-deleted item
 * still has its history (the audit trail outlives the delete).
 */
export async function listStockItemEvents(db: Db, stockItemId: number): Promise<StockItemEventView[] | null> {
  const item = await db.stockItem.findUnique({ where: { id: stockItemId }, select: { id: true } });
  if (!item) return null;
  const userSelect = { id: true, fullName: true, username: true, loginUsername: true } as const;
  const rows = await db.stockItemEvent.findMany({
    where: { stockItemId },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      eventType: true,
      fromStatus: true,
      toStatus: true,
      reasonCode: true,
      actorType: true,
      orderId: true,
      occurredAt: true,
      actorAdmin: { select: userSelect },
      actorCustomer: { select: userSelect },
    },
  });
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((x): x is number => x !== null))];
  const orders = orderIds.length
    ? await db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderCode: true } })
    : [];
  const codeById = new Map(orders.map((o) => [o.id, o.orderCode]));
  return rows.map((r) => {
    const who = r.actorAdmin ?? r.actorCustomer;
    return {
      id: r.id,
      eventType: r.eventType,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      reasonCode: r.reasonCode,
      actorType: r.actorType,
      actorName: who ? displayName(who) : null,
      orderId: r.orderId,
      orderCode: r.orderId === null ? null : (codeById.get(r.orderId) ?? null),
      occurredAt: r.occurredAt,
    };
  });
}
