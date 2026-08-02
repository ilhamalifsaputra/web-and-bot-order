/**
 * Idempotency-ledger tests for the PayDisini deliver path — same shape as
 * crud/reconciliation.test.ts's setup (makeTestDb + buildSampleData), since
 * there is no colocated tokopay.test.ts to mirror directly. Covers the three
 * deliverPaidPaydisiniOrder branches (delivered/already_processed/stale) plus
 * recordUnmatchedPaydisiniTx's claim-once semantics.
 *
 * This file carries the FULL overpayment suite (Task 5 / H-3) — the other two
 * gateways (tokopay.test.ts, nowpayments.test.ts) only need a representative
 * overpaid assertion since the three deliver functions are intentionally
 * near-identical.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@app/core/config", async () => {
  const actual = await vi.importActual<typeof import("@app/core/config")>("@app/core/config");
  return { ...actual, config: { ...actual.config, ADMIN_IDS: [111, 222] } };
});

import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect, deliverPaidPaydisiniOrder, recordUnmatchedPaydisiniTx, addAdminIdToDb, getPaydisiniCreds, setSetting, deleteSetting, createCategory, createCatalogProduct, createDenomination } from "@app/db";
import { OrderStatus, PaymentMethod, NotificationEvent, StockStatus, DeliveryType } from "@app/core/enums";
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

/** Same as makePendingPaydisiniOrder, but for a caller-supplied denomination
 * (used to route through a manual-delivery SKU instead of sample.product). */
async function makePendingPaydisiniOrderFor(productId: number) {
  const { user } = sample;
  const order = (await createOrderDirect(prisma, { user, productId, quantity: 1 }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: PaymentMethod.PAYDISINI },
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

  it("overpaid: delivers, ledger outcome is overpaid, and enqueues one ADMIN_OVERPAID row per admin id", async () => {
    const order = await makePendingPaydisiniOrder();
    // Pricing applies USE_UNIQUE_CENTS jitter, so totalAmount isn't a round
    // number — compute the expected excess from the actual total instead of
    // assuming "5".
    const expectedTotal = new Decimal(order.totalAmount);
    const paid = expectedTotal.plus("2.50"); // overpay by 2.50

    const result = await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      trxId: "trx-overpaid-1",
      amount: paid,
      shopUrl: "https://shop.example.com",
    });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    const ledgerRow = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "trx-overpaid-1" } });
    expect(ledgerRow?.outcome).toBe("overpaid");

    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
      orderBy: { id: "asc" },
    });
    expect(adminRows.length).toBe(2); // one per ADMIN_IDS entry ([111, 222])
    const chatIds = adminRows.map((r) => JSON.parse(r.payloadJson).chat_id).sort((a, b) => a - b);
    expect(chatIds).toEqual([111, 222]);
    for (const row of adminRows) {
      const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      expect(payload.order_code).toBe(result.order.orderCode);
      expect(payload.paid).toBe(paid.toString());
      expect(payload.expected).toBe(expectedTotal.toString());
      expect(payload.excess).toBe("2.5");
      expect(payload.currency).toBe(result.order.currency);
    }

    // Buyer DM is still enqueued — overpayment doesn't block delivery to the buyer.
    const dmRow = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_DELIVERED_DM },
    });
    expect(dmRow).not.toBeNull();
  });

  // Infra-4 (security audit, 2026-06-23): an admin added ONLY via the DB
  // admin_ids Setting (no env ADMIN_IDS entry) must still get the
  // overpayment alert — previously enqueueAdminOverpaid looped over
  // config.ADMIN_IDS alone, so a shop managed entirely through the DB/setup
  // wizard never reached DB-only admins.
  it("overpaid alerts a DB-only admin too, not just env ADMIN_IDS", async () => {
    await addAdminIdToDb(prisma, 333); // DB-only — not in the mocked ADMIN_IDS=[111,222]
    const order = await makePendingPaydisiniOrder();
    const expectedTotal = new Decimal(order.totalAmount);
    const paid = expectedTotal.plus("1");

    await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      trxId: "trx-overpaid-dbadmin-1",
      amount: paid,
      shopUrl: "https://shop.example.com",
    });

    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    const chatIds = adminRows.map((r) => JSON.parse(r.payloadJson).chat_id).sort((a, b) => a - b);
    expect(chatIds).toEqual([111, 222, 333]);
  });

  it("exact amount: outcome stays matched, no ADMIN_OVERPAID rows", async () => {
    const order = await makePendingPaydisiniOrder();

    const result = await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      trxId: "trx-exact-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");

    const ledgerRow = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "trx-exact-1" } });
    expect(ledgerRow?.outcome).toBe("matched");

    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(0);
  });

  it("replaying an overpaid callback is idempotent — no second delivery, no duplicate ADMIN_OVERPAID rows", async () => {
    const order = await makePendingPaydisiniOrder();
    const paid = new Decimal(order.totalAmount).plus("1");

    const first = await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      trxId: "trx-overpaid-replay-1",
      amount: paid,
    });
    expect(first.status).toBe("delivered");

    const second = await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      trxId: "trx-overpaid-replay-1",
      amount: paid,
    });
    expect(second.status).toBe("already_processed");

    const ledgerRows = await prisma.processedPaydisiniTx.findMany({ where: { trxId: "trx-overpaid-replay-1" } });
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0]?.outcome).toBe("overpaid");

    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(2); // still just one per admin id, not duplicated
  });

  // H-3 (backend audit 2026-07-31): the ledger claim used to survive a failed
  // delivery transaction forever — every retry (webhook redelivery, reconcile
  // poller) hit the trx_id UNIQUE constraint and was turned away as
  // already_processed, silently losing the buyer's payment. Wiping all stock
  // for the product forces approveOrder's out-of-stock guard to throw INSIDE
  // the delivery $transaction, rolling it back (the real-world equivalent of
  // a SQLITE_BUSY collision or a transient failure mid-delivery).
  it("a claim whose delivery failed is retryable — a later call with the same trx id succeeds instead of already_processed", async () => {
    const order = await makePendingPaydisiniOrder();

    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: StockStatus.DEAD } });

    await expect(
      deliverPaidPaydisiniOrder(prisma, { orderId: order.id, trxId: "trx-retry-1", amount: order.totalAmount }),
    ).rejects.toThrow();

    // The claim row survives the rollback, tagged delivery_failed — and the
    // order itself rolled all the way back to PENDING_PAYMENT, not stuck
    // mid-transition.
    const failedLedger = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "trx-retry-1" } });
    expect(failedLedger?.outcome).toBe("delivery_failed");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Restock, then retry with the SAME trx id — this must now succeed
    // instead of hitting the UNIQUE constraint and returning already_processed.
    await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials: "retry-cred@example.com:pwd", status: StockStatus.AVAILABLE },
    });

    const retry = await deliverPaidPaydisiniOrder(prisma, { orderId: order.id, trxId: "trx-retry-1", amount: order.totalAmount });
    expect(retry.status).toBe("delivered");
    if (retry.status !== "delivered") throw new Error("expected delivered");
    expect(retry.order.status).toBe(OrderStatus.DELIVERED);

    const ledgerRow = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "trx-retry-1" } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order.id);

    // Still exactly one ledger row — reclaimed in place, not duplicated.
    const rows = await prisma.processedPaydisiniTx.findMany({ where: { trxId: "trx-retry-1" } });
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
    const order = await makePendingPaydisiniOrderFor(manualDenom.id);
    const expectedTotal = new Decimal(order.totalAmount);
    const paid = expectedTotal.plus("1.5");

    const result = await deliverPaidPaydisiniOrder(prisma, {
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

    // Overpaid alert stays unconditional regardless of delivery type — one
    // ADMIN_OVERPAID row per configured admin id ([111, 222] in this file).
    const ledgerRow = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "trx-processing-overpaid-1" } });
    expect(ledgerRow?.outcome).toBe("overpaid");
    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(2);
    for (const row of adminRows) {
      const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      expect(payload.excess).toBe("1.5");
    }
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

describe("getPaydisiniCreds — minAmount", () => {
  beforeEach(async () => {
    await setSetting(prisma, "paydisini_userkey", "uk");
    await setSetting(prisma, "paydisini_apikey", "ak");
  });

  it("defaults to null when unset", async () => {
    await deleteSetting(prisma, "paydisini_min_amount");
    expect((await getPaydisiniCreds(prisma))!.minAmount).toBeNull();
  });

  it("parses a configured positive value", async () => {
    await setSetting(prisma, "paydisini_min_amount", "25000");
    expect((await getPaydisiniCreds(prisma))!.minAmount).toEqual(new Decimal("25000"));
  });

  it("treats a non-numeric or non-positive value as null (never throws)", async () => {
    await setSetting(prisma, "paydisini_min_amount", "garbage");
    expect((await getPaydisiniCreds(prisma))!.minAmount).toBeNull();
    await setSetting(prisma, "paydisini_min_amount", "0");
    expect((await getPaydisiniCreds(prisma))!.minAmount).toBeNull();
  });
});
