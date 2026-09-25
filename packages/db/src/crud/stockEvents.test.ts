/**
 * recordStockEvent / recordStockEvents — the single write path for the
 * StockItemEvent ledger (stock traceability hardening plan, Fase 3a).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { recordStockEvent, recordStockEvents, listStockItemEvents } from "./stockEvents";
import { StockEventType, StockActorType, StockStatus } from "@app/core/enums";

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
  // The fixture's own import wrote IMPORTED events; these tests exercise the
  // writer against an empty ledger.
  await prisma.stockItemEvent.deleteMany();
});

const firstStockId = async () =>
  (await prisma.stockItem.findFirstOrThrow({ where: { productId: sample.product.id } })).id;

describe("recordStockEvent", () => {
  it("writes one row with every field mapped", async () => {
    const stockItemId = await firstStockId();
    const row = await recordStockEvent(prisma, {
      stockItemId,
      eventType: StockEventType.MARKED_DEAD,
      fromStatus: StockStatus.AVAILABLE,
      toStatus: StockStatus.DEAD,
      actor: { type: StockActorType.ADMIN, adminId: sample.user.id },
      reasonCode: "PASSWORD_CHANGED",
      correlationId: "corr-1",
      meta: { note: "x" },
    });
    expect(row.stockItemId).toBe(stockItemId);
    expect(row.eventType).toBe("MARKED_DEAD");
    expect(row.fromStatus).toBe("AVAILABLE");
    expect(row.toStatus).toBe("DEAD");
    expect(row.actorType).toBe("ADMIN");
    expect(row.actorAdminId).toBe(sample.user.id);
    expect(row.actorCustomerId).toBeNull();
    expect(row.reasonCode).toBe("PASSWORD_CHANGED");
    expect(row.correlationId).toBe("corr-1");
    expect(row.meta).toEqual({ note: "x" });
  });

  it("leaves optional columns null for a minimal SYSTEM event", async () => {
    const stockItemId = await firstStockId();
    const row = await recordStockEvent(prisma, {
      stockItemId,
      eventType: StockEventType.IMPORTED,
      actor: { type: StockActorType.SYSTEM },
    });
    expect(row.fromStatus).toBeNull();
    expect(row.toStatus).toBeNull();
    expect(row.orderId).toBeNull();
    expect(row.actorAdminId).toBeNull();
    expect(row.meta).toBeNull();
  });

  it("rejects an unknown event type or actor type", async () => {
    const stockItemId = await firstStockId();
    await expect(
      recordStockEvent(prisma, {
        stockItemId,
        eventType: "BOGUS" as never,
        actor: { type: StockActorType.SYSTEM },
      }),
    ).rejects.toThrow();
    await expect(
      recordStockEvent(prisma, {
        stockItemId,
        eventType: StockEventType.SOLD,
        actor: { type: "ROBOT" as never },
      }),
    ).rejects.toThrow();
    expect(await prisma.stockItemEvent.count()).toBe(0);
  });

  it("rolls back with the surrounding transaction", async () => {
    const stockItemId = await firstStockId();
    await expect(
      prisma.$transaction(async (tx) => {
        await recordStockEvent(tx, {
          stockItemId,
          eventType: StockEventType.SOLD,
          actor: { type: StockActorType.SYSTEM },
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await prisma.stockItemEvent.count()).toBe(0);
  });
});

describe("recordStockEvents", () => {
  it("inserts many events in one call and returns the count", async () => {
    const ids = (await prisma.stockItem.findMany({ select: { id: true }, take: 3 })).map((r) => r.id);
    const n = await recordStockEvents(
      prisma,
      ids.map((stockItemId) => ({
        stockItemId,
        eventType: StockEventType.IMPORTED,
        toStatus: StockStatus.AVAILABLE,
        actor: { type: StockActorType.ADMIN, adminId: sample.user.id },
        meta: { batch: 1 },
      })),
    );
    expect(n).toBe(3);
    const rows = await prisma.stockItemEvent.findMany();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.actorAdminId === sample.user.id)).toBe(true);
  });

  it("is a no-op for an empty list", async () => {
    expect(await recordStockEvents(prisma, [])).toBe(0);
  });
});

describe("listStockItemEvents", () => {
  it("returns null for an unknown stock item", async () => {
    expect(await listStockItemEvents(prisma, 999_999_999)).toBeNull();
  });

  it("returns an empty list for an item with no recorded events", async () => {
    expect(await listStockItemEvents(prisma, await firstStockId())).toEqual([]);
  });

  it("orders by occurredAt then id, resolves actor names and order codes, and exposes no credentials", async () => {
    const stockItemId = await firstStockId();
    const other = (await prisma.stockItem.findMany({ where: { productId: sample.product.id } }))[1]!.id;
    const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
    const order = await prisma.order.create({
      data: { orderCode: "ORD-HIST-1", userId: sample.user.id, subtotalAmount: 10, totalAmount: 10 },
    });
    const admin = { type: StockActorType.ADMIN, adminId: sample.user.id } as const;
    // Written out of order on purpose; the two t(5) rows tie and must fall back to id.
    await recordStockEvent(prisma, { stockItemId, eventType: StockEventType.SOLD, actor: { type: StockActorType.SYSTEM }, orderId: order.id, occurredAt: t(9) });
    await recordStockEvent(prisma, { stockItemId, eventType: StockEventType.RESERVED, actor: admin, orderId: order.id, occurredAt: t(5) });
    await recordStockEvent(prisma, { stockItemId, eventType: StockEventType.CREDENTIAL_REVEALED, actor: admin, occurredAt: t(5) });
    await recordStockEvent(prisma, { stockItemId, eventType: StockEventType.IMPORTED, actor: admin, occurredAt: t(1) });
    await recordStockEvent(prisma, { stockItemId: other, eventType: StockEventType.IMPORTED, actor: admin, occurredAt: t(0) });

    const events = (await listStockItemEvents(prisma, stockItemId))!;
    expect(events.map((e) => e.eventType)).toEqual(["IMPORTED", "RESERVED", "CREDENTIAL_REVEALED", "SOLD"]);
    expect(events[1]!.actorName).toBe("Test User");
    expect(events[1]!.orderCode).toBe("ORD-HIST-1");
    expect(events[0]!.orderCode).toBeNull();
    expect(events[3]!.actorName).toBeNull();
    for (const e of events) {
      expect(Object.keys(e)).not.toContain("credentials");
      expect(Object.keys(e)).not.toContain("meta");
    }
  });
});
