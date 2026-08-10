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
  setSetting,
  deleteSetting,
  createCategory,
  createCatalogProduct,
  createDenomination,
  createWalletTopupOrder,
  upsertUser,
} from "@app/db";
import { OrderStatus, OrderKind, PaymentMethod, NotificationEvent, StockStatus, DeliveryType } from "@app/core/enums";
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

  // NOWPayments is a WEBHOOK-driven rail (deliverPaidNowpaymentsOrder is
  // called from both the storefront's IPN webhook handler AND the bot's
  // reconcile poller) — the web process can never send Telegram itself, so
  // this is one of the three rails where settlement enqueues
  // WALLET_TOPUP_CREDITED_DM to the outbox (Task 7). A USDT top-up exercises
  // the non-IDR currency path alongside tokopay.test.ts's IDR coverage.
  it("enqueues a WALLET_TOPUP_CREDITED_DM outbox row (USDT) with chat_id/amount/currency/new_balance", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");

    await deliverPaidNowpaymentsOrder(prisma, { orderId: order.id, trxId: "trx-topup-dm-1", amount: order.totalAmount });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.chat_id).toBe(Number(sample.user.telegramId));
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
