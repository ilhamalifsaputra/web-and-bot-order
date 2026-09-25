/**
 * Order-side StockItemEvent ledger (stock-traceability hardening, Fase 3b).
 *
 * One stock row's whole life, as the event ledger sees it: reserved by a
 * checkout, released when that order is cancelled, reserved again by a
 * DIFFERENT buyer, then sold. The sequence is the point — each transition has
 * to leave exactly one event carrying who caused it and which order item it
 * belonged to, because that ledger is the only trace left once
 * `releaseOrderHolds` clears `OrderItem.stockItemId` (audit L-6).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  cancelOrder,
  approveOrder,
  attachPaymentProof,
  markStockDead,
  deleteStockItem,
  upsertUser,
} from "@app/db";
import { checkStockIntegrity } from "./stockIntegrity";
import { OrderStatus, StockActorType, StockEventType, StockStatus } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

/** Leave exactly one AVAILABLE row so both orders in a scenario are forced
 *  onto the SAME stock row — that collision is what the ledger has to keep
 *  legible. Mirrors stock_concurrency.test.ts's helper of the same name. */
async function reduceStockTo(productId: number, keep: number) {
  const items = await prisma.stockItem.findMany({ where: { productId }, orderBy: { id: "asc" } });
  for (const item of items.slice(keep)) {
    await markStockDead(prisma, item.id, "test: reduced to force one shared row", sample.user.id);
  }
}

// The fixture's IMPORTED event predates every order; this file is about what the
// order side adds to a row's ledger (the full chain is in stock_events.test.ts).
const eventsFor = (stockItemId: number) =>
  prisma.stockItemEvent.findMany({
    where: { stockItemId, eventType: { not: StockEventType.IMPORTED } },
    orderBy: { id: "asc" },
  });

describe("stock event ledger across an order's lifecycle", () => {
  it("reserve → cancel → re-reserve by another buyer → sold leaves one event per transition", async () => {
    const { product, user } = sample;
    await reduceStockTo(product.id, 1);
    const row = (await prisma.stockItem.findFirst({ where: { productId: product.id, status: StockStatus.AVAILABLE } }))!;

    // 1. Buyer A reserves the row.
    const first = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
    const firstItem = (await prisma.orderItem.findFirstOrThrow({ where: { orderId: first.id } }));
    expect(firstItem.stockItemId).toBe(row.id);

    let events = await eventsFor(row.id);
    expect(events.map((e) => e.eventType)).toEqual([StockEventType.RESERVED]);
    expect(events[0]).toMatchObject({
      fromStatus: StockStatus.AVAILABLE,
      toStatus: StockStatus.RESERVED,
      orderId: first.id,
      orderItemId: firstItem.id,
      actorType: StockActorType.CUSTOMER,
      actorCustomerId: user.id,
      actorAdminId: null,
    });

    // 2. Buyer A cancels — the row goes back to AVAILABLE and the OrderItem
    //    stops pointing at it (L-6), so only the ledger still ties the two.
    await cancelOrder(prisma, first.id, "user_cancelled", {
      type: StockActorType.CUSTOMER,
      customerId: user.id,
    });

    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(StockStatus.AVAILABLE);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: firstItem.id } })).stockItemId).toBeNull();

    events = await eventsFor(row.id);
    expect(events.map((e) => e.eventType)).toEqual([
      StockEventType.RESERVED,
      StockEventType.RESERVATION_RELEASED,
    ]);
    expect(events[1]).toMatchObject({
      fromStatus: StockStatus.RESERVED,
      toStatus: StockStatus.AVAILABLE,
      orderId: first.id,
      orderItemId: firstItem.id,
      actorType: StockActorType.CUSTOMER,
      actorCustomerId: user.id,
    });

    // 3. A different buyer reserves the very same row.
    const buyerB = await upsertUser(prisma, { telegramId: 777001, username: "buyer-b", fullName: "Buyer B" });
    const second = (await createOrderDirect(prisma, { user: buyerB, productId: product.id, quantity: 1 }))!;
    const secondItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: second.id } });
    expect(secondItem.stockItemId).toBe(row.id);

    // Exactly one OrderItem points at the row — the duplicate pointer L-6
    // describes would show up right here.
    const pointers = await prisma.orderItem.findMany({ where: { stockItemId: row.id } });
    expect(pointers.map((p) => p.id)).toEqual([secondItem.id]);

    // 4. Buyer B pays and is approved: RESERVED → SOLD.
    await attachPaymentProof(prisma, second.id, { fileId: "dummy", txid: "ABC123XYZ" });
    await approveOrder(prisma, second.id, { adminId: 0 });

    events = await eventsFor(row.id);
    expect(events.map((e) => e.eventType)).toEqual([
      StockEventType.RESERVED,
      StockEventType.RESERVATION_RELEASED,
      StockEventType.RESERVED,
      StockEventType.SOLD,
    ]);
    expect(events[2]).toMatchObject({
      orderId: second.id,
      orderItemId: secondItem.id,
      actorType: StockActorType.CUSTOMER,
      actorCustomerId: buyerB.id,
    });
    // adminId 0 = an auto-confirm poller settling the payment, not a person.
    expect(events[3]).toMatchObject({
      fromStatus: StockStatus.RESERVED,
      toStatus: StockStatus.SOLD,
      orderId: second.id,
      orderItemId: secondItem.id,
      actorType: StockActorType.SYSTEM,
      actorAdminId: null,
      actorCustomerId: null,
    });

    const sold = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(sold.status).toBe(StockStatus.SOLD);
    expect(sold.soldToOrderId).toBe(second.id);
    expect(sold.soldToOrderItemId).toBe(secondItem.id);
    // warrantyDays 30 on the sample denomination (tests/helpers/sampleData.ts).
    expect(sold.warrantyUntil).not.toBeNull();
    expect(sold.warrantyUntil!.getTime() - sold.soldAt!.getTime()).toBe(30 * 86_400_000);
  });

  it("an admin cancel is attributed to that admin, not to the buyer", async () => {
    const { product, user } = sample;
    const admin = await upsertUser(prisma, { telegramId: 777002, username: "admin-x", fullName: "Admin X" });
    const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });

    await cancelOrder(prisma, order.id, "admin_cancelled: duplicate order", {
      type: StockActorType.ADMIN,
      adminId: admin.id,
    });

    const released = await prisma.stockItemEvent.findFirstOrThrow({
      where: { stockItemId: item.stockItemId!, eventType: StockEventType.RESERVATION_RELEASED },
    });
    expect(released).toMatchObject({
      actorType: StockActorType.ADMIN,
      actorAdminId: admin.id,
      actorCustomerId: null,
    });
  });

  it("a release that no longer owns the row leaves the new reservation alone", async () => {
    // The stall window: an expiry sweep reads order O1 while its row R is
    // RESERVED, then stalls. An admin cancel of O1 completes first, R goes back
    // to AVAILABLE and a second buyer's order O2 re-reserves it. When the
    // stalled sweep finally writes, R belongs to O2 — releasing it anyway would
    // steal a live reservation out from under a paying buyer and log a
    // RESERVATION_RELEASED that never happened for O1.
    //
    // The fixture below builds that window's COMMITTED state directly (O1 still
    // open and still pointing at R, R reserved by O2) rather than racing two
    // real callers, because the staleness lives in the caller's in-memory order
    // snapshot and a race would be nondeterministic. The release guard is
    // status- and owner-blind either way, so a plain cancelOrder on this state
    // exercises exactly the same defect.
    const { product, user } = sample;
    await reduceStockTo(product.id, 1);

    const first = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
    const firstItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: first.id } });
    const rowId = firstItem.stockItemId!;

    // The winning cancel released R (status only — O1's pointer is what the
    // stalled caller still holds), and buyer B's order then took it.
    await prisma.stockItem.update({
      where: { id: rowId },
      data: { status: StockStatus.AVAILABLE, orderId: null, reservedAt: null },
    });
    const buyerB = await upsertUser(prisma, { telegramId: 777003, username: "buyer-c", fullName: "Buyer C" });
    const second = (await createOrderDirect(prisma, { user: buyerB, productId: product.id, quantity: 1 }))!;
    const secondItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: second.id } });
    expect(secondItem.stockItemId).toBe(rowId);

    // The stalled sweep finally commits.
    await cancelOrder(prisma, first.id, "expired", { type: StockActorType.SYSTEM });

    // Buyer B keeps the row and the pointer.
    const row = await prisma.stockItem.findUniqueOrThrow({ where: { id: rowId } });
    expect(row.status).toBe(StockStatus.RESERVED);
    expect(row.orderId).toBe(second.id);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: secondItem.id } })).stockItemId).toBe(rowId);

    // And nothing was logged claiming O1 released it.
    const falseReleases = await prisma.stockItemEvent.findMany({
      where: { stockItemId: rowId, eventType: StockEventType.RESERVATION_RELEASED, orderId: first.id },
    });
    expect(falseReleases).toEqual([]);

    // The cancel itself still succeeded — a row it no longer owns is skipped,
    // not an error.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(OrderStatus.CANCELLED);
  });

  it("a row marked DEAD between approve's read and its claim is substituted, never sold", async () => {
    // The race: approveOrder reads the order (row R is RESERVED), then an admin
    // marks R dead and commits, then approve claims the order. Approve must not
    // deliver R off its stale snapshot — the buyer would get a credential the
    // admin just declared dead. The proxy runs markStockDead at exactly that
    // moment: right before the order claim, after the read.
    const { product, user } = sample;
    const admin = await upsertUser(prisma, { telegramId: 777004, username: "admin-d", fullName: "Admin D" });
    const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    const deadId = item.stockItemId!;
    await attachPaymentProof(prisma, order.id, { fileId: "dummy", txid: "RACE123XYZ" });

    let fired = false;
    const racing = new Proxy(prisma, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop !== "order") return typeof value === "function" ? value.bind(target) : value;
        const delegate = value as PrismaClient["order"];
        return new Proxy(delegate, {
          get(d, p) {
            const fn = Reflect.get(d, p, d) as unknown;
            if (p === "updateMany" && !fired) {
              return async (args: Parameters<PrismaClient["order"]["updateMany"]>[0]) => {
                fired = true;
                expect(await markStockDead(prisma, deadId, "died mid-approve", admin.id)).toBe(1);
                return delegate.updateMany(args);
              };
            }
            return typeof fn === "function" ? fn.bind(d) : fn;
          },
        });
      },
    }) as PrismaClient;

    const { credentials } = await approveOrder(racing, order.id, { adminId: admin.id });
    expect(fired).toBe(true);

    const dead = await prisma.stockItem.findUniqueOrThrow({ where: { id: deadId } });
    expect(dead.status).toBe(StockStatus.DEAD);
    expect(dead.soldToOrderId).toBeNull();
    expect(dead.soldAt).toBeNull();

    const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(line.stockItemId).not.toBe(deadId);
    const sub = await prisma.stockItem.findUniqueOrThrow({ where: { id: line.stockItemId! } });
    expect(sub.status).toBe(StockStatus.SOLD);
    expect(sub.soldToOrderId).toBe(order.id);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatch(/^user\d@example\.com:pwd\d$/);
    expect(credentials[0]).not.toBe("user1@example.com:pwd1");

    const deadEvents = await eventsFor(deadId);
    expect(deadEvents.map((e) => e.eventType)).toEqual([
      StockEventType.RESERVED,
      StockEventType.MARKED_DEAD,
      StockEventType.SUBSTITUTED_OUT,
    ]);
    const subEvents = await eventsFor(sub.id);
    expect(subEvents.map((e) => e.eventType)).toEqual([
      StockEventType.RESERVED,
      StockEventType.SUBSTITUTED_IN,
      StockEventType.SOLD,
    ]);

    // Every event on a given stock item must have a non-decreasing occurredAt
    // in WRITE order (`eventsFor` orders by `id: "asc"`, i.e. insertion order,
    // never by occurredAt itself — so this is a real chronology check, not a
    // tautological re-sort of the field under test). This is the exact
    // invariant `checkStatusEventMismatchAndLegacy` depends on: it picks a
    // stock item's "latest" event via `ORDER BY occurred_at DESC, id DESC`,
    // which only agrees with true write order when occurredAt never goes
    // backwards between two events on the same row (Task C: before this fix,
    // `approveOrder` captured one early `now` for SUBSTITUTED_OUT/IN/SOLD
    // while the replacement's implicit RESERVED event — written via
    // `allocateOneAvailableStock`, in between — got a live, later JS-clock
    // read from the old DB-default fallback, inverting the order and making
    // this exact check below fail with a false statusEventMismatch).
    for (const seq of [deadEvents, subEvents]) {
      for (let i = 1; i < seq.length; i++) {
        expect(seq[i]!.occurredAt.getTime()).toBeGreaterThanOrEqual(seq[i - 1]!.occurredAt.getTime());
      }
    }

    const report = await checkStockIntegrity(prisma);
    for (const [key, finding] of Object.entries(report)) {
      if (key === "legacyRowsWithoutEvents") continue;
      expect({ key, count: (finding as { count: number }).count }).toEqual({ key, count: 0 });
    }
  });

  it("cancelling an order whose reserved row an admin marked DEAD unlinks the line but keeps the row DEAD", async () => {
    // Before: releaseOrderHolds only unlinked RESERVED rows, so the DEAD row
    // stayed pointed at by a cancelled order forever — the integrity check
    // reported it as pre-3b legacy data and soft-deleting the row was refused.
    const { product, user } = sample;
    const admin = await upsertUser(prisma, { telegramId: 777005, username: "admin-e", fullName: "Admin E" });
    const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    const rowId = item.stockItemId!;
    expect(await markStockDead(prisma, rowId, "died while reserved", admin.id)).toBe(1);

    await cancelOrder(prisma, order.id, "expired", { type: StockActorType.SYSTEM });

    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).stockItemId).toBeNull();
    const row = await prisma.stockItem.findUniqueOrThrow({ where: { id: rowId } });
    expect(row.status).toBe(StockStatus.DEAD);
    // No release is claimed for a row that was never released.
    expect((await eventsFor(rowId)).map((e) => e.eventType)).toEqual([StockEventType.RESERVED, StockEventType.MARKED_DEAD]);

    const report = await checkStockIntegrity(prisma);
    expect(report.cancelledOrRejectedOrderItemsStillLinked.count).toBe(0);
    expect(await deleteStockItem(prisma, rowId, admin.id)).toBe(true);
  });

  it("the expiry sweep's cancel is attributed to the system", async () => {
    const { product, user } = sample;
    const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });

    await cancelOrder(prisma, order.id, "expired", { type: StockActorType.SYSTEM });

    const released = await prisma.stockItemEvent.findFirstOrThrow({
      where: { stockItemId: item.stockItemId!, eventType: StockEventType.RESERVATION_RELEASED },
    });
    expect(released).toMatchObject({
      actorType: StockActorType.SYSTEM,
      actorAdminId: null,
      actorCustomerId: null,
    });
  });
});
