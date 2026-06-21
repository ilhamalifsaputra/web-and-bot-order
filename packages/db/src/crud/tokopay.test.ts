/**
 * Idempotency-ledger tests for the TokoPay deliver path — same shape as
 * crud/paydisini.test.ts (makeTestDb + buildSampleData). Covers the three
 * deliverPaidTokopayOrder branches (delivered/already_processed/stale) plus
 * recordUnmatchedTokopayTx's claim-once semantics.
 *
 * Overpayment (Task 5 / H-3): the full suite lives in crud/paydisini.test.ts
 * (the three deliver functions are intentionally near-identical) — this file
 * only carries a representative overpaid assertion.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@app/core/config", async () => {
  const actual = await vi.importActual<typeof import("@app/core/config")>("@app/core/config");
  return { ...actual, config: { ...actual.config, ADMIN_IDS: [444] } };
});

import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect, deliverPaidTokopayOrder, recordUnmatchedTokopayTx } from "@app/db";
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

/** Create a PENDING_PAYMENT order stamped as a TokoPay payment. */
async function makePendingTokopayOrder() {
  const { user, product } = sample;
  const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: PaymentMethod.TOKOPAY },
  });
  return order;
}

describe("deliverPaidTokopayOrder", () => {
  it("delivers a pending order and claims the trx id", async () => {
    const order = await makePendingTokopayOrder();

    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-delivered-1",
      amount: order.totalAmount,
      shopUrl: "https://shop.example.com",
    });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.credentials.length).toBe(1);

    const ledgerRow = await prisma.processedTokopayTx.findUnique({ where: { trxId: "trx-delivered-1" } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order.id);
  });

  it("a repeated trx id is already_processed (no double-delivery)", async () => {
    const order = await makePendingTokopayOrder();

    const first = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-dup-1",
      amount: order.totalAmount,
    });
    expect(first.status).toBe("delivered");

    const second = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-dup-1",
      amount: order.totalAmount,
    });
    expect(second.status).toBe("already_processed");

    const rows = await prisma.processedTokopayTx.findMany({ where: { trxId: "trx-dup-1" } });
    expect(rows.length).toBe(1);
  });

  it("an order that is no longer PENDING_PAYMENT/TOKOPAY is stale", async () => {
    const order = await makePendingTokopayOrder();
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });

    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-stale-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("stale");

    const ledgerRow = await prisma.processedTokopayTx.findUnique({ where: { trxId: "trx-stale-1" } });
    expect(ledgerRow?.outcome).toBe("stale");
  });

  it("overpaid: delivers, ledger outcome is overpaid, and enqueues an ADMIN_OVERPAID row with correct excess/currency", async () => {
    const order = await makePendingTokopayOrder();
    // Pricing applies USE_UNIQUE_CENTS jitter, so totalAmount isn't a round
    // number — compute the expected excess from the actual total instead of
    // assuming "5".
    const expectedTotal = new Decimal(order.totalAmount);
    const paid = expectedTotal.plus("3"); // overpay by 3

    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-overpaid-1",
      amount: paid,
    });
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");

    const ledgerRow = await prisma.processedTokopayTx.findUnique({ where: { trxId: "trx-overpaid-1" } });
    expect(ledgerRow?.outcome).toBe("overpaid");

    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(1); // one ADMIN_IDS entry ([444])
    const payload = JSON.parse(adminRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.chat_id).toBe(444);
    expect(payload.order_code).toBe(result.order.orderCode);
    expect(payload.paid).toBe(paid.toString());
    expect(payload.expected).toBe(expectedTotal.toString());
    expect(payload.excess).toBe("3");
    expect(payload.currency).toBe(result.order.currency);
  });
});

describe("recordUnmatchedTokopayTx", () => {
  it("first insert returns true", async () => {
    const ok = await recordUnmatchedTokopayTx(prisma, { trxId: "trx-unmatched-1", amount: new Decimal("10000") });
    expect(ok).toBe(true);
    const row = await prisma.processedTokopayTx.findUnique({ where: { trxId: "trx-unmatched-1" } });
    expect(row?.outcome).toBe("unmatched");
    expect(row?.orderId).toBeNull();
  });

  it("a duplicate trx id returns false", async () => {
    await recordUnmatchedTokopayTx(prisma, { trxId: "trx-unmatched-2", amount: new Decimal("5000") });
    const ok = await recordUnmatchedTokopayTx(prisma, { trxId: "trx-unmatched-2", amount: new Decimal("5000") });
    expect(ok).toBe(false);
    const rows = await prisma.processedTokopayTx.findMany({ where: { trxId: "trx-unmatched-2" } });
    expect(rows.length).toBe(1);
  });
});
