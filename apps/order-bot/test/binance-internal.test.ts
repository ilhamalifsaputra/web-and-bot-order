// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  createInternalOrder,
  deliverPaidInternalOrder,
  markUnderpaid,
  recordUnmatchedTx,
} from "@app/db";
import { OrderStatus, PaymentMethod, StockStatus } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { classifyTx, noteMatches } from "../src/payments/binanceInternal";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedBinanceTx.deleteMany(); // new table, not covered by resetDb
  sample = await buildSampleData(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const makeInternalOrder = (qty = 1) =>
  prisma.$transaction((tx) =>
    createInternalOrder(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: qty }),
  );

// ===========================================================================
// Matching (pure)
// ===========================================================================

describe("classifyTx / noteMatches", () => {
  const order = { paymentRef: "BCC1BDDE6F", totalAmount: "5.0000" };

  it("matches note case-insensitively and trimmed", () => {
    expect(noteMatches({ note: " bcc1bdde6f " }, order)).toBe(true);
    expect(noteMatches({ note: "OTHER" }, order)).toBe(false);
    expect(noteMatches({ note: "x" }, { paymentRef: null })).toBe(false);
  });

  it("exact / within-tolerance / overpaid → match", () => {
    expect(classifyTx({ note: "BCC1BDDE6F", amount: 5.0 }, order)).toBe("match");
    expect(classifyTx({ note: "BCC1BDDE6F", amount: 5.005 }, order)).toBe("match"); // within 0.01
    expect(classifyTx({ note: "BCC1BDDE6F", amount: 5.5 }, order)).toBe("match"); // overpaid
  });

  it("short beyond tolerance → underpaid", () => {
    expect(classifyTx({ note: "BCC1BDDE6F", amount: 4.5 }, order)).toBe("underpaid");
    expect(classifyTx({ note: "BCC1BDDE6F", amount: 4.985 }, order)).toBe("underpaid");
  });

  it("wrong note → none (regardless of amount)", () => {
    expect(classifyTx({ note: "NOPE", amount: 5.0 }, order)).toBe("none");
  });
});

// ===========================================================================
// Order creation
// ===========================================================================

describe("createInternalOrder", () => {
  it("creates a BINANCE_INTERNAL order with a unique paymentRef and 15-min expiry", async () => {
    const order = await makeInternalOrder();
    expect(order).toBeTruthy();
    expect(order!.paymentMethod).toBe(PaymentMethod.BINANCE_INTERNAL);
    expect(order!.paymentRef).toMatch(/^[0-9A-F]{10}$/);
    expect(order!.status).toBe(OrderStatus.PENDING_PAYMENT);
    const minsToExpiry = (order!.expiresAt!.getTime() - Date.now()) / 60000;
    expect(minsToExpiry).toBeGreaterThan(13);
    expect(minsToExpiry).toBeLessThanOrEqual(15.1);
  });
});

// ===========================================================================
// Idempotent delivery / underpaid / unmatched
// ===========================================================================

describe("deliverPaidInternalOrder (idempotency + delivery)", () => {
  it("delivers once and is idempotent on the same tx id", async () => {
    const order = await makeInternalOrder();
    const amount = order!.totalAmount;

    const first = await deliverPaidInternalOrder(prisma, { orderId: order!.id, binanceTxId: "TX-AAA", amount });
    expect(first.status).toBe("delivered");
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1);
    expect(await prisma.processedBinanceTx.count({ where: { binanceTxId: "TX-AAA" } })).toBe(1);

    // Same tx again → already processed, no second delivery.
    const second = await deliverPaidInternalOrder(prisma, { orderId: order!.id, binanceTxId: "TX-AAA", amount });
    expect(second.status).toBe("already_processed");
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1);
  });

  it("returns 'stale' when a different tx targets an already-delivered order", async () => {
    const order = await makeInternalOrder();
    await deliverPaidInternalOrder(prisma, { orderId: order!.id, binanceTxId: "TX-1", amount: order!.totalAmount });
    const res = await deliverPaidInternalOrder(prisma, { orderId: order!.id, binanceTxId: "TX-2", amount: order!.totalAmount });
    expect(res.status).toBe("stale");
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1); // not re-delivered
  });
});

describe("markUnderpaid / recordUnmatchedTx", () => {
  it("markUnderpaid flags the order once (idempotent)", async () => {
    const order = await makeInternalOrder();
    const first = await markUnderpaid(prisma, { orderId: order!.id, binanceTxId: "TX-UP", amount: "1.00" });
    expect(first).toBe(true);
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.status).toBe(OrderStatus.UNDERPAID);
    const second = await markUnderpaid(prisma, { orderId: order!.id, binanceTxId: "TX-UP", amount: "1.00" });
    expect(second).toBe(false);
  });

  it("recordUnmatchedTx records once and dedupes", async () => {
    expect(await recordUnmatchedTx(prisma, { binanceTxId: "TX-UNM", amount: "9.99" })).toBe(true);
    expect(await recordUnmatchedTx(prisma, { binanceTxId: "TX-UNM", amount: "9.99" })).toBe(false);
    expect(await prisma.processedBinanceTx.count({ where: { binanceTxId: "TX-UNM", outcome: "unmatched" } })).toBe(1);
  });
});
