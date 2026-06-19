/**
 * Idempotency-ledger tests for the PayDisini deliver path — same shape as
 * crud/reconciliation.test.ts's setup (makeTestDb + buildSampleData), since
 * there is no colocated tokopay.test.ts to mirror directly. Covers the three
 * deliverPaidPaydisiniOrder branches (delivered/already_processed/stale) plus
 * recordUnmatchedPaydisiniTx's claim-once semantics.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect, deliverPaidPaydisiniOrder, recordUnmatchedPaydisiniTx } from "@app/db";
import { OrderStatus, PaymentMethod, NotificationEvent } from "@app/core/enums";
import { Decimal } from "@app/core/money";

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

/** Create a PENDING_PAYMENT order stamped as a PayDisini payment. */
async function makePendingPaydisiniOrder() {
  const { user, product } = sample;
  const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: PaymentMethod.PAYDISINI },
  });
  return order;
}

describe("deliverPaidPaydisiniOrder", () => {
  it("delivers a pending order and claims the trx id", async () => {
    const order = await makePendingPaydisiniOrder();

    const result = await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      trxId: "trx-delivered-1",
      amount: order.totalAmount,
      shopUrl: "https://shop.example.com",
    });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.credentials.length).toBe(1);

    const ledgerRow = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "trx-delivered-1" } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order.id);

    // Buyer DM enqueued (sample user has a telegramId) with no credentials in the payload.
    // approveOrder() also enqueues its own ORDER_DELIVERED admin-channel row for the
    // same order, so filter on the DM event specifically.
    const outboxRow = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_DELIVERED_DM },
    });
    expect(outboxRow).not.toBeNull();
    const payload = JSON.parse(outboxRow!.payloadJson) as Record<string, unknown>;
    expect(payload.order_code).toBe(result.order.orderCode);
    expect(payload.order_url).toBe(`https://shop.example.com/account/orders/${result.order.orderCode}`);
    expect(JSON.stringify(payload)).not.toContain(result.credentials[0]);
  });

  it("a repeated trx id is already_processed (no double-delivery)", async () => {
    const order = await makePendingPaydisiniOrder();

    const first = await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      trxId: "trx-dup-1",
      amount: order.totalAmount,
    });
    expect(first.status).toBe("delivered");

    const second = await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      trxId: "trx-dup-1",
      amount: order.totalAmount,
    });
    expect(second.status).toBe("already_processed");

    // Still only one ledger row and the order wasn't touched twice.
    const rows = await prisma.processedPaydisiniTx.findMany({ where: { trxId: "trx-dup-1" } });
    expect(rows.length).toBe(1);
  });

  it("an order that is no longer PENDING_PAYMENT/PAYDISINI is stale", async () => {
    const order = await makePendingPaydisiniOrder();
    // Simulate the order having already moved on (e.g. expired/cancelled elsewhere).
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });

    const result = await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      trxId: "trx-stale-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("stale");

    const ledgerRow = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "trx-stale-1" } });
    expect(ledgerRow?.outcome).toBe("stale");
  });
});

describe("recordUnmatchedPaydisiniTx", () => {
  it("first insert returns true", async () => {
    const ok = await recordUnmatchedPaydisiniTx(prisma, { trxId: "trx-unmatched-1", amount: new Decimal("10000") });
    expect(ok).toBe(true);
    const row = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "trx-unmatched-1" } });
    expect(row?.outcome).toBe("unmatched");
    expect(row?.orderId).toBeNull();
  });

  it("a duplicate trx id returns false", async () => {
    await recordUnmatchedPaydisiniTx(prisma, { trxId: "trx-unmatched-2", amount: new Decimal("5000") });
    const ok = await recordUnmatchedPaydisiniTx(prisma, { trxId: "trx-unmatched-2", amount: new Decimal("5000") });
    expect(ok).toBe(false);
    const rows = await prisma.processedPaydisiniTx.findMany({ where: { trxId: "trx-unmatched-2" } });
    expect(rows.length).toBe(1);
  });
});
