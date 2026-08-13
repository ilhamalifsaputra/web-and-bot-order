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
import {
  createOrderDirect,
  deliverPaidTokopayOrder,
  recordUnmatchedTokopayTx,
  getTokopayCreds,
  listPendingTokopayOrders,
  setSetting,
  deleteSetting,
  createWalletTopupOrder,
  upsertUser,
  bulkAddStock,
} from "@app/db";
import { OrderStatus, OrderKind, PaymentMethod, NotificationEvent, StockStatus } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { qrisChargeAmount } from "@app/core/payments/tokopay";

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

  // Checkout-6 (security audit, 2026-06-23): the auto-deliver path (no human
  // admin involved) must still leave a forensic trail for paid->delivered.
  it("auto-deliver writes an order.auto_deliver audit row with adminId=null", async () => {
    const order = await makePendingTokopayOrder();
    await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-audit-1",
      amount: order.totalAmount,
      shopUrl: "https://shop.example.com",
    });

    const rows = await prisma.auditLog.findMany({ where: { action: "order.auto_deliver", targetId: order.id } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.adminId).toBeNull();
    expect(rows[0]!.details).toContain(order.orderCode);
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

  // H-3 (backend audit 2026-07-31): the ledger claim used to survive a failed
  // delivery transaction forever — every retry (webhook redelivery, reconcile
  // poller) hit the trx_id UNIQUE constraint and was turned away as
  // already_processed, silently losing the buyer's payment. Wiping all stock
  // for the product forces approveOrder's out-of-stock guard to throw INSIDE
  // the delivery $transaction, rolling it back (the real-world equivalent of
  // a SQLITE_BUSY collision or a transient failure mid-delivery).
  it("a claim whose delivery failed is retryable — a later call with the same trx id succeeds instead of already_processed", async () => {
    const order = await makePendingTokopayOrder();

    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: StockStatus.DEAD } });

    await expect(
      deliverPaidTokopayOrder(prisma, { orderId: order.id, trxId: "trx-retry-1", amount: order.totalAmount }),
    ).rejects.toThrow();

    // The claim row survives the rollback, tagged delivery_failed — and the
    // order itself rolled all the way back to PENDING_PAYMENT, not stuck
    // mid-transition.
    const failedLedger = await prisma.processedTokopayTx.findUnique({ where: { trxId: "trx-retry-1" } });
    expect(failedLedger?.outcome).toBe("delivery_failed");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Restock, then retry with the SAME trx id — this must now succeed
    // instead of hitting the UNIQUE constraint and returning already_processed.
    await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials: "retry-cred@example.com:pwd", status: StockStatus.AVAILABLE },
    });

    const retry = await deliverPaidTokopayOrder(prisma, { orderId: order.id, trxId: "trx-retry-1", amount: order.totalAmount });
    expect(retry.status).toBe("delivered");
    if (retry.status !== "delivered") throw new Error("expected delivered");
    expect(retry.order.status).toBe(OrderStatus.DELIVERED);

    const ledgerRow = await prisma.processedTokopayTx.findUnique({ where: { trxId: "trx-retry-1" } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order.id);

    // Still exactly one ledger row — reclaimed in place, not duplicated.
    const rows = await prisma.processedTokopayTx.findMany({ where: { trxId: "trx-retry-1" } });
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
    // assuming "5". "Expected" now includes the QRIS admin fee, since that's
    // the amount actually charged (createTransaction) and checked.
    const expectedCharge = qrisChargeAmount(order.totalAmount);
    const paid = expectedCharge.plus("3"); // overpay by 3

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
    expect(payload.expected).toBe(expectedCharge.toString());
    expect(payload.excess).toBe("3");
    expect(payload.currency).toBe(result.order.currency);
  });

  it("paying exactly total + QRIS admin fee is NOT flagged overpaid", async () => {
    const order = await makePendingTokopayOrder();
    const expectedCharge = qrisChargeAmount(order.totalAmount);

    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-exact-fee-1",
      amount: expectedCharge,
    });
    expect(result.status).toBe("delivered");

    const ledgerRow = await prisma.processedTokopayTx.findUnique({ where: { trxId: "trx-exact-fee-1" } });
    expect(ledgerRow?.outcome).toBe("matched"); // not "overpaid"

    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(0);
  });

  // H-1 (backend audit 2026-07-31): TokoPay's createTransaction sends
  // order.totalAmount (net of any voucher/bulk discount) as `nominal` and
  // TokoPay adds its own fee on top of THAT — never the pre-discount gross
  // subtotal. A voucher-discounted order must deliver (not "amount mismatch"
  // territory / short-paid) when paid exactly totalAmount + fee(totalAmount),
  // even though that's less than totalAmount + fee(subtotalAmount) (the old,
  // wrong formula this test would have failed under).
  it("delivers a voucher-discounted order paid at exactly totalAmount + fee(totalAmount)", async () => {
    const order = (await createOrderDirect(prisma, {
      user: sample.user,
      productId: sample.product.id,
      quantity: 1,
      voucherCode: sample.voucher.code, // SAVE10 — 10% off, minPurchase 3
    }))!;
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.TOKOPAY } });
    // SAVE10 really discounted this order — subtotal and total must diverge,
    // or this test would pass even with the old, buggy subtotal-based formula.
    expect(order.totalAmount.toString()).not.toBe(order.subtotalAmount.toString());

    // What a gateway billing 0.7% of the ACTUAL nominal (totalAmount) sent
    // would charge — the exact figure the buyer's wallet/QR app would show.
    const gatewayFee = new Decimal(100).plus(order.totalAmount.times("0.007")).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const expectedCharge = qrisChargeAmount(order.totalAmount);
    expect(expectedCharge.toString()).toBe(order.totalAmount.plus(gatewayFee).toString());

    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-discount-exact-1",
      amount: expectedCharge,
    });
    expect(result.status).toBe("delivered"); // not short-paid

    const ledgerRow = await prisma.processedTokopayTx.findUnique({ where: { trxId: "trx-discount-exact-1" } });
    expect(ledgerRow?.outcome).toBe("matched"); // not "overpaid" either — exact fee, no excess
  });
});

describe("deliverPaidTokopayOrder — WALLET_TOPUP routing", () => {
  async function makeReferredUser() {
    const referrer = await upsertUser(prisma, { telegramId: 9001, username: "topup-referrer-tp", fullName: "Referrer" });
    const referee = await upsertUser(prisma, {
      telegramId: 9002,
      username: "topup-referee-tp",
      fullName: "Referee",
      referredByCode: referrer.referralCode,
    });
    return { referrer, referee };
  }

  async function makePendingTopupOrder(userId: number, amount: string = "20000") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId, amount, currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
  }

  it("a WALLET_TOPUP order routes to settleWalletTopup: wallet credited, no stock/referral side effects", async () => {
    const { referee } = await makeReferredUser();
    const order = await makePendingTopupOrder(referee.id, "20000");
    expect(order.kind).toBe(OrderKind.WALLET_TOPUP);

    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-topup-1",
      amount: order.totalAmount,
    });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.credentials).toEqual([]);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: referee.id } });
    expect(new Decimal(user.walletBalance).equals(order.totalAmount)).toBe(true);

    // Never touched the product-order machinery: sample.product's stock is
    // untouched, and no referral commission was paid for the referee's
    // first "order" (which would have paid out had this gone through
    // settlePaidOrder instead of settleWalletTopup).
    const stock = await prisma.stockItem.findMany({ where: { productId: sample.product.id } });
    expect(stock.every((s) => s.status === StockStatus.AVAILABLE)).toBe(true);
    const referral = await prisma.referral.findUnique({ where: { refereeId: referee.id } });
    expect(referral).toBeNull();
  });

  // TokoPay is a WEBHOOK-driven rail (deliverPaidTokopayOrder is called from
  // both the storefront's webhook handler AND the bot's reconcile poller) —
  // the web process can never send Telegram itself, so this is one of the
  // three rails where settlement enqueues WALLET_TOPUP_CREDITED_DM to the
  // outbox (Task 7), unlike the three poller-only rails (Binance Internal/
  // Bybit/Bybit BSC), which DM the buyer directly from the bot process.
  it("enqueues a WALLET_TOPUP_CREDITED_DM outbox row with chat_id/amount/currency/new_balance and orderId set", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "20000");

    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-topup-dm-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.chat_id).toBe(Number(sample.user.telegramId));
    expect(payload.amount).toBe(new Decimal(order.totalAmount).toString());
    expect(payload.currency).toBe(order.currency);
    expect(payload.new_balance).toBe(new Decimal(order.totalAmount).toString());
  });

  it("a duplicate gateway tx id does not double-credit the wallet", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "20000");

    const first = await deliverPaidTokopayOrder(prisma, { orderId: order.id, trxId: "trx-topup-dup-1", amount: order.totalAmount });
    expect(first.status).toBe("delivered");

    const second = await deliverPaidTokopayOrder(prisma, { orderId: order.id, trxId: "trx-topup-dup-1", amount: order.totalAmount });
    expect(second.status).toBe("already_processed");

    // adjustWallet's crediting effect (one WalletTransaction row) happened
    // exactly once — not just "the final balance happens to look right".
    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "wallet_topup" } });
    expect(rows).toHaveLength(1);

    // Same for the buyer DM — exactly one outbox row, not one per attempt.
    const dmRows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(dmRows).toHaveLength(1);
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

describe("getTokopayCreds — minAmount", () => {
  beforeEach(async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M");
    await setSetting(prisma, "tokopay_secret", "s");
  });

  it("defaults to null when unset", async () => {
    await deleteSetting(prisma, "tokopay_min_amount");
    expect((await getTokopayCreds(prisma))!.minAmount).toBeNull();
  });

  it("parses a configured positive value", async () => {
    await setSetting(prisma, "tokopay_min_amount", "50000");
    expect((await getTokopayCreds(prisma))!.minAmount).toEqual(new Decimal("50000"));
  });

  it("treats a non-numeric or non-positive value as null (never throws)", async () => {
    await setSetting(prisma, "tokopay_min_amount", "garbage");
    expect((await getTokopayCreds(prisma))!.minAmount).toBeNull();
    await setSetting(prisma, "tokopay_min_amount", "-1");
    expect((await getTokopayCreds(prisma))!.minAmount).toBeNull();
  });
});

// Task 11 review follow-up, Minor #4: apps/order-bot/test/tokopay-reconcile.test.ts's
// "checks at most MAX_ORDERS_PER_CYCLE orders in one cycle" only asserts
// `fetch` was called 50 times — that passes identically whether the cap is
// enforced in the query (`take: limit`) or bolted on after the fact
// (`.slice(0, 50)`). This crud-level test instead proves the cap lives in the
// query AND pins the oldest-first ordering the reconcile poller's whole
// "closest to auto-cancelling gets checked first" justification depends on.
describe("listPendingTokopayOrders — the query-level cap returns the oldest rows first", () => {
  it("returns exactly `limit` rows, and they are the `limit` oldest by createdAt", async () => {
    const extraCreds = Array.from({ length: 53 }, (_, i) => `cap-test-${i}@example.com:pwd`);
    await bulkAddStock(prisma, sample.product.id, extraCreds);

    const created: { id: number; createdAt: Date }[] = [];
    for (let i = 0; i < 53; i++) {
      const order = await makePendingTokopayOrder();
      // Stagger createdAt explicitly — a tight creation loop can tie at
      // whatever resolution SQLite/JS Date store, which would make "the 50
      // oldest" ambiguous and the assertion below vacuous.
      const createdAt = new Date(Date.now() - (53 - i) * 1000);
      await prisma.order.update({ where: { id: order.id }, data: { createdAt } });
      created.push({ id: order.id, createdAt });
    }
    const oldest50Ids = [...created].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, 50).map((o) => o.id);

    const result = await listPendingTokopayOrders(prisma, new Date(), 50);

    expect(result).toHaveLength(50);
    expect(result.map((o) => o.id)).toEqual(oldest50Ids);
  });
});
