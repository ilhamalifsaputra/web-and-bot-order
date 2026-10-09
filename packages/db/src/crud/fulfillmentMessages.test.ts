/**
 * Which orders get the buyer's single Telegram progress message, and when.
 * The row is created only from canonical order state: a real "payment seen"
 * transition (payment proof attached) or a settled payment — for every
 * fulfillment provider, never by category. A Bybit BSC deposit's detection is
 * not one of them: the payment bubble's live tracking screen shows that phase,
 * so the order still ends up with a single live message.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { attachPaymentProof, createOrderDirect, creditOrderToBalance, fulfillManualOrder, settlePaidOrder } from "./orders";
import { deliverPaidBybitBscOrder, recordBybitBscConfirmationProgress, recordBybitBscPaymentDetected } from "./bybit_bsc_deposit";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import { createWalletTopupOrder } from "./wallet_topup";
import { ensureFulfillmentMessage, wakeFulfillmentMessage, adoptTransactionMessage, markCredentialsDelivered, credentialsDelivered } from "./fulfillmentMessages";
import { transitionOrderStatus } from "./orderStatus";
import { bulkAddStock } from "./stock";
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
  it.each([[null, true], ["STOCK", false]])("resolves legacy delivery routing while respecting the %s snapshot", async (fulfillmentProvider, expected) => {
    const order = await pendingOrder(sample.product.id);
    await prisma.fulfillmentMessage.deleteMany({ where: { orderId: order.id } });
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { autoDeliverySource: "digiflazz" } });
    await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED", fulfillmentProvider } });
    expect(await ensureFulfillmentMessage(prisma, order.id)).toBe(expected);
    expect(await rows(order.id)).toHaveLength(expected ? 1 : 0);
  });
});

describe("progress message creation points", () => {
  it("adopts the existing full-reference wallet payment bubble and reuses it at settlement", async () => {
    const topup = await createWalletTopupOrder(prisma, { userId: sample.user.id, amount: "50000", currency: "IDR", method: PaymentMethod.TOKOPAY });
    await adoptTransactionMessage(prisma, topup.id, 42n, 912, "text");
    expect((await rows(topup.id))[0]).toMatchObject({ chatId: 42n, messageId: 912, state: "WAITING" });
    await prisma.order.update({ where: { id: topup.id }, data: { status: "DELIVERED" } });
    await ensureFulfillmentMessage(prisma, topup.id);
    expect((await rows(topup.id))[0]).toMatchObject({ messageId: 912, state: "ACTIVE" });
    expect(await rows(topup.id)).toHaveLength(1);
  });
  it("registers wallet top-ups in the same canonical coordinator", async () => {
    const topup = await createWalletTopupOrder(prisma, { userId: sample.user.id, amount: "50000", currency: "IDR", method: PaymentMethod.TOKOPAY });
    expect(await ensureFulfillmentMessage(prisma, topup.id)).toBe(true);
    expect(await rows(topup.id)).toHaveLength(1);
  });

  it("adopts the acknowledged screen if detection registered an empty row first", async () => {
    const order = await pendingOrder(sample.product.id);
    await ensureFulfillmentMessage(prisma, order.id);
    await adoptTransactionMessage(prisma, order.id, 42n, 991, "text");
    await adoptTransactionMessage(prisma, order.id, 42n, 992, "text");
    expect((await rows(order.id))[0]).toMatchObject({ messageId: 991, state: "WAITING" });
  });

  it("activates an adopted screen when provider observation preceded its acknowledgement", async () => {
    const order = await pendingOrder(sample.product.id);
    await prisma.order.update({ where: { id: order.id }, data: { paymentState: "VERIFYING" } });
    await adoptTransactionMessage(prisma, order.id, 42n, 993, "text");
    expect((await rows(order.id))[0]).toMatchObject({ messageId: 993, state: "ACTIVE", phase: null });
  });

  it("reserves bot checkout without permitting a send before its screen is acknowledged", async () => {
    const order = await pendingOrder(sample.product.id);
    expect((await rows(order.id))[0]).toMatchObject({ messageId: null, state: "WAITING_SCREEN" });
  });

  it("does not create the message when a Bybit BSC deposit is detected: the payment bubble's live tracking screen owns that phase", async () => {
    const order = await pendingOrder(sample.product.id);
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT_BSC } });
    expect(await recordBybitBscPaymentDetected(prisma, { orderId: order.id, bybitTxId: "0x" + "a".repeat(64), network: "BSC" })).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PAYMENT_DETECTED);
    expect((await rows(order.id))[0]).toMatchObject({ messageId: null, state: "WAITING_SCREEN" });
  });

  it("creates exactly one message for a Bybit BSC order, at settlement, across detection -> confirmed -> paid -> delivered", async () => {
    const order = await pendingOrder((await manualDenom()).id);
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT_BSC } });
    const txId = "0x" + "b".repeat(64);
    await recordBybitBscPaymentDetected(prisma, { orderId: order.id, bybitTxId: txId, network: "BSC" });
    expect(await recordBybitBscConfirmationProgress(prisma, { orderId: order.id, confirmations: 1, requiredConfirmations: 3 })).toBe(OrderStatus.CONFIRMING);
    expect(await recordBybitBscConfirmationProgress(prisma, { orderId: order.id, confirmations: 3, requiredConfirmations: 3 })).toBe(OrderStatus.CONFIRMED);
    expect((await rows(order.id))[0]).toMatchObject({ messageId: null, state: "WAITING_SCREEN" });
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
    expect((await rows(order.id))[0]).toMatchObject({ messageId: null, state: "WAITING_SCREEN" });
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
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 1, state: "WAITING", nextUpdateAt: FAR } });
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
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 1, state, nextUpdateAt: FAR } });
    await wakeFulfillmentMessage(prisma, order.id, now);
    const row = await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.state).toBe(expected);
    expect(row.nextUpdateAt.getTime()).toBe(due.getTime());
  });
});

describe("transaction message kind", () => {
  it("persists the kind of the adopted payment screen", async () => {
    const photo = await pendingOrder(sample.product.id);
    await adoptTransactionMessage(prisma, photo.id, 42n, 1201, "photo");
    expect((await rows(photo.id))[0]).toMatchObject({ messageId: 1201, messageKind: "photo" });
    const text = await pendingOrder(sample.product.id);
    await adoptTransactionMessage(prisma, text.id, 42n, 1202, "text");
    expect((await rows(text.id))[0]).toMatchObject({ messageId: 1202, messageKind: "text" });
  });

  it("records the kind when it fills a detection-registered empty slot, and keeps it on a later adoption", async () => {
    const order = await pendingOrder(sample.product.id);
    await ensureFulfillmentMessage(prisma, order.id);
    await adoptTransactionMessage(prisma, order.id, 42n, 1203, "photo");
    await adoptTransactionMessage(prisma, order.id, 42n, 1204, "text");
    expect((await rows(order.id))[0]).toMatchObject({ messageId: 1203, messageKind: "photo" });
  });

  it("leaves the kind unknown when ensureFulfillmentMessage adopts a legacy payment anchor", async () => {
    const order = await pendingOrder(sample.product.id);
    await prisma.fulfillmentMessage.deleteMany({ where: { orderId: order.id } });
    await prisma.order.update({ where: { id: order.id }, data: { paymentMsgChatId: 42n, paymentMsgId: 1205 } });
    await ensureFulfillmentMessage(prisma, order.id);
    expect((await rows(order.id))[0]).toMatchObject({ messageId: 1205, messageKind: null });
  });
});

describe("credentials delivery record", () => {
  it("is first-writer-wins: a second mark returns false and keeps the first document id", async () => {
    const order = await pendingOrder(sample.product.id);
    expect(await credentialsDelivered(prisma, order.id)).toBe(false);
    expect(await markCredentialsDelivered(prisma, order.id, 3001)).toBe(true);
    const first = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(first.credentialsDocMsgId).toBe(3001);
    expect(first.credentialsDeliveredAt).toBeInstanceOf(Date);
    expect(await markCredentialsDelivered(prisma, order.id, 3002)).toBe(false);
    const second = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(second.credentialsDocMsgId).toBe(3001);
    expect(second.credentialsDeliveredAt).toEqual(first.credentialsDeliveredAt);
    expect(await credentialsDelivered(prisma, order.id)).toBe(true);
  });

  it("wakes the order's status message so it re-renders", async () => {
    const order = await pendingOrder(sample.product.id);
    const later = new Date(Date.now() + 3_600_000);
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 3003, state: "WAITING", nextUpdateAt: later } });
    expect(await markCredentialsDelivered(prisma, order.id, 3004)).toBe(true);
    const row = (await rows(order.id))[0]!;
    expect(row.state).toBe("ACTIVE");
    expect(row.nextUpdateAt.getTime()).toBeLessThan(later.getTime());
  });

  it.each(["ACTIVE", "READY"])("makes a polled %s row with a later due time due right away, so 'completed' lands promptly", async (state) => {
    const order = await pendingOrder(sample.product.id);
    const later = new Date(Date.now() + 3_600_000);
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: state === "READY" ? null : 3005, state, nextUpdateAt: later } });
    const now = new Date();
    expect(await markCredentialsDelivered(prisma, order.id, 3006, now)).toBe(true);
    const row = (await rows(order.id))[0]!;
    expect(row.state).toBe(state);
    expect(row.nextUpdateAt.getTime()).toBe(now.getTime());
  });

  it("never reopens a finished row, and a repeated mark wakes nothing", async () => {
    const order = await pendingOrder(sample.product.id);
    const later = new Date(Date.now() + 3_600_000);
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 3007, state: "FINISHED", nextUpdateAt: later } });
    expect(await markCredentialsDelivered(prisma, order.id, 3008)).toBe(true);
    expect((await rows(order.id))[0]).toMatchObject({ state: "FINISHED", nextUpdateAt: later });
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { state: "ACTIVE" } });
    expect(await markCredentialsDelivered(prisma, order.id, 3009)).toBe(false);
    expect((await rows(order.id))[0]).toMatchObject({ state: "ACTIVE", nextUpdateAt: later });
  });

  it("the backfill migration marks only delivered stock orders, and a re-run changes nothing", async () => {
    const sql = readFileSync(fileURLToPath(new URL("../../../../prisma/migrations/20261008120100_backfill_credentials_delivered_at/migration.sql", import.meta.url)), "utf8");
    const deliveredAt = new Date("2026-09-01T00:00:00.000Z");
    await bulkAddStock(prisma, sample.product.id, Array.from({ length: 5 }, (_, i) => `extra${i}@example.com:pwd${i}`));
    const deliver = async (productId: number, data: { fulfillmentProvider?: string | null; status?: string } = {}) => {
      const order = await pendingOrder(productId);
      await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt, fulfillmentProvider: null, ...data } });
      return order.id;
    };
    const stockSnapshot = await deliver(sample.product.id, { fulfillmentProvider: "STOCK" });
    const legacyStock = await deliver(sample.product.id);
    const manual = await deliver((await manualDenom()).id);
    const manualSnapshot = await deliver(sample.product.id, { fulfillmentProvider: "MANUAL" });
    const pending = await deliver(sample.product.id, { status: "PROCESSING" });
    const alreadyMarked = await deliver(sample.product.id, { fulfillmentProvider: "STOCK" });
    await markCredentialsDelivered(prisma, alreadyMarked, 3100, new Date("2026-09-02T00:00:00.000Z"));
    const topup = await createWalletTopupOrder(prisma, { userId: sample.user.id, amount: "50000", currency: "IDR", method: PaymentMethod.TOKOPAY });
    await prisma.order.update({ where: { id: topup.id }, data: { status: "DELIVERED", deliveredAt } });
    // Delivered during the deploy window, while the dispatcher was down: the
    // credentials DM is still queued (PENDING) or awaiting an admin retry
    // (FAILED). Stamping these would make the new dispatcher record the DM as
    // sent without sending the file. A DM already SENT is a real delivery.
    const dm = (orderId: number, status: string) => prisma.notificationOutbox.create({
      data: { event: "ORDER_DELIVERED_DM", orderId, status, payloadJson: JSON.stringify({ chat_id: 1, order_code: "X" }) },
    });
    const dmPending = await deliver(sample.product.id, { fulfillmentProvider: "STOCK" });
    await dm(dmPending, "SENT");
    await dm(dmPending, "PENDING");
    const dmFailed = await deliver(sample.product.id);
    await dm(dmFailed, "FAILED");
    const dmSent = await deliver(sample.product.id, { fulfillmentProvider: "STOCK" });
    await dm(dmSent, "SENT");

    const state = async () => Object.fromEntries((await prisma.order.findMany({
      where: { id: { in: [stockSnapshot, legacyStock, manual, manualSnapshot, pending, alreadyMarked, topup.id, dmPending, dmFailed, dmSent] } },
      select: { id: true, credentialsDeliveredAt: true, credentialsDocMsgId: true },
    })).map(o => [o.id, o]));
    expect(await prisma.$executeRawUnsafe(sql)).toBe(3);
    const after = await state();
    expect(after[stockSnapshot]).toMatchObject({ credentialsDeliveredAt: deliveredAt, credentialsDocMsgId: null });
    expect(after[legacyStock]).toMatchObject({ credentialsDeliveredAt: deliveredAt, credentialsDocMsgId: null });
    expect(after[dmSent]).toMatchObject({ credentialsDeliveredAt: deliveredAt, credentialsDocMsgId: null });
    for (const id of [manual, manualSnapshot, pending, topup.id, dmPending, dmFailed]) expect(after[id]!.credentialsDeliveredAt).toBeNull();
    expect(after[alreadyMarked]).toMatchObject({ credentialsDeliveredAt: new Date("2026-09-02T00:00:00.000Z"), credentialsDocMsgId: 3100 });

    expect(await prisma.$executeRawUnsafe(sql)).toBe(0);
    expect(await state()).toEqual(after);

    // A stock order delivered after the first run (its file may still be in
    // flight) is never stamped by a later container start's re-run.
    const cutoff = await prisma.setting.findUniqueOrThrow({ where: { key: "credentials_delivered_backfill_cutoff" } });
    const lateDelivery = pending; // the in-flight order now completes, after the cutoff
    await prisma.order.update({ where: { id: lateDelivery }, data: {
      status: "DELIVERED", fulfillmentProvider: "STOCK", deliveredAt: new Date(new Date(cutoff.value).getTime() + 1000),
    } });
    expect(await prisma.$executeRawUnsafe(sql)).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: lateDelivery } })).credentialsDeliveredAt).toBeNull();
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: "credentials_delivered_backfill_cutoff" } })).value).toBe(cutoff.value);
  });

  it("does not touch the message when the credentials were already recorded", async () => {
    const order = await pendingOrder(sample.product.id);
    await markCredentialsDelivered(prisma, order.id, 3005);
    const later = new Date(Date.now() + 3_600_000);
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 3006, state: "WAITING", nextUpdateAt: later } });
    expect(await markCredentialsDelivered(prisma, order.id, 3007)).toBe(false);
    expect((await rows(order.id))[0]).toMatchObject({ state: "WAITING", nextUpdateAt: later });
  });
});
