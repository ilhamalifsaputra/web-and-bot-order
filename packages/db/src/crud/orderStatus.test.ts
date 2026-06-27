/**
 * Centralized order-status transition helper: validates the transition shape
 * against LEGAL_TRANSITIONS, atomically claims the row (so a stale caller
 * fails safely instead of overwriting an order that already moved on), and
 * writes exactly one OrderStatusHistory row per successful transition.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderFromCart, addToCart, transitionOrderStatus, tryTransitionOrderStatus, LEGAL_TRANSITIONS } from "@app/db";
import { OrderStatus } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let orderId: number;

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
  await addToCart(prisma, sample.user.id, sample.product.id, 1);
  const order = await createOrderFromCart(prisma, { user: sample.user });
  orderId = order!.id;
});

describe("transitionOrderStatus", () => {
  it("moves the order's status and writes exactly one history row", async () => {
    await transitionOrderStatus(prisma, {
      orderId,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PAYMENT_DETECTED,
      meta: "txid=0xabc",
    });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PAYMENT_DETECTED);

    const history = await prisma.orderStatusHistory.findMany({ where: { orderId } });
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe(OrderStatus.PAYMENT_DETECTED);
    expect(history[0]!.meta).toBe("txid=0xabc");
  });

  it("walks the full Bybit BSC happy path, one history row per hop", async () => {
    const hops = [
      OrderStatus.PAYMENT_DETECTED,
      OrderStatus.CONFIRMING,
      OrderStatus.CONFIRMED,
      OrderStatus.PENDING_VERIFICATION,
    ];
    let from: string = OrderStatus.PENDING_PAYMENT;
    for (const to of hops) {
      await transitionOrderStatus(prisma, { orderId, from, to });
      from = to;
    }
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PENDING_VERIFICATION);
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { id: "asc" },
    });
    expect(history.map((h) => h.status)).toEqual(hops);
  });

  it("rejects DELIVERED -> PAYMENT_DETECTED (terminal state, no outgoing transitions)", async () => {
    await prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.DELIVERED } });
    await expect(
      transitionOrderStatus(prisma, {
        orderId,
        from: OrderStatus.DELIVERED,
        to: OrderStatus.PAYMENT_DETECTED,
      }),
    ).rejects.toMatchObject({ key: "error.illegal_status_transition" });

    // No history row written, no status change.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.DELIVERED);
    expect(await prisma.orderStatusHistory.count({ where: { orderId } })).toBe(0);
  });

  it.each(["DELIVERED", "CANCELLED", "REJECTED", "REFUNDED"])(
    "%s is terminal — has zero legal outgoing transitions",
    (status) => {
      expect(LEGAL_TRANSITIONS[status]).toEqual([]);
    },
  );

  it("rejects a transition when the order's actual status no longer matches `from` (stale caller)", async () => {
    // Order is really PENDING_PAYMENT, but the caller believes it's already
    // PAYMENT_DETECTED (e.g. a duplicate/late poller tick) — must fail safely
    // rather than blindly overwriting whatever the order really is now.
    await prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.PAYMENT_DETECTED } });
    await expect(
      transitionOrderStatus(prisma, {
        orderId,
        from: OrderStatus.PENDING_PAYMENT,
        to: OrderStatus.PAYMENT_DETECTED,
      }),
    ).rejects.toMatchObject({ key: "error.illegal_status_transition" });
    expect(await prisma.orderStatusHistory.count({ where: { orderId } })).toBe(0);
  });

  it("does not set paidAt/deliveredAt/firstDetectedAt/confirmedAt — those stay the caller's job", async () => {
    await transitionOrderStatus(prisma, {
      orderId,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PAYMENT_DETECTED,
    });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.firstDetectedAt).toBeNull();
    expect(order.paidAt).toBeNull();
    expect(order.confirmedAt).toBeNull();
    expect(order.deliveredAt).toBeNull();
  });
});

describe("tryTransitionOrderStatus", () => {
  it("returns true and behaves exactly like transitionOrderStatus on a legal, current transition", async () => {
    const applied = await tryTransitionOrderStatus(prisma, {
      orderId,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PAYMENT_DETECTED,
    });
    expect(applied).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(OrderStatus.PAYMENT_DETECTED);
    expect(await prisma.orderStatusHistory.count({ where: { orderId } })).toBe(1);
  });

  it("returns false (no throw, no history row) when the order already moved past `from`", async () => {
    await prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.CONFIRMING } });
    const applied = await tryTransitionOrderStatus(prisma, {
      orderId,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PAYMENT_DETECTED,
    });
    expect(applied).toBe(false);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(OrderStatus.CONFIRMING);
    expect(await prisma.orderStatusHistory.count({ where: { orderId } })).toBe(0);
  });
});
