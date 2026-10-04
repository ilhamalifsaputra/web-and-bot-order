/**
 * Backend audit, Task B2: on all six auto-confirm rails the idempotency claim
 * (`processed_*_tx` row, outcome "matched") is committed BEFORE, and outside,
 * the delivery transaction. A crash between the two — process killed, the
 * delivery transaction's connection dropped before the catch could tag the
 * row "delivery_failed" — left the row "matched" forever: every later
 * webhook retry or reconcile pass saw a terminal outcome and reported
 * already_processed, so a paid order was never delivered.
 *
 * A "matched" claim is now reclaimable once it is older than the in-flight
 * window AND its own order is still awaiting payment (so it cannot have been
 * delivered — delivery moves the order out of PENDING_PAYMENT in the same
 * transaction). A fresh claim, a claim whose order was delivered, and a
 * claim for a different order all stay untouched.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  deliverPaidTokopayOrder,
  deliverPaidPaydisiniOrder,
  deliverPaidNowpaymentsOrder,
  deliverPaidInternalOrder,
  deliverPaidBybitOrder,
  deliverPaidBybitBscOrder,
  STALE_MATCHED_CLAIM_MS,
} from "@app/db";
import { OrderStatus, PaymentMethod } from "@app/core/enums";
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

type Rail = {
  name: string;
  method: string;
  deliver: (orderId: number, txId: string, amount: Decimal.Value) => Promise<{ status: string }>;
  /** Insert a claim row directly, as a crashed delivery would have left it. */
  seed: (orderId: number, txId: string, amount: Decimal, at: Date) => Promise<unknown>;
  read: (txId: string) => Promise<{ outcome: string; orderId: number | null } | null>;
  backdate: (txId: string, at: Date) => Promise<unknown>;
};

const rails: Rail[] = [
  {
    name: "TokoPay",
    method: PaymentMethod.TOKOPAY,
    deliver: (orderId, trxId, amount) => deliverPaidTokopayOrder(prisma, { orderId, trxId, amount }),
    seed: (orderId, trxId, amount, at) =>
      prisma.processedTokopayTx.create({ data: { trxId, orderId, amount, outcome: "matched", createdAt: at, updatedAt: at } }),
    read: (trxId) => prisma.processedTokopayTx.findUnique({ where: { trxId } }),
    backdate: (trxId, at) => prisma.processedTokopayTx.update({ where: { trxId }, data: { createdAt: at, updatedAt: at } }),
  },
  {
    name: "PayDisini",
    method: PaymentMethod.PAYDISINI,
    deliver: (orderId, trxId, amount) => deliverPaidPaydisiniOrder(prisma, { orderId, trxId, amount }),
    seed: (orderId, trxId, amount, at) =>
      prisma.processedPaydisiniTx.create({ data: { trxId, orderId, amount, outcome: "matched", createdAt: at, updatedAt: at } }),
    read: (trxId) => prisma.processedPaydisiniTx.findUnique({ where: { trxId } }),
    backdate: (trxId, at) => prisma.processedPaydisiniTx.update({ where: { trxId }, data: { createdAt: at, updatedAt: at } }),
  },
  {
    name: "NOWPayments",
    method: PaymentMethod.NOWPAYMENTS,
    deliver: (orderId, trxId, amount) => deliverPaidNowpaymentsOrder(prisma, { orderId, trxId, amount }),
    seed: (orderId, trxId, amount, at) =>
      prisma.processedNowpaymentsTx.create({ data: { trxId, orderId, amount, outcome: "matched", createdAt: at, updatedAt: at } }),
    read: (trxId) => prisma.processedNowpaymentsTx.findUnique({ where: { trxId } }),
    backdate: (trxId, at) => prisma.processedNowpaymentsTx.update({ where: { trxId }, data: { createdAt: at, updatedAt: at } }),
  },
  {
    name: "Binance internal",
    method: PaymentMethod.BINANCE_INTERNAL,
    deliver: (orderId, binanceTxId, amount) => deliverPaidInternalOrder(prisma, { orderId, binanceTxId, amount }),
    seed: (orderId, binanceTxId, amount, at) =>
      prisma.processedBinanceTx.create({
        data: { binanceTxId, orderId, amount, outcome: "matched", createdAt: at, updatedAt: at },
      }),
    read: (binanceTxId) => prisma.processedBinanceTx.findUnique({ where: { binanceTxId } }),
    backdate: (binanceTxId, at) =>
      prisma.processedBinanceTx.update({ where: { binanceTxId }, data: { createdAt: at, updatedAt: at } }),
  },
  {
    name: "Bybit internal",
    method: PaymentMethod.BYBIT,
    deliver: (orderId, bybitTxId, amount) => deliverPaidBybitOrder(prisma, { orderId, bybitTxId, amount }),
    seed: (orderId, bybitTxId, amount, at) =>
      prisma.processedBybitTx.create({ data: { bybitTxId, orderId, amount, outcome: "matched", createdAt: at, updatedAt: at } }),
    read: (bybitTxId) => prisma.processedBybitTx.findUnique({ where: { bybitTxId } }),
    backdate: (bybitTxId, at) => prisma.processedBybitTx.update({ where: { bybitTxId }, data: { createdAt: at, updatedAt: at } }),
  },
  {
    name: "Bybit BSC",
    method: PaymentMethod.BYBIT_BSC,
    deliver: (orderId, bybitTxId, amount) => deliverPaidBybitBscOrder(prisma, { orderId, bybitTxId, amount }),
    seed: (orderId, bybitTxId, amount, at) =>
      prisma.processedBybitTx.create({ data: { bybitTxId, orderId, amount, outcome: "matched", createdAt: at, updatedAt: at } }),
    read: (bybitTxId) => prisma.processedBybitTx.findUnique({ where: { bybitTxId } }),
    backdate: (bybitTxId, at) => prisma.processedBybitTx.update({ where: { bybitTxId }, data: { createdAt: at, updatedAt: at } }),
  },
];

async function pendingOrder(method: string) {
  const order = (await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
  await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: method } });
  return order;
}

const longAgo = () => new Date(Date.now() - STALE_MATCHED_CLAIM_MS - 60_000);

describe.each(rails)("$name: a crash-stuck 'matched' claim (Task B2)", (rail) => {
  it("is reclaimed and delivered once it is stale and its order is still awaiting payment", async () => {
    const order = await pendingOrder(rail.method);
    const txId = `stuck-${rail.method}-1`;
    await rail.seed(order.id, txId, new Decimal(order.totalAmount), longAgo());

    const result = await rail.deliver(order.id, txId, order.totalAmount);

    expect(result.status).toBe("delivered");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);
    const row = await rail.read(txId);
    expect(row?.outcome).toBe("matched");
    expect(row?.orderId).toBe(order.id);
  });

  it("is NOT reclaimed while fresh — a delivery may still be in flight", async () => {
    const order = await pendingOrder(rail.method);
    const txId = `fresh-${rail.method}-1`;
    await rail.seed(order.id, txId, new Decimal(order.totalAmount), new Date());

    const result = await rail.deliver(order.id, txId, order.totalAmount);

    expect(result.status).toBe("already_processed");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it("is NOT reclaimed once its order was delivered, however old the claim", async () => {
    const order = await pendingOrder(rail.method);
    const txId = `done-${rail.method}-1`;
    expect((await rail.deliver(order.id, txId, order.totalAmount)).status).toBe("delivered");
    await rail.backdate(txId, longAgo());

    const again = await rail.deliver(order.id, txId, order.totalAmount);

    expect(again.status).toBe("already_processed");
    const row = await rail.read(txId);
    expect(row?.outcome).toBe("matched");
    expect(row?.orderId).toBe(order.id);
  });

  it("is NOT reclaimed for a different order than the one it was claimed for", async () => {
    const stuckOrder = await pendingOrder(rail.method);
    const otherOrder = await pendingOrder(rail.method);
    const txId = `other-${rail.method}-1`;
    await rail.seed(stuckOrder.id, txId, new Decimal(stuckOrder.totalAmount), longAgo());

    const result = await rail.deliver(otherOrder.id, txId, otherOrder.totalAmount);

    expect(result.status).toBe("already_processed");
    expect((await prisma.order.findUnique({ where: { id: otherOrder.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await rail.read(txId))?.orderId).toBe(stuckOrder.id);
  });
});
