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
  cancelOrder,
  finalizeOrderPayment,
  createPaymentAttempt,
} from "@app/db";
import { OrderCurrency, StockActorType } from "@app/core/enums";
import { config } from "@app/core/config";
import { OrderStatus, OrderKind, PaymentMethod, NotificationEvent, StockStatus } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { qrisChargeAmount } from "@app/core/payments/tokopay";
import { encryptCredentials } from "@app/core/credentialCrypto";

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

// Trustance Phase A Task A2b: deliverPaidTokopayOrder now also confirms this
// order's own PENDING Payment ledger row (if any) in the same transaction as
// delivery — see this file's crud/tokopay.ts for the hook point. TokoPay's
// own gateway trxId is the clean `reference` checkout.ts's buyNowTokopay
// records at creation; this test uses the same shape.
describe("deliverPaidTokopayOrder — Payment ledger confirmation (Task A2b)", () => {
  it("confirms the order's PENDING Payment attempt on delivery", async () => {
    const order = await makePendingTokopayOrder();
    const attempt = await createPaymentAttempt(prisma, {
      orderId: order.id,
      method: PaymentMethod.TOKOPAY,
      amount: order.totalAmount,
      currency: order.currency,
      reference: "TOKOPAY-TRX-LEDGER-1",
    });
    expect(attempt.reference).toBe("TOKOPAY-TRX-LEDGER-1");

    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-ledger-confirm-1",
      amount: qrisChargeAmount(order.totalAmount),
    });
    expect(result.status).toBe("delivered");

    const confirmed = await prisma.payment.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(confirmed.pendingOrderId).toBeNull();
    // The attempt keeps its OWN reference — independent of Order.paymentRef.
    expect(confirmed.reference).toBe("TOKOPAY-TRX-LEDGER-1");
  });

  it("delivers normally with no Payment row at all — the ledger is purely additive", async () => {
    const order = await makePendingTokopayOrder();

    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-no-ledger-row-1",
      amount: qrisChargeAmount(order.totalAmount),
    });
    expect(result.status).toBe("delivered");

    const rows = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(rows.length).toBe(0);
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

  // TokoPay's settlement (deliverPaidTokopayOrder) delegates to
  // settleWalletTopup, which is the ONE call site for WALLET_TOPUP_CREDITED_DM
  // across all six top-up rails (Task E1) — the web process can never send
  // Telegram itself, so this DM reaching the buyer at all depends on that
  // outbox row existing.
  it("enqueues a WALLET_TOPUP_CREDITED_DM outbox row with chat_id/order_code/amount/currency/new_balance and orderId set", async () => {
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
    expect(payload.order_code).toBe(order.orderCode);
    expect(payload.amount).toBe(new Decimal(order.totalAmount).toString());
    expect(payload.currency).toBe(order.currency);
    expect(payload.new_balance).toBe(new Decimal(order.totalAmount).toString());
  });

  // F8 Part A. A top-up reserves nothing — no stock, no voucher, nothing to
  // give back — so once its money has actually arrived, crediting it is always
  // right, even though `autoCancelExpiredOrders` already cancelled the order
  // when the payment window lapsed. The alternative is keeping the buyer's
  // money, which never is.
  it("a top-up auto-cancelled at window close is still credited when the payment lands late", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "20000");
    await prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await prisma.$transaction((tx) => cancelOrder(tx, order.id, "expired", { type: StockActorType.SYSTEM }));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CANCELLED);

    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-topup-late-1",
      amount: order.totalAmount,
    });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalance).equals(order.totalAmount)).toBe(true);

    const ledgerRow = await prisma.processedTokopayTx.findUnique({ where: { trxId: "trx-topup-late-1" } });
    expect(ledgerRow?.outcome).toBe("matched"); // not "stale"

    // The buyer already got an "order cancelled" DM from the auto-cancel job;
    // this credit DM is the follow-up, and there must be exactly one of it.
    const dmRows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(dmRows).toHaveLength(1);
  });

  // The most important guard on the relaxation above: a cancelled PRODUCT
  // order has already released its stock, so reviving it is a different (and
  // far larger) problem. It must stay stale.
  it("a CANCELLED PRODUCT order paid late is still stale — the top-up relaxation does not leak", async () => {
    const order = await makePendingTokopayOrder();
    await prisma.$transaction((tx) => cancelOrder(tx, order.id, "expired", { type: StockActorType.SYSTEM }));
    // Snapshot AFTER the cancel: the cancel itself legitimately released the
    // reservation. What must not change is anything the late callback does.
    const stockBefore = await prisma.stockItem.findMany({ where: { productId: sample.product.id } });

    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-product-late-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("stale");

    const ledgerRow = await prisma.processedTokopayTx.findUnique({ where: { trxId: "trx-product-late-1" } });
    expect(ledgerRow?.outcome).toBe("stale");

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe(OrderStatus.CANCELLED);

    // No wallet credit, no stock movement, no buyer notification.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalance).equals(0)).toBe(true);
    const stockAfter = await prisma.stockItem.findMany({ where: { productId: sample.product.id } });
    expect(stockAfter.map((s) => `${s.id}:${s.status}`).sort()).toEqual(
      stockBefore.map((s) => `${s.id}:${s.status}`).sort(),
    );
    const outbox = await prisma.notificationOutbox.count({ where: { orderId: order.id } });
    expect(outbox).toBe(0);
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

// Postgres migration verification (Task 4): true-concurrency regression for
// the trxId idempotency claim above (`db.processedTokopayTx.create`, gated by
// the `trx_id` UNIQUE constraint). Every "duplicate trx" test elsewhere in
// this file — and in payment-idempotency-matrix.test.ts's "10 refreshes + 5
// webhook retries..." acceptance suite — calls deliverPaidTokopayOrder
// sequentially, one `await` at a time. SQLite's single-writer serialization
// made that indistinguishable from "the claim is race-safe" — there was never
// more than one writer to actually race. This fires 3 concurrent calls with
// the IDENTICAL trxId/amount/orderId via Promise.allSettled against the real
// dev Postgres and asserts the guard still allows exactly one winner. A
// WALLET_TOPUP order is used because it is the one kind that flows through
// settleWalletTopup's own `prisma.$transaction(...)` — the exact code path
// Task 2 fixed a dedupe-key landmine in.
describe("deliverPaidTokopayOrder — true concurrency (Postgres regression, Task 4)", () => {
  it("3 concurrent calls with the same trxId: none throw, exactly one ledger row, wallet credited exactly once, exactly one DM", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
    const trxId = "trx-concurrent-topup-1";

    const before = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(before.walletBalance).equals(0)).toBe(true);

    const results = await Promise.allSettled([
      deliverPaidTokopayOrder(prisma, { orderId: order.id, trxId, amount: order.totalAmount }),
      deliverPaidTokopayOrder(prisma, { orderId: order.id, trxId, amount: order.totalAmount }),
      deliverPaidTokopayOrder(prisma, { orderId: order.id, trxId, amount: order.totalAmount }),
    ]);

    // The guard is DESIGNED to return {status: "already_processed"} for the
    // losers, never throw — assert every call actually resolved, don't just
    // filter for the ones that did.
    const rejectedReasons = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
    expect(rejectedReasons).toEqual([]);

    const statuses = (
      results as PromiseFulfilledResult<Awaited<ReturnType<typeof deliverPaidTokopayOrder>>>[]
    ).map((r) => r.value.status);
    expect(statuses.filter((s) => s === "delivered").length).toBe(1);
    expect(statuses.filter((s) => s === "already_processed").length).toBe(2);

    const ledgerRows = await prisma.processedTokopayTx.findMany({ where: { trxId } });
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0]!.outcome).toBe("matched");
    expect(ledgerRows[0]!.orderId).toBe(order.id);

    // Exactly one order's worth credited — not 2x or 3x.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(after.walletBalance).equals(order.totalAmount)).toBe(true);

    // adjustWallet's ledger effect happened exactly once, not once per winner attempt.
    const credits = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "wallet_topup" } });
    expect(credits.length).toBe(1);

    // Exactly one buyer DM — settleWalletTopup's own enqueue guard, exercised
    // under real concurrent callers rather than sequential retries.
    const dmRows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(dmRows.length).toBe(1);

    // Settled exactly once — not re-processed into an inconsistent state.
    const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe(OrderStatus.DELIVERED);
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

// Task 15: an `unmatched` ledger row (webhook callback that arrived while the
// order wasn't currently payable — wrong method/currency, a short payment
// later topped up) must not permanently block the SAME trxId from ever being
// delivered by a later, legitimate callback/reconcile-poller pass. Only the
// terminal outcomes ("matched" | "overpaid" | "stale") may stay unclaimable
// forever; "unmatched" and "delivery_failed" never delivered anything, so
// they must stay re-claimable.
describe("deliverPaidTokopayOrder — re-claiming a trxId across non-delivering outcomes", () => {
  it("a trx first recorded as unmatched by the webhook can still be delivered by the reconcile poller", async () => {
    const order = await makePendingTokopayOrder();
    const trxId = "trx-unmatched-reclaim-1";

    const recorded = await recordUnmatchedTokopayTx(prisma, { trxId, amount: new Decimal("5000") });
    expect(recorded).toBe(true);
    const unmatchedRow = await prisma.processedTokopayTx.findUnique({ where: { trxId } });
    expect(unmatchedRow?.outcome).toBe("unmatched");

    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId,
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    const ledgerRow = await prisma.processedTokopayTx.findUnique({ where: { trxId } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order.id);

    // Reclaimed in place, not duplicated.
    const rows = await prisma.processedTokopayTx.findMany({ where: { trxId } });
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
    const matchedOrder = await makePendingTokopayOrder();
    const matchedTrxId = "trx-terminal-matched-1";
    const delivered = await deliverPaidTokopayOrder(prisma, {
      orderId: matchedOrder.id,
      trxId: matchedTrxId,
      amount: matchedOrder.totalAmount,
    });
    expect(delivered.status).toBe("delivered");

    const otherOrderForMatched = await makePendingTokopayOrder();
    const reclaimAttempt1 = await deliverPaidTokopayOrder(prisma, {
      orderId: otherOrderForMatched.id,
      trxId: matchedTrxId,
      amount: otherOrderForMatched.totalAmount,
    });
    expect(reclaimAttempt1.status).toBe("already_processed");
    const matchedLedger = await prisma.processedTokopayTx.findUnique({ where: { trxId: matchedTrxId } });
    expect(matchedLedger?.outcome).toBe("matched");
    expect(matchedLedger?.orderId).toBe(matchedOrder.id);
    expect((await prisma.order.findUnique({ where: { id: otherOrderForMatched.id } }))!.status).toBe(
      OrderStatus.PENDING_PAYMENT,
    );

    // Terminal outcome 2: overpaid (still a real delivery, just flagged).
    const overpaidOrder = await makePendingTokopayOrder();
    const overpaidTrxId = "trx-terminal-overpaid-1";
    const overpaidCharge = qrisChargeAmount(overpaidOrder.totalAmount).plus("5");
    const overpaidResult = await deliverPaidTokopayOrder(prisma, {
      orderId: overpaidOrder.id,
      trxId: overpaidTrxId,
      amount: overpaidCharge,
    });
    expect(overpaidResult.status).toBe("delivered");
    const overpaidLedgerBefore = await prisma.processedTokopayTx.findUnique({ where: { trxId: overpaidTrxId } });
    expect(overpaidLedgerBefore?.outcome).toBe("overpaid");

    const otherOrderForOverpaid = await makePendingTokopayOrder();
    const reclaimAttempt2 = await deliverPaidTokopayOrder(prisma, {
      orderId: otherOrderForOverpaid.id,
      trxId: overpaidTrxId,
      amount: otherOrderForOverpaid.totalAmount,
    });
    expect(reclaimAttempt2.status).toBe("already_processed");
    const overpaidLedgerAfter = await prisma.processedTokopayTx.findUnique({ where: { trxId: overpaidTrxId } });
    expect(overpaidLedgerAfter?.outcome).toBe("overpaid");
    expect(overpaidLedgerAfter?.orderId).toBe(overpaidOrder.id);

    // Terminal outcome 3: stale (the order moved on — e.g. cancelled — before
    // the callback landed). A trxId that lands on a stale order must not
    // become reclaimable either, or a later retry could land on a DIFFERENT
    // order than the one the money was actually meant for.
    const staleOrder = await makePendingTokopayOrder();
    const staleTrxId = "trx-terminal-stale-1";
    await prisma.order.update({ where: { id: staleOrder.id }, data: { status: OrderStatus.CANCELLED } });
    const staleResult = await deliverPaidTokopayOrder(prisma, {
      orderId: staleOrder.id,
      trxId: staleTrxId,
      amount: staleOrder.totalAmount,
    });
    expect(staleResult.status).toBe("stale");
    const staleLedgerBefore = await prisma.processedTokopayTx.findUnique({ where: { trxId: staleTrxId } });
    expect(staleLedgerBefore?.outcome).toBe("stale");

    const otherOrderForStale = await makePendingTokopayOrder();
    const reclaimAttempt3 = await deliverPaidTokopayOrder(prisma, {
      orderId: otherOrderForStale.id,
      trxId: staleTrxId,
      amount: otherOrderForStale.totalAmount,
    });
    expect(reclaimAttempt3.status).toBe("already_processed");
    const staleLedgerAfter = await prisma.processedTokopayTx.findUnique({ where: { trxId: staleTrxId } });
    expect(staleLedgerAfter?.outcome).toBe("stale");
    expect((await prisma.order.findUnique({ where: { id: otherOrderForStale.id } }))!.status).toBe(
      OrderStatus.PENDING_PAYMENT,
    );
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

describe("getTokopayCreds — encrypted secret (Task 13)", () => {
  it("decrypts a tokopay_secret row stored as an encrypted envelope", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M");
    await setSetting(prisma, "tokopay_secret", encryptCredentials("real-tokopay-secret"));
    expect((await getTokopayCreds(prisma))!.secret).toBe("real-tokopay-secret");
  });
});

// Task 11 review follow-up, Minor #4: apps/order-bot/test/tokopay-reconcile.test.ts's
// "checks at most MAX_ORDERS_PER_CYCLE orders in one cycle" only asserts
// `fetch` was called 50 times — that passes identically whether the cap is
// enforced in the query (`take: limit`) or bolted on after the fact
// (`.slice(0, 50)`). This crud-level test instead proves the cap lives in the
// query AND pins the oldest-first ordering the reconcile poller's whole
// "closest to auto-cancelling gets checked first" justification depends on.
// F8 Part B. `listPendingTokopayOrders` filters on `expiresAt > now`, and a
// null expiresAt does NOT pass that filter — so until wallet top-ups were
// given a payment window, not a single IDR top-up was ever visible to the
// reconcile poller, leaving the storefront webhook as the only thing that
// could ever settle one.
describe("listPendingTokopayOrders — wallet top-ups are reconcilable", () => {
  it("a freshly created IDR wallet top-up shows up for the reconcile poller", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "50000",
        currency: "IDR",
        method: PaymentMethod.TOKOPAY,
      }),
    );
    expect(order.expiresAt).not.toBeNull();

    const pending = await listPendingTokopayOrders(prisma, new Date());
    expect(pending.map((o) => o.id)).toContain(order.id);
  });

  it("an expired top-up drops back out of the poller's view (the window still means something)", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "50000",
        currency: "IDR",
        method: PaymentMethod.TOKOPAY,
      }),
    );
    await prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    const pending = await listPendingTokopayOrders(prisma, new Date());
    expect(pending.map((o) => o.id)).not.toContain(order.id);
  });

  // Regression: a PRODUCT order's window is stamped at creation
  // (createOrderDirect/createOrderFromCart). finalizeOrderPayment's IDR branch
  // must keep leaving it alone — never extend, never overwrite.
  it("finalizing a PRODUCT IDR order's payment leaves its creation-time expiresAt untouched", async () => {
    const order = await makePendingTokopayOrder();
    const before = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).expiresAt;
    expect(before).not.toBeNull();
    expect((before!.getTime() - Date.now()) / 60_000).toBeLessThanOrEqual(config.PAYMENT_WINDOW_MINUTES);

    await finalizeOrderPayment(prisma, order.id, {
      currency: OrderCurrency.IDR,
      method: PaymentMethod.TOKOPAY,
    });

    const after = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).expiresAt;
    expect(after?.getTime()).toBe(before!.getTime());
  });
});

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
