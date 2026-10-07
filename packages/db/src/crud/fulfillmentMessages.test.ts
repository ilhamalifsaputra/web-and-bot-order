/**
 * Which orders get the buyer's single Telegram progress message, and when.
 * The row is created only from canonical order state: a real "payment seen"
 * transition (payment proof attached) or a settled payment — for every
 * fulfillment provider, never by category. A Bybit BSC deposit's detection is
 * not one of them: the payment bubble's live tracking screen shows that phase,
 * so the order still ends up with a single live message.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { attachPaymentProof, createOrderDirect, creditOrderToBalance, fulfillManualOrder, settlePaidOrder } from "./orders";
import { deliverPaidBybitBscOrder, recordBybitBscConfirmationProgress, recordBybitBscPaymentDetected } from "./bybit_bsc_deposit";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import { createWalletTopupOrder } from "./wallet_topup";
import { ensureFulfillmentMessage, wakeFulfillmentMessage } from "./fulfillmentMessages";
import { transitionOrderStatus } from "./orderStatus";
import { DeliveryType, OrderStatus, PaymentMethod } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => { db = await makeTestDb(); prisma = db.prisma; });
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => { await resetDb(prisma); sample = await buildSampleData(prisma); });

async function manualDenom() {
  const category = await createCategory(prisma, `manual-${Math.random()}`);
  const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `Manual ${Math.random()}` });
  return createDenomination(prisma, {
    productId: product.id, name: "Manual", type: "SHARED", durationLabel: "1 Month", price: "10.00", deliveryType: DeliveryType.MANUAL,
  });
}
async function pendingOrder(productId: number, user = sample.user) {
  return (await createOrderDirect(prisma, { channel: "bot", user, productId, quantity: 1 }))!;
}
const rows = (orderId: number) => prisma.fulfillmentMessage.findMany({ where: { orderId } });

describe("ensureFulfillmentMessage", () => {
  it("creates one row addressed to the buyer's chat and is idempotent", async () => {
    const order = await pendingOrder(sample.product.id);
    expect(await ensureFulfillmentMessage(prisma, order.id)).toBe(true);
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 77, state: "ACTIVE" } });
    expect(await ensureFulfillmentMessage(prisma, order.id)).toBe(true);
    const saved = await rows(order.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ chatId: 42n, messageId: 77, state: "ACTIVE" });
  });

  it("skips buyers without a Telegram chat", async () => {
    const webUser = await prisma.user.create({ data: { referralCode: `web-${Math.random()}` } });
    const order = await pendingOrder(sample.product.id, webUser);
    expect(await ensureFulfillmentMessage(prisma, order.id)).toBe(false);
    expect(await rows(order.id)).toHaveLength(0);
  });
});

describe("progress message creation points", () => {
  it("never creates a product progress message for a wallet top-up", async () => {
    const topup = await createWalletTopupOrder(prisma, { userId: sample.user.id, amount: "50000", currency: "IDR", method: PaymentMethod.TOKOPAY });
    expect(await ensureFulfillmentMessage(prisma, topup.id)).toBe(false);
    expect(await rows(topup.id)).toHaveLength(0);
  });

  it("does not create a message for an order that is merely awaiting payment", async () => {
    const order = await pendingOrder(sample.product.id);
    expect(await rows(order.id)).toHaveLength(0);
  });

  it("does not create the message when a Bybit BSC deposit is detected: the payment bubble's live tracking screen owns that phase", async () => {
    const order = await pendingOrder(sample.product.id);
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT_BSC } });
    expect(await recordBybitBscPaymentDetected(prisma, { orderId: order.id, bybitTxId: "0x" + "a".repeat(64), network: "BSC" })).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PAYMENT_DETECTED);
    expect(await rows(order.id)).toHaveLength(0);
  });

  it("creates exactly one message for a Bybit BSC order, at settlement, across detection -> confirmed -> paid -> delivered", async () => {
    const order = await pendingOrder((await manualDenom()).id);
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT_BSC } });
    const txId = "0x" + "b".repeat(64);
    await recordBybitBscPaymentDetected(prisma, { orderId: order.id, bybitTxId: txId, network: "BSC" });
    expect(await recordBybitBscConfirmationProgress(prisma, { orderId: order.id, confirmations: 1, requiredConfirmations: 3 })).toBe(OrderStatus.CONFIRMING);
    expect(await recordBybitBscConfirmationProgress(prisma, { orderId: order.id, confirmations: 3, requiredConfirmations: 3 })).toBe(OrderStatus.CONFIRMED);
    expect(await rows(order.id)).toHaveLength(0);
    const paid = await deliverPaidBybitBscOrder(prisma, { orderId: order.id, bybitTxId: txId, amount: order.totalAmount });
    expect(paid.status).toBe("processing");
    expect(await rows(order.id)).toHaveLength(1);
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 610, state: "WAITING" } });
    await prisma.$transaction(tx => fulfillManualOrder(tx, order.id, { adminId: sample.user.id, content: "code-bsc" }));
    const saved = await rows(order.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.messageId).toBe(610);
  });

  it("creates the message when payment proof moves the order to pending verification", async () => {
    const order = await pendingOrder(sample.product.id);
    await attachPaymentProof(prisma, order.id, { fileId: "proof", txid: "TX-PROOF-1" });
    expect(await rows(order.id)).toHaveLength(1);
  });

  it("settling a stock order that is delivered synchronously creates no message (the credentials DM is the notice)", async () => {
    const order = await pendingOrder(sample.product.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PENDING_VERIFICATION } });
    const result = await settlePaidOrder(prisma, order.id, { adminId: 0 });
    expect(result.kind).toBe("delivered");
    expect(await rows(order.id)).toHaveLength(0);
  });

  it("settling a stock order keeps the message already created in the detected phase so it gets finalized", async () => {
    const order = await pendingOrder(sample.product.id);
    await attachPaymentProof(prisma, order.id, { fileId: "proof", txid: "TX-PROOF-STOCK" });
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 303, state: "ACTIVE" } });
    const result = await settlePaidOrder(prisma, order.id, { adminId: 0 });
    expect(result.kind).toBe("delivered");
    const saved = await rows(order.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.messageId).toBe(303);
  });

  it("settling a manual order creates the message", async () => {
    const order = await pendingOrder((await manualDenom()).id);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PENDING_VERIFICATION } });
    const result = await settlePaidOrder(prisma, order.id, { adminId: 0 });
    expect(result.kind).toBe("processing");
    expect(await rows(order.id)).toHaveLength(1);
  });

  it("keeps the detected message when the same order settles, so one message carries both phases", async () => {
    const order = await pendingOrder(sample.product.id);
    await attachPaymentProof(prisma, order.id, { fileId: "proof", txid: "TX-PROOF-2" });
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 501, state: "ACTIVE" } });
    await settlePaidOrder(prisma, order.id, { adminId: 0 });
    // A duplicate settle (webhook replay) is rejected by the order's own claim
    // and must not create a second row either way.
    await settlePaidOrder(prisma, order.id, { adminId: 0 }).catch(() => undefined);
    const saved = await rows(order.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.messageId).toBe(501);
  });
});

describe("a manual order's waiting message is woken by the final transition", () => {
  const FAR = new Date("2099-01-01T00:00:00.000Z");
  async function waitingManualOrder() {
    const order = await pendingOrder((await manualDenom()).id);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PENDING_VERIFICATION } });
    expect((await settlePaidOrder(prisma, order.id, { adminId: 0 })).kind).toBe("processing");
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 900, state: "WAITING", nextUpdateAt: FAR } });
    return order;
  }
  async function expectWoken(orderId: number, before: Date) {
    const row = await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId } });
    expect(row.state).toBe("ACTIVE");
    expect(row.nextUpdateAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row.nextUpdateAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row.messageId).toBe(900);
  }

  it("when an admin fulfils it", async () => {
    const order = await waitingManualOrder(); const before = new Date();
    await prisma.$transaction(tx => fulfillManualOrder(tx, order.id, { adminId: sample.user.id, content: "code-123" }));
    await expectWoken(order.id, before);
  });

  it("when an admin credits it to the buyer's balance (the order is cancelled)", async () => {
    const order = await waitingManualOrder(); const before = new Date();
    await creditOrderToBalance(prisma, { orderId: order.id, adminId: sample.user.id });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CANCELLED);
    await expectWoken(order.id, before);
  });

  it.each([OrderStatus.REJECTED, OrderStatus.CANCELLED, OrderStatus.FAILED])("on any status transition out of PROCESSING to %s", async (to) => {
    const order = await waitingManualOrder(); const before = new Date();
    await transitionOrderStatus(prisma, { orderId: order.id, from: OrderStatus.PROCESSING, to });
    await expectWoken(order.id, before);
  });

  it("but a non-final transition leaves it waiting", async () => {
    const order = await pendingOrder(sample.product.id);
    await prisma.fulfillmentMessage.create({ data: { orderId: order.id, chatId: 42n, messageId: 1, state: "WAITING", nextUpdateAt: FAR } });
    await transitionOrderStatus(prisma, { orderId: order.id, from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.PENDING_VERIFICATION });
    expect((await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("WAITING");
  });
});

describe("wakeFulfillmentMessage", () => {
  const FAR = new Date("2099-01-01T00:00:00.000Z");
  const now = new Date("2026-10-07T00:00:00.000Z");
  it.each([
    ["WAITING", "ACTIVE", now],
    ["REVIEW", "REVIEW", now],
    ["EDITING", "EDITING", now],
    ["ACTIVE", "ACTIVE", FAR], // e.g. a flood-control backoff
    ["FINISHED", "FINISHED", FAR],
    ["STOPPED", "STOPPED", FAR],
  ] as const)("moves a %s row to %s", async (state, expected, due) => {
    const order = await pendingOrder(sample.product.id);
    await prisma.fulfillmentMessage.create({ data: { orderId: order.id, chatId: 42n, messageId: 1, state, nextUpdateAt: FAR } });
    await wakeFulfillmentMessage(prisma, order.id, now);
    const row = await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.state).toBe(expected);
    expect(row.nextUpdateAt.getTime()).toBe(due.getTime());
  });
});
