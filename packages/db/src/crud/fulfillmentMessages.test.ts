/**
 * Which orders get the buyer's single Telegram progress message, and when.
 * The row is created only from canonical order state: a real "payment seen"
 * transition (Bybit BSC deposit detected, payment proof attached) or a
 * settled payment — for every fulfillment provider, never by category.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { attachPaymentProof, createOrderDirect, settlePaidOrder } from "./orders";
import { recordBybitBscPaymentDetected } from "./bybit_bsc_deposit";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import { createWalletTopupOrder } from "./wallet_topup";
import { ensureFulfillmentMessage } from "./fulfillmentMessages";
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

  it("creates the message when a Bybit BSC deposit is detected (payment seen, not final)", async () => {
    const order = await pendingOrder(sample.product.id);
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT_BSC } });
    expect(await recordBybitBscPaymentDetected(prisma, { orderId: order.id, bybitTxId: "0x" + "a".repeat(64), network: "BSC" })).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PAYMENT_DETECTED);
    expect(await rows(order.id)).toHaveLength(1);
  });

  it("creates the message when payment proof moves the order to pending verification", async () => {
    const order = await pendingOrder(sample.product.id);
    await attachPaymentProof(prisma, order.id, { fileId: "proof", txid: "TX-PROOF-1" });
    expect(await rows(order.id)).toHaveLength(1);
  });

  it("settling a stock order creates the message too (all products, not only Digiflazz)", async () => {
    const order = await pendingOrder(sample.product.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PENDING_VERIFICATION } });
    await settlePaidOrder(prisma, order.id, { adminId: 0 });
    expect(await rows(order.id)).toHaveLength(1);
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
