/**
 * Idempotency-ledger tests for the NOWPayments deliver path — same shape as
 * crud/paydisini.test.ts (makeTestDb + buildSampleData), since there is no
 * colocated tokopay.test.ts to mirror directly. Covers the three
 * deliverPaidNowpaymentsOrder branches (delivered/already_processed/stale)
 * plus recordUnmatchedNowpaymentsTx's claim-once semantics.
 *
 * Overpayment (Task 5 / H-3): the full suite lives in crud/paydisini.test.ts
 * (the three deliver functions are intentionally near-identical) — this file
 * only carries a representative overpaid assertion.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@app/core/config", async () => {
  const actual = await vi.importActual<typeof import("@app/core/config")>("@app/core/config");
  return { ...actual, config: { ...actual.config, ADMIN_IDS: [333] } };
});

import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  deliverPaidNowpaymentsOrder,
  recordUnmatchedNowpaymentsTx,
  getNowpaymentsCreds,
  listPendingNowpaymentsOrders,
  setSetting,
  deleteSetting,
  createCategory,
  createCatalogProduct,
  createDenomination,
  createWalletTopupOrder,
  upsertUser,
  bulkAddStock,
  cancelOrder,
  createPaymentAttempt,
} from "@app/db";
import { OrderStatus, OrderKind, PaymentMethod, NotificationEvent, StockStatus, DeliveryType, StockActorType } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { encryptCredentials, settingValueAad } from "@app/core/credentialCrypto";

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

/** Create a PENDING_PAYMENT order stamped as a NOWPayments payment. */
async function makePendingNowpaymentsOrder() {
  const { user, product } = sample;
  const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: PaymentMethod.NOWPAYMENTS },
  });
  return order;
}

/** Same as makePendingNowpaymentsOrder, but for a caller-supplied denomination
 * (used to route through a manual-delivery SKU instead of sample.product). */
async function makePendingNowpaymentsOrderFor(productId: number) {
  const { user } = sample;
  const order = (await createOrderDirect(prisma, { user, productId, quantity: 1 }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: PaymentMethod.NOWPAYMENTS },
  });
  return order;
}

/** A manual (no-stock) denomination, on its own category/product. */
async function makeManualDenom() {
  const category = await createCategory(prisma, `manual-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `Manual Product ${Math.random()}` });
  return createDenomination(prisma, {
    productId: product.id,
    name: "Manual Denom",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "10.00",
    warrantyDays: 30,
    deliveryType: DeliveryType.MANUAL,
  });
}

// Financial Ledger M3 (Task 3b): the settlement now captures NOWPayments' own
// payment id onto the confirmed Payment row. Its IPN reports how much arrived
// (`actually_paid`) but never a fee it deducted, so `fee`/`netAmount` stay null
// — Payment.fee's documented "not known", not a claim this rail is free.
describe("deliverPaidNowpaymentsOrder — provider transaction id capture (Financial Ledger M3)", () => {
  it("captures the gateway payment id as the Payment row's providerTransactionId, and no fee figures", async () => {
    const order = await makePendingNowpaymentsOrder();
    const attempt = await createPaymentAttempt(prisma, {
      orderId: order.id,
      method: PaymentMethod.NOWPAYMENTS,
      amount: order.totalAmount,
      currency: order.currency,
      reference: "NP-INVOICE-M3",
    });

    const result = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId: "trx-m3-capture-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");

    const confirmed = await prisma.payment.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(confirmed.status).toBe("CONFIRMED");
    // The gateway's own id, kept distinct from the invoice id this shop quoted.
    expect(confirmed.providerTransactionId).toBe("trx-m3-capture-1");
    expect(confirmed.reference).toBe("NP-INVOICE-M3");
    expect(confirmed.fee).toBeNull();
    expect(confirmed.netAmount).toBeNull();
  });

  it("captures it on a WALLET_TOPUP settlement too — both call sites are wired, not just the product branch", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "10", currency: "USDT", method: PaymentMethod.NOWPAYMENTS, rate: "16000" }),
    );
    expect(order.kind).toBe(OrderKind.WALLET_TOPUP);
    const attempt = await createPaymentAttempt(prisma, {
      orderId: order.id,
      method: PaymentMethod.NOWPAYMENTS,
      amount: order.totalAmount,
      currency: order.currency,
    });

    const result = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId: "trx-m3-capture-topup-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");

    const confirmed = await prisma.payment.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.providerTransactionId).toBe("trx-m3-capture-topup-1");
  });
});

describe("deliverPaidNowpaymentsOrder", () => {
  it("delivers a pending order and claims the trx id", async () => {
    const order = await makePendingNowpaymentsOrder();

    const result = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId: "trx-delivered-1",
      amount: order.totalAmount,
      shopUrl: "https://shop.example.com",
    });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.credentials.length).toBe(1);

    const ledgerRow = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "trx-delivered-1" } });
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
    const order = await makePendingNowpaymentsOrder();

    const first = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId: "trx-dup-1",
      amount: order.totalAmount,
    });
    expect(first.status).toBe("delivered");

    const second = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId: "trx-dup-1",
      amount: order.totalAmount,
    });
    expect(second.status).toBe("already_processed");

    // Still only one ledger row and the order wasn't touched twice.
    const rows = await prisma.processedNowpaymentsTx.findMany({ where: { trxId: "trx-dup-1" } });
    expect(rows.length).toBe(1);
  });

  it("overpaid: delivers, ledger outcome is overpaid, and enqueues an ADMIN_OVERPAID row with correct excess/currency", async () => {
    const order = await makePendingNowpaymentsOrder();
    // Pricing applies USE_UNIQUE_CENTS jitter, so totalAmount isn't a round
    // number — compute the expected excess from the actual total instead of
    // assuming "5".
    const expectedTotal = new Decimal(order.totalAmount);
    const paid = expectedTotal.plus("1.25");

    const result = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId: "trx-overpaid-1",
      amount: paid,
    });
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");

    const ledgerRow = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "trx-overpaid-1" } });
    expect(ledgerRow?.outcome).toBe("overpaid");

    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(1); // one ADMIN_IDS entry ([333])
    const payload = JSON.parse(adminRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.chat_id).toBe(333);
    expect(payload.order_code).toBe(result.order.orderCode);
    expect(payload.paid).toBe(paid.toString());
    expect(payload.expected).toBe(expectedTotal.toString());
    expect(payload.excess).toBe("1.25");
    expect(payload.currency).toBe(result.order.currency);
  });

  // H-3 (backend audit 2026-07-31): the ledger claim used to survive a failed
  // delivery transaction forever — every retry (webhook redelivery, reconcile
  // poller) hit the trx_id UNIQUE constraint and was turned away as
  // already_processed, silently losing the buyer's payment. Wiping all stock
  // for the product forces approveOrder's out-of-stock guard to throw INSIDE
  // the delivery $transaction, rolling it back (the real-world equivalent of
  // a SQLITE_BUSY collision or a transient failure mid-delivery).
  it("a claim whose delivery failed is retryable — a later call with the same trx id succeeds instead of already_processed", async () => {
    const order = await makePendingNowpaymentsOrder();

    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: StockStatus.DEAD } });

    await expect(
      deliverPaidNowpaymentsOrder(prisma, { orderId: order.id, trxId: "trx-retry-1", amount: order.totalAmount }),
    ).rejects.toThrow();

    // The claim row survives the rollback, tagged delivery_failed — and the
    // order itself rolled all the way back to PENDING_PAYMENT, not stuck
    // mid-transition.
    const failedLedger = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "trx-retry-1" } });
    expect(failedLedger?.outcome).toBe("delivery_failed");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Restock, then retry with the SAME trx id — this must now succeed
    // instead of hitting the UNIQUE constraint and returning already_processed.
    await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials: "retry-cred@example.com:pwd", status: StockStatus.AVAILABLE },
    });

    const retry = await deliverPaidNowpaymentsOrder(prisma, { orderId: order.id, trxId: "trx-retry-1", amount: order.totalAmount });
    expect(retry.status).toBe("delivered");
    if (retry.status !== "delivered") throw new Error("expected delivered");
    expect(retry.order.status).toBe(OrderStatus.DELIVERED);

    const ledgerRow = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "trx-retry-1" } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order.id);

    // Still exactly one ledger row — reclaimed in place, not duplicated.
    const rows = await prisma.processedNowpaymentsTx.findMany({ where: { trxId: "trx-retry-1" } });
    expect(rows.length).toBe(1);
  });

  it("an order that is no longer PENDING_PAYMENT/NOWPAYMENTS is stale", async () => {
    const order = await makePendingNowpaymentsOrder();
    // Simulate the order having already moved on (e.g. expired/cancelled elsewhere).
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });

    const result = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId: "trx-stale-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("stale");

    const ledgerRow = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "trx-stale-1" } });
    expect(ledgerRow?.outcome).toBe("stale");
  });

  // M-35 (backend audit 2026-07-31): the "processing" branch (manual-delivery
  // SKUs, settlePaidOrder's non-AUTO path) had no test at all — including the
  // interaction between two branches that live right next to each other in the
  // code: ORDER_DELIVERED_DM is only enqueued when result.kind === "delivered"
  // (skipped here, since settlePaidOrder already sent its own "being prepared"
  // DM), while the overpaid ledger flag/admin alert deliberately stays
  // unconditional. A test that only checked one of the two could pass while
  // the other silently regressed (e.g. an accidental `&&` tying the overpaid
  // block to `result.kind === "delivered"` too).
  it("processing (manual SKU) + overpaid: ORDER_DELIVERED_DM is skipped but the overpaid admin alert still fires unconditionally", async () => {
    const manualDenom = await makeManualDenom();
    const order = await makePendingNowpaymentsOrderFor(manualDenom.id);
    const expectedTotal = new Decimal(order.totalAmount);
    const paid = expectedTotal.plus("1.5");

    const result = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId: "trx-processing-overpaid-1",
      amount: paid,
      shopUrl: "https://shop.example.com",
    });

    expect(result.status).toBe("processing");
    if (result.status !== "processing") throw new Error("expected processing");
    expect(result.order.status).toBe(OrderStatus.PROCESSING);

    // DM-skip: no ORDER_DELIVERED_DM for a "processing" result...
    const deliveredDm = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_DELIVERED_DM },
    });
    expect(deliveredDm).toBeNull();
    // ...but settlePaidOrder's own buyer DM for the manual queue did go out.
    const processingDm = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_PROCESSING_DM },
    });
    expect(processingDm).not.toBeNull();

    // Overpaid alert stays unconditional regardless of delivery type.
    const ledgerRow = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "trx-processing-overpaid-1" } });
    expect(ledgerRow?.outcome).toBe("overpaid");
    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(1);
    const payload = JSON.parse(adminRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.excess).toBe("1.5");
  });
});

describe("deliverPaidNowpaymentsOrder — WALLET_TOPUP routing", () => {
  async function makeReferredUser() {
    const referrer = await upsertUser(prisma, { telegramId: 9201, username: "topup-referrer-np", fullName: "Referrer" });
    const referee = await upsertUser(prisma, {
      telegramId: 9202,
      username: "topup-referee-np",
      fullName: "Referee",
      referredByCode: referrer.referralCode,
    });
    return { referrer, referee };
  }

  async function makePendingTopupOrder(userId: number, amount: string = "10") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId, amount, currency: "USDT", method: PaymentMethod.NOWPAYMENTS, rate: "16000" }),
    );
  }

  it("a WALLET_TOPUP order routes to settleWalletTopup: wallet credited, no stock/referral side effects", async () => {
    const { referee } = await makeReferredUser();
    const order = await makePendingTopupOrder(referee.id, "10");
    expect(order.kind).toBe(OrderKind.WALLET_TOPUP);

    const result = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId: "trx-topup-1",
      amount: order.totalAmount,
    });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.credentials).toEqual([]);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: referee.id } });
    expect(new Decimal(user.walletBalanceUsdt).equals(order.totalAmount)).toBe(true);

    const stock = await prisma.stockItem.findMany({ where: { productId: sample.product.id } });
    expect(stock.every((s) => s.status === StockStatus.AVAILABLE)).toBe(true);
    const referral = await prisma.referral.findUnique({ where: { refereeId: referee.id } });
    expect(referral).toBeNull();
  });

  // F8 Part A: money that arrives after the payment window closed.
  it("a top-up auto-cancelled at window close is still credited, with exactly one credit DM", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");
    await prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await prisma.$transaction((tx) => cancelOrder(tx, order.id, "expired", { type: StockActorType.SYSTEM }));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CANCELLED);

    const result = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId: "trx-topup-late-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalanceUsdt).equals(order.totalAmount)).toBe(true);

    const dmRows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(dmRows).toHaveLength(1);
  });

  it("a CANCELLED PRODUCT order paid late is still stale — the top-up relaxation does not leak", async () => {
    const productOrder = (await createOrderDirect(prisma, {
      user: sample.user,
      productId: sample.product.id,
      quantity: 1,
    }))!;
    await prisma.order.update({
      where: { id: productOrder.id },
      data: { paymentMethod: PaymentMethod.NOWPAYMENTS },
    });
    await prisma.$transaction((tx) => cancelOrder(tx, productOrder.id, "expired", { type: StockActorType.SYSTEM }));

    const result = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: productOrder.id,
      trxId: "trx-product-late-1",
      amount: productOrder.totalAmount,
    });
    expect(result.status).toBe("stale");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: productOrder.id } })).status).toBe(
      OrderStatus.CANCELLED,
    );
  });

  it("a duplicate gateway tx id does not double-credit the wallet", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");

    const first = await deliverPaidNowpaymentsOrder(prisma, { orderId: order.id, trxId: "trx-topup-dup-1", amount: order.totalAmount });
    expect(first.status).toBe("delivered");

    const second = await deliverPaidNowpaymentsOrder(prisma, { orderId: order.id, trxId: "trx-topup-dup-1", amount: order.totalAmount });
    expect(second.status).toBe("already_processed");

    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "wallet_topup" } });
    expect(rows).toHaveLength(1);

    // Same for the buyer DM — exactly one outbox row, not one per attempt.
    const dmRows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(dmRows).toHaveLength(1);
  });

  // NOWPayments's settlement (deliverPaidNowpaymentsOrder) delegates to
  // settleWalletTopup, which is the ONE call site for WALLET_TOPUP_CREDITED_DM
  // across all six top-up rails (Task E1) — the web process can never send
  // Telegram itself, so this DM reaching the buyer at all depends on that
  // outbox row existing. A USDT top-up exercises the non-IDR currency path
  // alongside tokopay.test.ts's IDR coverage.
  it("enqueues a WALLET_TOPUP_CREDITED_DM outbox row (USDT) with chat_id/order_code/amount/currency/new_balance", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");

    await deliverPaidNowpaymentsOrder(prisma, { orderId: order.id, trxId: "trx-topup-dm-1", amount: order.totalAmount });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.chat_id).toBe(Number(sample.user.telegramId));
    expect(payload.order_code).toBe(order.orderCode);
    expect(payload.amount).toBe(new Decimal(order.totalAmount).toString());
    expect(payload.currency).toBe("USDT");
    expect(payload.new_balance).toBe(new Decimal(order.totalAmount).toString());
  });
});

describe("recordUnmatchedNowpaymentsTx", () => {
  it("first insert returns true", async () => {
    const ok = await recordUnmatchedNowpaymentsTx(prisma, { trxId: "trx-unmatched-1", amount: new Decimal("10000") });
    expect(ok).toBe(true);
    const row = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "trx-unmatched-1" } });
    expect(row?.outcome).toBe("unmatched");
    expect(row?.orderId).toBeNull();
  });

  it("a duplicate trx id returns false", async () => {
    await recordUnmatchedNowpaymentsTx(prisma, { trxId: "trx-unmatched-2", amount: new Decimal("5000") });
    const ok = await recordUnmatchedNowpaymentsTx(prisma, { trxId: "trx-unmatched-2", amount: new Decimal("5000") });
    expect(ok).toBe(false);
    const rows = await prisma.processedNowpaymentsTx.findMany({ where: { trxId: "trx-unmatched-2" } });
    expect(rows.length).toBe(1);
  });
});

// Task 15: an `unmatched` ledger row (IPN callback that arrived while the
// order wasn't currently payable) must not permanently block the SAME trxId
// from ever being delivered by a later, legitimate callback/reconcile-poller
// pass. Only the terminal outcomes ("matched" | "overpaid" | "stale") may
// stay unclaimable forever; "unmatched" and "delivery_failed" never delivered
// anything, so they must stay re-claimable.
describe("deliverPaidNowpaymentsOrder — re-claiming a trxId across non-delivering outcomes", () => {
  it("a trx first recorded as unmatched by the webhook can still be delivered by the reconcile poller", async () => {
    const order = await makePendingNowpaymentsOrder();
    const trxId = "trx-unmatched-reclaim-1";

    const recorded = await recordUnmatchedNowpaymentsTx(prisma, { trxId, amount: new Decimal("5000") });
    expect(recorded).toBe(true);
    const unmatchedRow = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId } });
    expect(unmatchedRow?.outcome).toBe("unmatched");

    const result = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId,
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    const ledgerRow = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order.id);

    const rows = await prisma.processedNowpaymentsTx.findMany({ where: { trxId } });
    expect(rows.length).toBe(1);
  });

  it("a trx already delivered is never re-claimed", async () => {
    // This test claims 6 stock-consuming orders — sampleData's product only
    // ships with 5, so top it up first.
    await bulkAddStock(
      prisma,
      sample.product.id,
      Array.from({ length: 10 }, (_, i) => `terminal-reclaim-${i}@example.com:pwd`),
    );

    // Terminal outcome 1: matched (an ordinary successful delivery).
    const matchedOrder = await makePendingNowpaymentsOrder();
    const matchedTrxId = "trx-terminal-matched-1";
    const delivered = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: matchedOrder.id,
      trxId: matchedTrxId,
      amount: matchedOrder.totalAmount,
    });
    expect(delivered.status).toBe("delivered");

    const otherOrderForMatched = await makePendingNowpaymentsOrder();
    const reclaimAttempt1 = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: otherOrderForMatched.id,
      trxId: matchedTrxId,
      amount: otherOrderForMatched.totalAmount,
    });
    expect(reclaimAttempt1.status).toBe("already_processed");
    const matchedLedger = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: matchedTrxId } });
    expect(matchedLedger?.outcome).toBe("matched");
    expect(matchedLedger?.orderId).toBe(matchedOrder.id);
    expect((await prisma.order.findUnique({ where: { id: otherOrderForMatched.id } }))!.status).toBe(
      OrderStatus.PENDING_PAYMENT,
    );

    // Terminal outcome 2: overpaid (still a real delivery, just flagged).
    const overpaidOrder = await makePendingNowpaymentsOrder();
    const overpaidTrxId = "trx-terminal-overpaid-1";
    const overpaidAmount = new Decimal(overpaidOrder.totalAmount).plus("5");
    const overpaidResult = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: overpaidOrder.id,
      trxId: overpaidTrxId,
      amount: overpaidAmount,
    });
    expect(overpaidResult.status).toBe("delivered");
    const overpaidLedgerBefore = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: overpaidTrxId } });
    expect(overpaidLedgerBefore?.outcome).toBe("overpaid");

    const otherOrderForOverpaid = await makePendingNowpaymentsOrder();
    const reclaimAttempt2 = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: otherOrderForOverpaid.id,
      trxId: overpaidTrxId,
      amount: otherOrderForOverpaid.totalAmount,
    });
    expect(reclaimAttempt2.status).toBe("already_processed");
    const overpaidLedgerAfter = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: overpaidTrxId } });
    expect(overpaidLedgerAfter?.outcome).toBe("overpaid");
    expect(overpaidLedgerAfter?.orderId).toBe(overpaidOrder.id);

    // Terminal outcome 3: stale (the order moved on — e.g. cancelled — before
    // the callback landed). A trxId that lands on a stale order must not
    // become reclaimable either, or a later retry could land on a DIFFERENT
    // order than the one the money was actually meant for.
    const staleOrder = await makePendingNowpaymentsOrder();
    const staleTrxId = "trx-terminal-stale-1";
    await prisma.order.update({ where: { id: staleOrder.id }, data: { status: OrderStatus.CANCELLED } });
    const staleResult = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: staleOrder.id,
      trxId: staleTrxId,
      amount: staleOrder.totalAmount,
    });
    expect(staleResult.status).toBe("stale");
    const staleLedgerBefore = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: staleTrxId } });
    expect(staleLedgerBefore?.outcome).toBe("stale");

    const otherOrderForStale = await makePendingNowpaymentsOrder();
    const reclaimAttempt3 = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: otherOrderForStale.id,
      trxId: staleTrxId,
      amount: otherOrderForStale.totalAmount,
    });
    expect(reclaimAttempt3.status).toBe("already_processed");
    const staleLedgerAfter = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: staleTrxId } });
    expect(staleLedgerAfter?.outcome).toBe("stale");
    expect((await prisma.order.findUnique({ where: { id: otherOrderForStale.id } }))!.status).toBe(
      OrderStatus.PENDING_PAYMENT,
    );
  });
});

describe("getNowpaymentsCreds — minAmount", () => {
  beforeEach(async () => {
    await setSetting(prisma, "nowpayments_api_key", "ak");
    await setSetting(prisma, "nowpayments_ipn_secret", "secret");
  });

  it("defaults to null when unset", async () => {
    await deleteSetting(prisma, "nowpayments_min_amount");
    expect((await getNowpaymentsCreds(prisma))!.minAmount).toBeNull();
  });

  it("parses a configured positive value", async () => {
    await setSetting(prisma, "nowpayments_min_amount", "3.5");
    expect((await getNowpaymentsCreds(prisma))!.minAmount).toEqual(new Decimal("3.5"));
  });

  it("treats a non-numeric or non-positive value as null (never throws)", async () => {
    await setSetting(prisma, "nowpayments_min_amount", "garbage");
    expect((await getNowpaymentsCreds(prisma))!.minAmount).toBeNull();
    await setSetting(prisma, "nowpayments_min_amount", "-3");
    expect((await getNowpaymentsCreds(prisma))!.minAmount).toBeNull();
  });
});

describe("getNowpaymentsCreds — encrypted secrets (Task 13)", () => {
  it("decrypts both nowpayments_api_key and nowpayments_ipn_secret when stored as encrypted envelopes", async () => {
    await setSetting(prisma, "nowpayments_api_key", encryptCredentials("real-nowpayments-apikey", settingValueAad("nowpayments_api_key")));
    await setSetting(prisma, "nowpayments_ipn_secret", encryptCredentials("real-nowpayments-ipnsecret", settingValueAad("nowpayments_ipn_secret")));
    const creds = await getNowpaymentsCreds(prisma);
    expect(creds!.apiKey).toBe("real-nowpayments-apikey");
    expect(creds!.ipnSecret).toBe("real-nowpayments-ipnsecret");
  });
});

// Task 11 review follow-up, Minor #4: apps/order-bot/test/nowpayments-reconcile.test.ts's
// "checks at most MAX_ORDERS_PER_CYCLE orders in one cycle" only asserts
// `fetch` was called 50 times — that passes identically whether the cap is
// enforced in the query (`take: limit`) or bolted on after the fact
// (`.slice(0, 50)`). This crud-level test instead proves the cap lives in the
// query AND pins the oldest-first ordering the reconcile poller's whole
// "closest to auto-cancelling gets checked first" justification depends on.
describe("listPendingNowpaymentsOrders — the query-level cap returns the oldest rows first", () => {
  it("returns exactly `limit` rows, and they are the `limit` oldest by createdAt", async () => {
    const extraCreds = Array.from({ length: 53 }, (_, i) => `cap-test-${i}@example.com:pwd`);
    await bulkAddStock(prisma, sample.product.id, extraCreds);

    const created: { id: number; createdAt: Date }[] = [];
    for (let i = 0; i < 53; i++) {
      const order = await makePendingNowpaymentsOrder();
      // Stagger createdAt explicitly — a tight creation loop can tie at
      // whatever resolution SQLite/JS Date store, which would make "the 50
      // oldest" ambiguous and the assertion below vacuous.
      const createdAt = new Date(Date.now() - (53 - i) * 1000);
      await prisma.order.update({ where: { id: order.id }, data: { createdAt } });
      created.push({ id: order.id, createdAt });
    }
    const oldest50Ids = [...created].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, 50).map((o) => o.id);

    const result = await listPendingNowpaymentsOrders(prisma, new Date(), 50);

    expect(result).toHaveLength(50);
    expect(result.map((o) => o.id)).toEqual(oldest50Ids);
  });
});
