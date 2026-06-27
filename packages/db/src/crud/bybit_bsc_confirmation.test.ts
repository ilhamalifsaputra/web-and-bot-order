/**
 * Confirmation-tracker-facing crud: listTrackedBybitBscOrders,
 * recordBybitBscConfirmationProgress, recordBybitBscTrackingFailed. These are
 * display-only — none of them ever call approveOrder/deliverPaidBybitBscOrder
 * or transition toward PENDING_VERIFICATION/DELIVERED.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createBybitBscOrder,
  listTrackedBybitBscOrders,
  recordBybitBscConfirmationProgress,
  recordBybitBscTrackingFailed,
} from "@app/db";
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
  const order = await prisma.$transaction((tx) =>
    createBybitBscOrder(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1, rate: 1 }),
  );
  orderId = order!.id;
  await prisma.order.update({
    where: { id: orderId },
    data: { status: OrderStatus.PAYMENT_DETECTED, bybitTxid: "0x" + "a".repeat(64) },
  });
});

describe("listTrackedBybitBscOrders", () => {
  it("returns PAYMENT_DETECTED/CONFIRMING Bybit BSC orders that already have a bybitTxid, with their user included", async () => {
    const tracked = await listTrackedBybitBscOrders(prisma);
    expect(tracked.map((o) => o.id)).toEqual([orderId]);
    expect(tracked[0]!.user.id).toBe(sample.user.id);
  });

  it("excludes PENDING_PAYMENT orders (no deposit matched yet) even with paymentMethod=BYBIT_BSC", async () => {
    await prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.PENDING_PAYMENT, bybitTxid: null } });
    expect(await listTrackedBybitBscOrders(prisma)).toHaveLength(0);
  });

  it("excludes orders already past CONFIRMING (e.g. CONFIRMED, DELIVERED)", async () => {
    await prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.CONFIRMED } });
    expect(await listTrackedBybitBscOrders(prisma)).toHaveLength(0);
  });
});

describe("recordBybitBscConfirmationProgress", () => {
  it("bumps confirmations without changing status before the first confirmation", async () => {
    await recordBybitBscConfirmationProgress(prisma, { orderId, confirmations: 0, requiredConfirmations: 15 });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.confirmations).toBe(0);
    expect(order.requiredConfirmations).toBe(15);
    expect(order.status).toBe(OrderStatus.PAYMENT_DETECTED);
  });

  it("transitions PAYMENT_DETECTED -> CONFIRMING on the first confirmation, with exactly one history row", async () => {
    const result = await recordBybitBscConfirmationProgress(prisma, { orderId, confirmations: 1, requiredConfirmations: 15 });
    expect(result).toBe(OrderStatus.CONFIRMING);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.CONFIRMING);
    expect(order.confirmations).toBe(1);
    const history = await prisma.orderStatusHistory.findMany({ where: { orderId } });
    expect(history.map((h) => h.status)).toEqual([OrderStatus.CONFIRMING]);
  });

  it("transitions CONFIRMING -> CONFIRMED once confirmations reach the threshold, stamping confirmedAt", async () => {
    await prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.CONFIRMING, confirmations: 10 } });
    const result = await recordBybitBscConfirmationProgress(prisma, { orderId, confirmations: 15, requiredConfirmations: 15 });
    expect(result).toBe(OrderStatus.CONFIRMED);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    expect(order.confirmedAt).not.toBeNull();
  });

  it("jumps straight from PAYMENT_DETECTED to CONFIRMED in one call when confirmations already meet the threshold", async () => {
    const result = await recordBybitBscConfirmationProgress(prisma, { orderId, confirmations: 15, requiredConfirmations: 15 });
    expect(result).toBe(OrderStatus.CONFIRMED);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    const history = await prisma.orderStatusHistory.findMany({ where: { orderId }, orderBy: { id: "asc" } });
    expect(history.map((h) => h.status)).toEqual([OrderStatus.CONFIRMING, OrderStatus.CONFIRMED]);
  });

  it("never calls approveOrder — status never advances past CONFIRMED on its own", async () => {
    await recordBybitBscConfirmationProgress(prisma, { orderId, confirmations: 999, requiredConfirmations: 15 });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    expect(order.deliveredAt).toBeNull();
  });

  it("no-ops (returns null) if the order already left PAYMENT_DETECTED/CONFIRMING (e.g. delivered by the deposit poller on the same cycle)", async () => {
    await prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.DELIVERED } });
    const result = await recordBybitBscConfirmationProgress(prisma, { orderId, confirmations: 5, requiredConfirmations: 15 });
    expect(result).toBeNull();
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.DELIVERED);
    expect(order.confirmations).toBeNull(); // never touched
  });
});

describe("recordBybitBscTrackingFailed", () => {
  it("transitions PAYMENT_DETECTED/CONFIRMING to FAILED and returns true", async () => {
    const applied = await recordBybitBscTrackingFailed(prisma, { orderId, reason: "tx vanished after 10 lookups" });
    expect(applied).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.FAILED);
  });

  it("returns false and does not throw if the order already left PAYMENT_DETECTED/CONFIRMING", async () => {
    await prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.DELIVERED } });
    const applied = await recordBybitBscTrackingFailed(prisma, { orderId, reason: "irrelevant by now" });
    expect(applied).toBe(false);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(OrderStatus.DELIVERED);
  });
});
