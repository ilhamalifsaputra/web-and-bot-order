/**
 * Admin-side StockItemEvent ledger (stock-traceability hardening, Fase 3c).
 *
 * The order-side transitions are covered by stock_events_orders.test.ts; this
 * file covers what an ADMIN does to a stock row (import, mark dead, soft
 * delete, reveal) and the cross-function property the ledger exists for: read
 * in id order, a row's events chain (each transition's fromStatus is the
 * previous toStatus) and the last one lands on the row's real status.
 *
 * Events must exist if and only if the change did — so each writer is checked
 * for the rows it did NOT touch as well as the ones it did, and for rolling
 * back with its transaction.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  bulkAddStock,
  markStockDead,
  bulkMarkStockDead,
  bulkDeleteStock,
  deleteStockItem,
  revealStockCredentials,
  setStockNote,
} from "./stock";
import { createDenomination } from "./catalog";
import { createOrderDirect, approveOrder, attachPaymentProof } from "./orders";
import { decryptCredentials } from "@app/core/credentialCrypto";
import { DeadReason, StockActorType, StockEventType, StockStatus } from "@app/core/enums";

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

const eventsFor = (stockItemId: number) =>
  prisma.stockItemEvent.findMany({ where: { stockItemId }, orderBy: { id: "asc" } });

const rowsByStatus = async (status: string) =>
  prisma.stockItem.findMany({ where: { productId: sample.product.id, status }, orderBy: { id: "asc" } });

/** A fresh denomination, so a scenario controls exactly which rows exist. */
async function freshDenomination(name: string) {
  return createDenomination(prisma, {
    productId: sample.parentProduct.id,
    name,
    type: "SHARED",
    durationLabel: "1 month",
    price: "5.00",
    warrantyDays: 30,
  });
}

describe("bulkAddStock writes IMPORTED events", () => {
  it("writes one IMPORTED event per inserted row, attributed to the importing admin", async () => {
    const { user } = sample;
    const denom = await freshDenomination("Import events");

    const res = await bulkAddStock(prisma, denom.id, ["imp1@x:pw", "imp2@x:pw", "imp3@x:pw"], user.id);
    expect(res).toEqual({ added: 3, skipped: 0 });

    const rows = await prisma.stockItem.findMany({ where: { productId: denom.id }, orderBy: { id: "asc" } });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const events = await eventsFor(row.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: StockEventType.IMPORTED,
        fromStatus: null,
        toStatus: StockStatus.AVAILABLE,
        actorType: StockActorType.ADMIN,
        actorAdminId: user.id,
        actorCustomerId: null,
        orderId: null,
        orderItemId: null,
      });
    }
  });

  it("writes no event for a skipped duplicate or an in-batch repeat", async () => {
    const { user } = sample;
    const denom = await freshDenomination("Import dup events");
    await bulkAddStock(prisma, denom.id, ["dup@x:pw"], user.id);
    const before = await prisma.stockItemEvent.count();

    const res = await bulkAddStock(prisma, denom.id, ["dup@x:pw", "new@x:pw", "new@x:pw"], user.id);

    expect(res).toEqual({ added: 1, skipped: 2 });
    expect(await prisma.stockItemEvent.count()).toBe(before + 1);
  });

  it("records a SYSTEM actor when no admin is supplied (fixtures and seeds)", async () => {
    const denom = await freshDenomination("Import system events");
    await bulkAddStock(prisma, denom.id, ["sys@x:pw"]);

    const row = await prisma.stockItem.findFirstOrThrow({ where: { productId: denom.id } });
    expect((await eventsFor(row.id))[0]).toMatchObject({
      eventType: StockEventType.IMPORTED,
      actorType: StockActorType.SYSTEM,
      actorAdminId: null,
    });
  });

  it("rolls the events back together with the rows when the surrounding transaction fails", async () => {
    const { user } = sample;
    const denom = await freshDenomination("Import rollback");
    const eventsBefore = await prisma.stockItemEvent.count();

    await expect(
      prisma.$transaction(async (tx) => {
        await bulkAddStock(tx, denom.id, ["rb1@x:pw", "rb2@x:pw"], user.id);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await prisma.stockItem.count({ where: { productId: denom.id } })).toBe(0);
    expect(await prisma.stockItemEvent.count()).toBe(eventsBefore);
  });
});

describe("a row's whole life: import → reserve → sold", () => {
  it("chains from/to statuses and ends on the row's real status", async () => {
    const { user } = sample;
    const denom = await freshDenomination("Life cycle");
    await bulkAddStock(prisma, denom.id, ["life@x:pw"], user.id);
    const row = await prisma.stockItem.findFirstOrThrow({ where: { productId: denom.id } });

    const order = (await createOrderDirect(prisma, { user, productId: denom.id, quantity: 1 }))!;
    await attachPaymentProof(prisma, order.id, { fileId: "dummy", txid: "TX-LIFE-1" });
    await approveOrder(prisma, order.id, { adminId: 0 });

    const events = await eventsFor(row.id);
    expect(events.map((e) => e.eventType)).toEqual([
      StockEventType.IMPORTED,
      StockEventType.RESERVED,
      StockEventType.SOLD,
    ]);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.fromStatus).toBe(events[i - 1]!.toStatus);
    }
    const final = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(events.at(-1)!.toStatus).toBe(final.status);
    expect(final.status).toBe(StockStatus.SOLD);
  });

  it("import → reserve → mark dead ends on DEAD with a chained sequence", async () => {
    const { user } = sample;
    const denom = await freshDenomination("Life cycle dead");
    await bulkAddStock(prisma, denom.id, ["lifedead@x:pw"], user.id);
    const row = await prisma.stockItem.findFirstOrThrow({ where: { productId: denom.id } });

    await createOrderDirect(prisma, { user, productId: denom.id, quantity: 1 });
    expect(await markStockDead(prisma, row.id, "supplier revoked it", user.id)).toBe(1);

    const events = await eventsFor(row.id);
    expect(events.map((e) => e.eventType)).toEqual([
      StockEventType.IMPORTED,
      StockEventType.RESERVED,
      StockEventType.MARKED_DEAD,
    ]);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.fromStatus).toBe(events[i - 1]!.toStatus);
    }
    const final = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(events.at(-1)!.toStatus).toBe(final.status);
    expect(final.status).toBe(StockStatus.DEAD);
  });
});

describe("markStockDead / bulkMarkStockDead write MARKED_DEAD only for rows that changed", () => {
  it("markStockDead records the row's real prior status, the admin, and OTHER as the reason", async () => {
    const { user } = sample;
    const [available, reserved] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: reserved!.id }, data: { status: StockStatus.RESERVED } });

    expect(await markStockDead(prisma, available!.id, "n1", user.id)).toBe(1);
    expect(await markStockDead(prisma, reserved!.id, "n2", user.id)).toBe(1);

    expect((await eventsFor(available!.id)).at(-1)).toMatchObject({
      eventType: StockEventType.MARKED_DEAD,
      fromStatus: StockStatus.AVAILABLE,
      toStatus: StockStatus.DEAD,
      actorType: StockActorType.ADMIN,
      actorAdminId: user.id,
      reasonCode: DeadReason.OTHER,
    });
    expect((await eventsFor(reserved!.id)).at(-1)).toMatchObject({
      eventType: StockEventType.MARKED_DEAD,
      fromStatus: StockStatus.RESERVED,
      toStatus: StockStatus.DEAD,
    });
  });

  it("markStockDead writes nothing for a SOLD, already-DEAD, soft-deleted or unknown row", async () => {
    const { user } = sample;
    const [sold, dead, deleted] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: sold!.id }, data: { status: StockStatus.SOLD, soldAt: new Date() } });
    await prisma.stockItem.update({ where: { id: dead!.id }, data: { status: StockStatus.DEAD } });
    await prisma.stockItem.update({ where: { id: deleted!.id }, data: { deletedAt: new Date(), deletedByAdminId: user.id } });
    const before = await prisma.stockItemEvent.count({ where: { eventType: StockEventType.MARKED_DEAD } });

    expect(await markStockDead(prisma, sold!.id, "x", user.id)).toBe(0);
    expect(await markStockDead(prisma, dead!.id, "x", user.id)).toBe(0);
    expect(await markStockDead(prisma, deleted!.id, "x", user.id)).toBe(0);
    expect(await markStockDead(prisma, 999_999, "x", user.id)).toBe(0);

    expect(await prisma.stockItemEvent.count({ where: { eventType: StockEventType.MARKED_DEAD } })).toBe(before);
  });

  it("bulkMarkStockDead writes an event for each changed id only, with each row's own prior status", async () => {
    const { user } = sample;
    const [avail, reserved, sold, dead, deleted] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: reserved!.id }, data: { status: StockStatus.RESERVED } });
    await prisma.stockItem.update({ where: { id: sold!.id }, data: { status: StockStatus.SOLD, soldAt: new Date() } });
    await prisma.stockItem.update({ where: { id: dead!.id }, data: { status: StockStatus.DEAD } });
    await prisma.stockItem.update({ where: { id: deleted!.id }, data: { deletedAt: new Date(), deletedByAdminId: user.id } });
    const before = await prisma.stockItemEvent.count({ where: { eventType: StockEventType.MARKED_DEAD } });

    const count = await bulkMarkStockDead(
      prisma,
      [avail!.id, reserved!.id, sold!.id, dead!.id, deleted!.id, 999_999],
      "bulk note",
      user.id,
    );

    expect(count).toBe(2);
    const events = await prisma.stockItemEvent.findMany({
      where: { eventType: StockEventType.MARKED_DEAD },
      orderBy: { stockItemId: "asc" },
    });
    expect(events).toHaveLength(before + 2);
    expect(events.map((e) => [e.stockItemId, e.fromStatus, e.toStatus])).toEqual([
      [avail!.id, StockStatus.AVAILABLE, StockStatus.DEAD],
      [reserved!.id, StockStatus.RESERVED, StockStatus.DEAD],
    ]);
    for (const e of events) {
      expect(e).toMatchObject({ actorType: StockActorType.ADMIN, actorAdminId: user.id, reasonCode: DeadReason.OTHER });
    }
  });

  it("markStockDead stores the supplied reason on the row and on the event; default is OTHER", async () => {
    const { user } = sample;
    const [a, b] = await rowsByStatus(StockStatus.AVAILABLE);

    expect(await markStockDead(prisma, a!.id, "n", user.id, DeadReason.PASSWORD_CHANGED)).toBe(1);
    expect(await markStockDead(prisma, b!.id, "n", user.id)).toBe(1);

    expect((await prisma.stockItem.findUnique({ where: { id: a!.id } }))!.deadReason).toBe(DeadReason.PASSWORD_CHANGED);
    expect((await eventsFor(a!.id)).at(-1)!.reasonCode).toBe(DeadReason.PASSWORD_CHANGED);
    expect((await prisma.stockItem.findUnique({ where: { id: b!.id } }))!.deadReason).toBe(DeadReason.OTHER);
    expect((await eventsFor(b!.id)).at(-1)!.reasonCode).toBe(DeadReason.OTHER);
  });

  it("bulkMarkStockDead sets the reason only on the rows that actually changed", async () => {
    const { user } = sample;
    const [avail, sold] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: sold!.id }, data: { status: StockStatus.SOLD, soldAt: new Date() } });

    expect(await bulkMarkStockDead(prisma, [avail!.id, sold!.id], "n", user.id, DeadReason.REGION_LOCK)).toBe(1);

    expect((await prisma.stockItem.findUnique({ where: { id: avail!.id } }))!.deadReason).toBe(DeadReason.REGION_LOCK);
    expect((await eventsFor(avail!.id)).at(-1)!.reasonCode).toBe(DeadReason.REGION_LOCK);
    expect((await prisma.stockItem.findUnique({ where: { id: sold!.id } }))!.deadReason).toBeNull();
  });

  it("never copies the admin's note (or a credential) into an event", async () => {
    const { user } = sample;
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    const plain = decryptCredentials(row!.credentials);
    await markStockDead(prisma, row!.id, "hunter2 pasted by an admin", user.id);

    const dump = JSON.stringify(await prisma.stockItemEvent.findMany({ where: { stockItemId: row!.id } }));
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain(plain);
  });

  it("rolls the event back with the status change", async () => {
    const { user } = sample;
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    const before = await prisma.stockItemEvent.count({ where: { stockItemId: row!.id } });

    await expect(
      prisma.$transaction(async (tx) => {
        await markStockDead(tx, row!.id, "n", user.id);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: row!.id } })).status).toBe(StockStatus.AVAILABLE);
    expect(await prisma.stockItemEvent.count({ where: { stockItemId: row!.id } })).toBe(before);
  });
});

describe("soft delete writes SOFT_DELETED only for rows actually deleted", () => {
  it("deleteStockItem records the admin and leaves the row's status untouched in the event", async () => {
    const { user } = sample;
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);

    expect(await deleteStockItem(prisma, row!.id, user.id)).toBe(true);

    const last = (await eventsFor(row!.id)).at(-1)!;
    expect(last).toMatchObject({
      eventType: StockEventType.SOFT_DELETED,
      actorType: StockActorType.ADMIN,
      actorAdminId: user.id,
      fromStatus: null,
      toStatus: null,
    });
  });

  it("deleteStockItem writes nothing when the guard refuses (SOLD, order-linked, already deleted)", async () => {
    const { user, product } = sample;
    const [sold, linked, gone] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: sold!.id }, data: { status: StockStatus.SOLD, soldAt: new Date() } });
    await prisma.order.create({
      data: {
        orderCode: "ORD-EV-LINK",
        userId: user.id,
        status: "DELIVERED",
        subtotalAmount: "5.0000",
        totalAmount: "5.0000",
        items: {
          create: { productId: product.id, stockItemId: linked!.id, quantity: 1, unitPrice: "5.0000", warrantyDaysSnapshot: 30 },
        },
      },
    });
    await prisma.stockItem.update({ where: { id: gone!.id }, data: { deletedAt: new Date(), deletedByAdminId: user.id } });
    const before = await prisma.stockItemEvent.count({ where: { eventType: StockEventType.SOFT_DELETED } });

    expect(await deleteStockItem(prisma, sold!.id, user.id)).toBe(false);
    expect(await deleteStockItem(prisma, linked!.id, user.id)).toBe(false);
    expect(await deleteStockItem(prisma, gone!.id, user.id)).toBe(false);
    expect(await deleteStockItem(prisma, 999_999, user.id)).toBe(false);

    expect(await prisma.stockItemEvent.count({ where: { eventType: StockEventType.SOFT_DELETED } })).toBe(before);
  });

  it("bulkDeleteStock writes one event per deleted id and none for skipped ones", async () => {
    const { user } = sample;
    const [a, b, sold] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: sold!.id }, data: { status: StockStatus.SOLD, soldAt: new Date() } });
    await prisma.stockItem.update({ where: { id: b!.id }, data: { status: StockStatus.DEAD } });

    const count = await bulkDeleteStock(prisma, [a!.id, b!.id, sold!.id, 999_999], user.id);

    expect(count).toBe(2);
    const events = await prisma.stockItemEvent.findMany({
      where: { eventType: StockEventType.SOFT_DELETED },
      orderBy: { stockItemId: "asc" },
    });
    expect(events.map((e) => e.stockItemId)).toEqual([a!.id, b!.id]);
    for (const e of events) expect(e).toMatchObject({ actorType: StockActorType.ADMIN, actorAdminId: user.id });
  });

  it("rolls the events back with the delete", async () => {
    const { user } = sample;
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);

    await expect(
      prisma.$transaction(async (tx) => {
        await bulkDeleteStock(tx, [row!.id], user.id);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: row!.id } })).deletedAt).toBeNull();
    expect(await prisma.stockItemEvent.count({ where: { stockItemId: row!.id, eventType: StockEventType.SOFT_DELETED } })).toBe(0);
  });
});

describe("revealStockCredentials writes CREDENTIAL_REVEALED", () => {
  it("writes one event per reveal (repeat reveals included), with the admin and no secret", async () => {
    const { user } = sample;
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    const plain = decryptCredentials(row!.credentials);

    expect(await revealStockCredentials(prisma, row!.id, user.id)).toBe(plain);
    expect(await revealStockCredentials(prisma, row!.id, user.id)).toBe(plain);

    const events = (await eventsFor(row!.id)).filter((e) => e.eventType === StockEventType.CREDENTIAL_REVEALED);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actorType: StockActorType.ADMIN,
      actorAdminId: user.id,
      fromStatus: null,
      toStatus: null,
    });
    expect(JSON.stringify(events)).not.toContain(plain);
  });

  it("writes nothing for a missing or soft-deleted row", async () => {
    const { user } = sample;
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: row!.id }, data: { deletedAt: new Date(), deletedByAdminId: user.id } });
    const before = await prisma.stockItemEvent.count({ where: { eventType: StockEventType.CREDENTIAL_REVEALED } });

    expect(await revealStockCredentials(prisma, row!.id, user.id)).toBeNull();
    expect(await revealStockCredentials(prisma, 999_999, user.id)).toBeNull();

    expect(await prisma.stockItemEvent.count({ where: { eventType: StockEventType.CREDENTIAL_REVEALED } })).toBe(before);
  });
});

describe("setStockNote", () => {
  it("writes no event — the audit log covers a note edit", async () => {
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    const before = await prisma.stockItemEvent.count({ where: { stockItemId: row!.id } });

    await setStockNote(prisma, row!.id, "rotated password");

    expect(await prisma.stockItemEvent.count({ where: { stockItemId: row!.id } })).toBe(before);
  });
});
