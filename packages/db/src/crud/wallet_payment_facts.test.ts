import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createWalletTopupOrder, preservePaidWalletCreditFailure, type WalletTopupMethod } from "./wallet_topup";
import { createPaymentAttempt } from "./payments";
import { deliverPaidTokopayOrder, listPendingTokopayOrders } from "./tokopay";
import { deliverPaidPaydisiniOrder, listPendingPaydisiniOrders } from "./paydisini";
import { deliverPaidNowpaymentsOrder, listPendingNowpaymentsOrders } from "./nowpayments";
import { deliverPaidBybitOrder, listPendingBybitOrders } from "./bybit_deposit";
import { deliverPaidBybitBscOrder, listPendingBybitBscOrders } from "./bybit_bsc_deposit";
import { deliverPaidInternalOrder, deliverUnderpaidOrder, markUnderpaid, listPendingInternalOrders } from "./binance_internal";
import { cancelOrder, countExpiredPending, createOrderDirect, fulfillManualOrder, listExpiredPendingOrders, listExpiringPendingPayments } from "./orders";
import { finalizeOrderPayment } from "./pricing";
import { OrderStatus, PaymentMethod, DeliveryType, StockActorType } from "@app/core/enums";
import * as users from "./users";
import * as notifications from "./notifications";

vi.mock("@app/core/config", async () => {
  const actual = await vi.importActual<typeof import("@app/core/config")>("@app/core/config");
  return { ...actual, config: { ...actual.config, ADMIN_IDS: [333] } };
});

let db: TestDb;
let sample: SampleData;
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await resetDb(db.prisma); sample = await buildSampleData(db.prisma); });
afterEach(() => { vi.restoreAllMocks(); });

const rails = [
  [PaymentMethod.TOKOPAY, deliverPaidTokopayOrder, listPendingTokopayOrders],
  [PaymentMethod.PAYDISINI, deliverPaidPaydisiniOrder, listPendingPaydisiniOrders],
  [PaymentMethod.NOWPAYMENTS, deliverPaidNowpaymentsOrder, listPendingNowpaymentsOrders],
  [PaymentMethod.BYBIT, deliverPaidBybitOrder, listPendingBybitOrders],
  [PaymentMethod.BYBIT_BSC, deliverPaidBybitBscOrder, listPendingBybitBscOrders],
  [PaymentMethod.BINANCE_INTERNAL, deliverPaidInternalOrder, listPendingInternalOrders],
] as const;

describe("verified wallet payment facts survive downstream failure", () => {
  it("keeps unpaid legacy orders with nullable canonical states in expiry queues", async () => {
    const order = (await createOrderDirect(db.prisma, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    const now = new Date();
    await db.prisma.order.update({ where: { id: order.id }, data: { paymentState: null, walletCreditState: null, expiresAt: new Date(now.getTime() - 60_000) } });
    expect((await listExpiredPendingOrders(db.prisma, now)).map((expired) => expired.id)).toContain(order.id);
    expect(await countExpiredPending(db.prisma, now)).toBe(1);
    await db.prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(now.getTime() + 60_000) } });
    expect((await listExpiringPendingPayments(db.prisma, now, new Date(now.getTime() + 120_000))).map((expiring) => expiring.id)).toContain(order.id);
  });

  it.each(rails)("%s retains PAID, requests review and never credits a retry", async (method, deliver, poll) => {
    const currency = method === PaymentMethod.TOKOPAY || method === PaymentMethod.PAYDISINI ? "IDR" : "USDT";
    const order = await db.prisma.$transaction((tx) => createWalletTopupOrder(tx, {
      userId: sample.user.id, amount: currency === "IDR" ? "100000" : "10", currency,
      method: method as WalletTopupMethod, rate: "16000",
    }));
    const attempt = await createPaymentAttempt(db.prisma, { orderId: order.id, method, currency, amount: order.totalAmount });
    const args = { orderId: order.id, trxId: "verified-credit-failure", bybitTxId: "verified-credit-failure", binanceTxId: "verified-credit-failure", amount: order.totalAmount };
    vi.spyOn(users, "adjustWallet").mockRejectedValueOnce(new Error("simulated wallet write failure"));
    await expect(deliver(db.prisma, args)).rejects.toThrow("simulated wallet write failure");
    const failed = await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(failed.paymentState).toBe("PAID");
    expect(failed.walletCreditState).toBe("NEEDS_REVIEW");
    expect(failed.paidAt).not.toBeNull();
    expect(failed.deliveredAt).toBeNull();
    expect((await poll(db.prisma, new Date())).map((pending) => pending.id)).not.toContain(order.id);
    expect((await db.prisma.payment.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("CONFIRMED");
    await expect(deliver(db.prisma, args)).rejects.toThrow();
    expect(await db.prisma.walletTransaction.count({ where: { orderId: order.id, reason: "wallet_topup" } })).toBe(0);
    expect(await db.prisma.auditLog.count({ where: { targetId: order.id, action: "wallet_credit_needs_review" } })).toBe(1);
    expect(await db.prisma.notificationOutbox.count({ where: { orderId: order.id, event: "ORDER_PIPELINE_FAILED" } })).toBe(1);
    expect((await db.prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).finishedAt).toBeNull();
    const now = new Date();
    await db.prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(now.getTime() - 60_000) } });
    expect((await listExpiredPendingOrders(db.prisma, now)).map((expired) => expired.id)).not.toContain(order.id);
    expect(await countExpiredPending(db.prisma, now)).toBe(0);
    await db.prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(now.getTime() + 60_000) } });
    expect((await listExpiringPendingPayments(db.prisma, now, new Date(now.getTime() + 120_000))).map((expiring) => expiring.id)).not.toContain(order.id);
    // Canonical payment facts must protect the money even if legacy paidAt is absent.
    await db.prisma.order.update({ where: { id: order.id }, data: { paidAt: null } });
    await expect(cancelOrder(db.prisma, order.id, "expired", { type: StockActorType.SYSTEM })).rejects.toThrow("error.order_paid_needs_credit");
    await expect(cancelOrder(db.prisma, order.id, "user_cancelled", { type: StockActorType.CUSTOMER, customerId: sample.user.id })).rejects.toThrow("error.order_paid_needs_credit");
    const protectedOrder = await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(protectedOrder.status).toBe(failed.status);
    expect(protectedOrder.paymentState).toBe("PAID");
    expect(protectedOrder.walletCreditState).toBe("NEEDS_REVIEW");
  });

  it("does not fabricate PAID for a payment on another rail", async () => {
    const order = await db.prisma.$transaction((tx) => createWalletTopupOrder(tx, { userId: sample.user.id, amount: "10", currency: "USDT", method: PaymentMethod.NOWPAYMENTS, rate: "16000" }));
    expect(await preservePaidWalletCreditFailure(db.prisma, { orderId: order.id, method: PaymentMethod.BYBIT, amount: order.totalAmount, providerTransactionId: "wrong-rail" })).toBe(false);
    expect((await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paymentState).toBe("WAITING_PAYMENT");
  });

  it("retains the payment fact when review notification fails, then retries the incident safely", async () => {
    const order = await db.prisma.$transaction((tx) => createWalletTopupOrder(tx, { userId: sample.user.id, amount: "10", currency: "USDT", method: PaymentMethod.NOWPAYMENTS, rate: "16000" }));
    vi.spyOn(notifications, "enqueueTransactionReviewAlert").mockRejectedValueOnce(new Error("simulated outbox failure"));
    const args = { orderId: order.id, method: PaymentMethod.NOWPAYMENTS, amount: order.totalAmount, providerTransactionId: "confirmed-outbox-failure" };
    expect(await preservePaidWalletCreditFailure(db.prisma, args)).toBe(true);
    const failed = await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(failed.paymentState).toBe("PAID");
    expect(failed.walletCreditState).toBe("NEEDS_REVIEW");
    expect(await preservePaidWalletCreditFailure(db.prisma, args)).toBe(true);
    expect(await db.prisma.notificationOutbox.count({ where: { orderId: order.id, event: "ORDER_PIPELINE_FAILED" } })).toBe(1);
  });
});

describe("underpaid admin completion preserves provider facts", () => {
  it("requires a reason, records the actor/time, and leaves payment incomplete", async () => {
    const created = await db.prisma.$transaction(async (tx) => {
      const order = (await createOrderDirect(tx, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
      return finalizeOrderPayment(tx, order.id, { currency: "USDT", method: PaymentMethod.BINANCE_INTERNAL, rate: "1" });
    });
    const order = created!;
    await markUnderpaid(db.prisma, { orderId: order.id, binanceTxId: "underpaid-override", amount: order.totalAmount.div(2) });
    await expect(deliverUnderpaidOrder(db.prisma, { orderId: order.id, adminId: sample.user.id, reason: " " })).rejects.toThrow();
    const result = await deliverUnderpaidOrder(db.prisma, { orderId: order.id, adminId: sample.user.id, reason: "Approved goodwill shortfall" });
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.order.paymentState).toBe("UNDERPAID");
    expect(result.order.completionMode).toBe("ADMIN_OVERRIDE");
    expect(result.order.completedBy).toBe(sample.user.id);
    expect(result.order.completedAt).not.toBeNull();
    expect(result.order.completionReason).toBe("Approved goodwill shortfall");
    expect(await db.prisma.auditLog.count({ where: { action: "underpaid_deliver", targetId: order.id } })).toBe(1);
  });

  it("queues a premium manual order, then records its manual completion without confirming payment", async () => {
    await db.prisma.denomination.update({ where: { id: sample.product.id }, data: { deliveryType: DeliveryType.MANUAL } });
    const order = (await createOrderDirect(db.prisma, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await db.prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BINANCE_INTERNAL } });
    await markUnderpaid(db.prisma, { orderId: order.id, binanceTxId: "manual-underpaid", amount: order.totalAmount.div(2) });
    const queued = await deliverUnderpaidOrder(db.prisma, { orderId: order.id, adminId: sample.user.id, reason: "Customer service exception" });
    expect(queued.order.status).toBe(OrderStatus.PROCESSING);
    const completed = await db.prisma.$transaction((tx) => fulfillManualOrder(tx, order.id, { adminId: sample.user.id, content: "Delivered account" }));
    expect(completed.order.status).toBe(OrderStatus.DELIVERED);
    expect(completed.order.paymentState).toBe("UNDERPAID");
    expect(completed.order.completedAt).not.toBeNull();
  });
});
