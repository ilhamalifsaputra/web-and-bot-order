/**
 * Delivery-path tests for `deliverPaidInternalOrder` — the Binance Internal
 * Transfer analogue of crud/tokopay.test.ts's deliverPaidTokopayOrder suite.
 *
 * Overpayment (M-13, backend audit 2026-07-31): TokoPay/PayDisini/NOWPayments
 * already flag `outcome: "overpaid"` + enqueue an ADMIN_OVERPAID alert when
 * the buyer sent more than the order total. Binance Internal delivered
 * correctly on overpayment (its match tolerance allows it) but never flagged
 * it — this file's "overpaid" test pins the fix.
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
  deliverPaidInternalOrder,
  markUnderpaid,
  markUnderpaidBybit,
  markUnderpaidBybitBsc,
  refundUnderpaidOrder,
  markOrderUnderpaid,
  recordUnmatchedTx,
  createCategory,
  createCatalogProduct,
  createDenomination,
  createWalletTopupOrder,
  upsertUser,
  listSettledOrdersAwaitingBubbleEdit,
  getSettledBubbleOrder,
  setOrderPaymentMessage,
  clearPaymentMessageAnchorsAt,
  bulkAddStock,
  cancelOrder,
  resolveBinanceInternalConfig,
  setSetting,
  createPaymentAttempt,
} from "@app/db";
import { OrderStatus, OrderKind, PaymentMethod, NotificationEvent, DeliveryType, StockStatus } from "@app/core/enums";
import { Decimal } from "@app/core/money";
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

/** Create a PENDING_PAYMENT order stamped as a Binance Internal Transfer payment. */
async function makePendingInternalOrder() {
  const { user, product } = sample;
  const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: PaymentMethod.BINANCE_INTERNAL },
  });
  return order;
}

/** Same as makePendingInternalOrder, but for a caller-supplied denomination
 * (used to route through a manual-delivery SKU instead of sample.product). */
async function makePendingInternalOrderFor(productId: number) {
  const { user } = sample;
  const order = (await createOrderDirect(prisma, { user, productId, quantity: 1 }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: PaymentMethod.BINANCE_INTERNAL },
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

describe("deliverPaidInternalOrder", () => {
  it("delivers a pending order and claims the tx id", async () => {
    const order = await makePendingInternalOrder();

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-delivered-1",
      amount: order.totalAmount,
    });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.credentials.length).toBe(1);

    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "tx-delivered-1" } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order.id);
  });

  it("paying exactly the order total is NOT flagged overpaid", async () => {
    const order = await makePendingInternalOrder();

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-exact-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");

    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "tx-exact-1" } });
    expect(ledgerRow?.outcome).toBe("matched"); // not "overpaid"

    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(0);
  });

  // M-13 (backend audit 2026-07-31): Binance Internal's match tolerance lets an
  // overpaid transfer through to delivery, but it used to leave no ledger flag
  // and no admin alert — the surplus had no operational trail for a later
  // refund request. Mirrors the TokoPay overpaid test (crud/tokopay.test.ts).
  it("overpaid: delivers, ledger outcome is overpaid, and enqueues an ADMIN_OVERPAID row with correct excess/currency", async () => {
    const order = await makePendingInternalOrder();
    const paid = new Decimal(order.totalAmount).plus("3"); // overpay by 3 USDT

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-overpaid-1",
      amount: paid,
    });
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");

    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "tx-overpaid-1" } });
    expect(ledgerRow?.outcome).toBe("overpaid");

    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(1); // one ADMIN_IDS entry ([444])
    const payload = JSON.parse(adminRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.chat_id).toBe(444);
    expect(payload.order_code).toBe(result.order.orderCode);
    expect(payload.paid).toBe(paid.toString());
    expect(payload.expected).toBe(new Decimal(order.totalAmount).toString());
    expect(payload.excess).toBe("3");
    expect(payload.currency).toBe(result.order.currency);
  });

  it("a repeated tx id is already_processed (no double-delivery)", async () => {
    const order = await makePendingInternalOrder();

    const first = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-dup-1",
      amount: order.totalAmount,
    });
    expect(first.status).toBe("delivered");

    const second = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-dup-1",
      amount: order.totalAmount,
    });
    expect(second.status).toBe("already_processed");

    const rows = await prisma.processedBinanceTx.findMany({ where: { binanceTxId: "tx-dup-1" } });
    expect(rows.length).toBe(1);
  });

  it("an order that is no longer PENDING_PAYMENT is stale", async () => {
    const order = await makePendingInternalOrder();
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-stale-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("stale");
  });

  // M-35 (backend audit 2026-07-31): the "processing" branch (manual-delivery
  // SKUs, settlePaidOrder's non-AUTO path) had no test at all — including
  // whether the overpaid ledger flag/admin alert (which stays unconditional,
  // per the code comment) actually still fires when the order queues for hand
  // fulfilment instead of auto-delivering.
  it("processing (manual SKU): kind stays processing, no stock is touched, and the overpaid alert still fires unconditionally", async () => {
    const manualDenom = await makeManualDenom();
    const order = await makePendingInternalOrderFor(manualDenom.id);
    const expectedTotal = new Decimal(order.totalAmount);
    const paid = expectedTotal.plus("2"); // overpay by 2 USDT

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-processing-1",
      amount: paid,
    });

    expect(result.status).toBe("processing");
    if (result.status !== "processing") throw new Error("expected processing");
    expect(result.order.status).toBe(OrderStatus.PROCESSING);

    // Manual SKUs never reserve stock.
    const stockCount = await prisma.stockItem.count({ where: { productId: manualDenom.id } });
    expect(stockCount).toBe(0);

    // Overpayment is orthogonal to delivery type — the ledger flag and admin
    // alert must still fire even though this order queued for hand fulfilment.
    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "tx-processing-1" } });
    expect(ledgerRow?.outcome).toBe("overpaid");
    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(1);
    const payload = JSON.parse(adminRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.excess).toBe("2");

    // settlePaidOrder's own buyer "being prepared" DM went out for the manual queue.
    const processingDm = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_PROCESSING_DM },
    });
    expect(processingDm).not.toBeNull();
  });
});

// Trustance Phase A Task A2b: deliverPaidInternalOrder now also confirms this
// order's own PENDING Payment ledger row (if any) in the same transaction as
// delivery — see this file's crud/binance_internal.ts for the hook point.
describe("deliverPaidInternalOrder — Payment ledger confirmation (Task A2b)", () => {
  it("confirms the order's PENDING Payment attempt on delivery", async () => {
    const order = await makePendingInternalOrder();
    const attempt = await createPaymentAttempt(prisma, {
      orderId: order.id,
      method: PaymentMethod.BINANCE_INTERNAL,
      amount: order.totalAmount,
      currency: order.currency,
      reference: order.paymentRef,
    });

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-ledger-confirm-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");

    const confirmed = await prisma.payment.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(confirmed.pendingOrderId).toBeNull();
  });

  it("confirms the Payment attempt on a WALLET_TOPUP delivery too", async () => {
    const { user } = sample;
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: user.id, amount: "10", currency: "USDT", method: PaymentMethod.BINANCE_INTERNAL, rate: "16000" }),
    );
    const attempt = await createPaymentAttempt(prisma, {
      orderId: order.id,
      method: PaymentMethod.BINANCE_INTERNAL,
      amount: order.totalAmount,
      currency: order.currency,
      reference: order.paymentRef,
    });

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-ledger-confirm-topup-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");

    const confirmed = await prisma.payment.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(confirmed.status).toBe("CONFIRMED");
  });

  it("delivers normally with no Payment row at all — the ledger is purely additive", async () => {
    // No createPaymentAttempt call here at all: this is the common case until
    // every order flows through the new checkout.ts wiring, and it must never
    // block or alter delivery (every OTHER test in this file already proves
    // this implicitly by never creating a Payment row; this test just makes
    // the guarantee explicit).
    const order = await makePendingInternalOrder();

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-no-ledger-row-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");

    const rows = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(rows.length).toBe(0);
  });
});

// Followup review fix (2026-08): Task 15 originally widened the reclaimable
// set to include "unmatched" on THIS rail too, copying the QRIS rails'
// 1:1-trxId reasoning onto a rail that matches by amount against ANY pending
// order — a real money-loss bug, since re-claiming "unmatched" here means an
// old stray deposit (an owner's own top-up, a late payment for an expired
// order) can auto-match and auto-deliver a completely unrelated LATER order
// that merely happens to share its total. The fix restores the pre-Task-15
// behavior for "unmatched" specifically: it is terminal again on this rail,
// recoverable only through `manualMatchTx`/`dismissUnmatchedTx`.
// "delivery_failed" is unaffected — it never re-runs the amount guess, only
// retries delivery for the SAME (order, amount) pairing already chosen, so
// it stays re-claimable (see the "delivery failed is retryable" test below
// and AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES's doc-comment in this file).
describe("deliverPaidInternalOrder — re-claiming a tx id across non-delivering outcomes", () => {
  // Inverted from "a tx first recorded as unmatched by the poller can still
  // be delivered by a later poller pass" (Task 15's now-wrong assertion) —
  // see the module-level fix note above. "unmatched" must stay terminal on
  // this amount-matched rail, so a later poller pass claiming the same tx id
  // is just another duplicate, not a delivery.
  it("a tx first recorded as unmatched stays terminal — a later poller pass reports already_processed, not delivered", async () => {
    const order = await makePendingInternalOrder();
    const binanceTxId = "tx-unmatched-reclaim-1";

    const recorded = await recordUnmatchedTx(prisma, { binanceTxId, amount: new Decimal("5") });
    expect(recorded).toBe(true);
    const unmatchedRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId } });
    expect(unmatchedRow?.outcome).toBe("unmatched");

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId,
      amount: order.totalAmount,
    });
    expect(result.status).toBe("already_processed");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);

    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId } });
    expect(ledgerRow?.outcome).toBe("unmatched");
    expect(ledgerRow?.orderId).toBeNull();
  });

  // The actual money-loss scenario the review caught: an "unmatched" deposit
  // sits in the ledger (e.g. the shop owner's own top-up, or a late payment
  // for an order that has since expired), and LATER an unrelated order is
  // created whose total happens to equal that same amount. Without this fix,
  // the next poller cycle would amount-match and auto-deliver goods for
  // money that was never paid for them.
  it("an unmatched deposit does not auto-deliver a later, unrelated order that happens to share its amount", async () => {
    const binanceTxId = "tx-unmatched-stray-deposit-1";
    const recorded = await recordUnmatchedTx(prisma, { binanceTxId, amount: new Decimal("5") });
    expect(recorded).toBe(true);

    // A genuinely unrelated order is created afterwards, priced to exactly
    // match the stray deposit — the scenario a poller's amount-matching
    // would otherwise treat as a hit.
    const laterOrder = await makePendingInternalOrder();
    await prisma.order.update({ where: { id: laterOrder.id }, data: { totalAmount: new Decimal("5") } });

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: laterOrder.id,
      binanceTxId,
      amount: new Decimal("5"),
    });

    expect(result.status).toBe("already_processed");
    expect((await prisma.order.findUnique({ where: { id: laterOrder.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId } });
    expect(ledgerRow?.outcome).toBe("unmatched");
    expect(ledgerRow?.orderId).toBeNull();
  });

  // H-3-shaped (mirrors tokopay.test.ts's "a claim whose delivery failed is
  // retryable"): wipe stock so approveOrder's out-of-stock guard throws
  // INSIDE the delivery $transaction, rolling it back and tagging the ledger
  // row delivery_failed instead of leaving the payment stuck as unclaimable.
  // Unlike "unmatched" above, "delivery_failed" stays re-claimable on this
  // rail — it repeats a delivery for the SAME (order, amount) pairing a
  // prior cycle already committed to, not a fresh amount guess.
  it("a tx whose delivery failed is retryable — a later call with the same id succeeds instead of already_processed", async () => {
    const order = await makePendingInternalOrder();
    const binanceTxId = "tx-delivery-failed-retry-1";

    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: StockStatus.DEAD } });

    await expect(
      deliverPaidInternalOrder(prisma, { orderId: order.id, binanceTxId, amount: order.totalAmount }),
    ).rejects.toThrow();

    const failedLedger = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId } });
    expect(failedLedger?.outcome).toBe("delivery_failed");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);

    await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials: "retry-cred-binance-1@example.com:pwd", status: StockStatus.AVAILABLE },
    });

    const retry = await deliverPaidInternalOrder(prisma, { orderId: order.id, binanceTxId, amount: order.totalAmount });
    expect(retry.status).toBe("delivered");
    if (retry.status !== "delivered") throw new Error("expected delivered");
    expect(retry.order.status).toBe(OrderStatus.DELIVERED);

    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order.id);

    const rows = await prisma.processedBinanceTx.findMany({ where: { binanceTxId } });
    expect(rows.length).toBe(1);
  });

  it("a tx already delivered is never re-claimed", async () => {
    // This test claims 5 stock-consuming orders — sampleData's product only
    // ships with 5, so top it up first for headroom.
    await bulkAddStock(
      prisma,
      sample.product.id,
      Array.from({ length: 10 }, (_, i) => `terminal-reclaim-${i}@example.com:pwd`),
    );

    // Terminal outcome 1: matched (an ordinary successful delivery).
    const matchedOrder = await makePendingInternalOrder();
    const matchedTxId = "tx-terminal-matched-1";
    const delivered = await deliverPaidInternalOrder(prisma, {
      orderId: matchedOrder.id,
      binanceTxId: matchedTxId,
      amount: matchedOrder.totalAmount,
    });
    expect(delivered.status).toBe("delivered");

    const otherOrderForMatched = await makePendingInternalOrder();
    const reclaimAttempt1 = await deliverPaidInternalOrder(prisma, {
      orderId: otherOrderForMatched.id,
      binanceTxId: matchedTxId,
      amount: otherOrderForMatched.totalAmount,
    });
    expect(reclaimAttempt1.status).toBe("already_processed");
    const matchedLedger = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: matchedTxId } });
    expect(matchedLedger?.outcome).toBe("matched");
    expect(matchedLedger?.orderId).toBe(matchedOrder.id);
    expect((await prisma.order.findUnique({ where: { id: otherOrderForMatched.id } }))!.status).toBe(
      OrderStatus.PENDING_PAYMENT,
    );

    // Terminal outcome 2: overpaid (still a real delivery, just flagged).
    const overpaidOrder = await makePendingInternalOrder();
    const overpaidTxId = "tx-terminal-overpaid-1";
    const overpaidAmount = new Decimal(overpaidOrder.totalAmount).plus("3");
    const overpaidResult = await deliverPaidInternalOrder(prisma, {
      orderId: overpaidOrder.id,
      binanceTxId: overpaidTxId,
      amount: overpaidAmount,
    });
    expect(overpaidResult.status).toBe("delivered");
    const overpaidLedgerBefore = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: overpaidTxId } });
    expect(overpaidLedgerBefore?.outcome).toBe("overpaid");

    const otherOrderForOverpaid = await makePendingInternalOrder();
    const reclaimAttempt2 = await deliverPaidInternalOrder(prisma, {
      orderId: otherOrderForOverpaid.id,
      binanceTxId: overpaidTxId,
      amount: otherOrderForOverpaid.totalAmount,
    });
    expect(reclaimAttempt2.status).toBe("already_processed");
    const overpaidLedgerAfter = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: overpaidTxId } });
    expect(overpaidLedgerAfter?.outcome).toBe("overpaid");
    expect(overpaidLedgerAfter?.orderId).toBe(overpaidOrder.id);

    // Terminal outcome 3: stale (the order moved on — e.g. cancelled — before
    // the poller matched it). Unlike TokoPay/PayDisini/NOWPayments,
    // deliverPaidInternalOrder's stale branch does not flip the ledger
    // outcome to "stale" — the row it already claimed as "matched" in step 1
    // (before the order-status check) simply stays "matched". That is a
    // pre-existing quirk of this rail, out of scope for Task 15, but it means
    // the terminal set is enforced here too: "matched" is excluded from
    // AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES, so this trx id is correctly never
    // reclaimable either way.
    const staleOrder = await makePendingInternalOrder();
    const staleTxId = "tx-terminal-stale-1";
    await prisma.order.update({ where: { id: staleOrder.id }, data: { status: OrderStatus.CANCELLED } });
    const staleResult = await deliverPaidInternalOrder(prisma, {
      orderId: staleOrder.id,
      binanceTxId: staleTxId,
      amount: staleOrder.totalAmount,
    });
    expect(staleResult.status).toBe("stale");
    const staleLedgerBefore = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: staleTxId } });
    expect(staleLedgerBefore?.outcome).toBe("matched"); // not flipped to "stale" on this rail — see comment above
    expect(staleLedgerBefore?.orderId).toBe(staleOrder.id);

    const otherOrderForStale = await makePendingInternalOrder();
    const reclaimAttempt3 = await deliverPaidInternalOrder(prisma, {
      orderId: otherOrderForStale.id,
      binanceTxId: staleTxId,
      amount: otherOrderForStale.totalAmount,
    });
    expect(reclaimAttempt3.status).toBe("already_processed");
    const staleLedgerAfter = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: staleTxId } });
    expect(staleLedgerAfter?.orderId).toBe(staleOrder.id);
    expect((await prisma.order.findUnique({ where: { id: otherOrderForStale.id } }))!.status).toBe(
      OrderStatus.PENDING_PAYMENT,
    );
  });

  // Task 15 review, Minor #3: this rail's own code never writes outcome
  // "stale" (see the comment above), so the "Terminal outcome 3" case just
  // above is really a second "matched" case wearing a stale label — it does
  // not exercise a row whose outcome column actually reads "stale". Seed one
  // directly (the way the three QRIS ledgers write it) and confirm the
  // negative pin holds for a genuine "stale" row too.
  it("a directly-seeded 'stale'-outcome row (as the QRIS rails write it) is never re-claimed", async () => {
    const seedOrder = await makePendingInternalOrder();
    const staleTxId = "tx-seeded-stale-1";
    await prisma.processedBinanceTx.create({
      data: { binanceTxId: staleTxId, orderId: seedOrder.id, amount: new Decimal("5"), outcome: "stale" },
    });

    const otherOrder = await makePendingInternalOrder();
    const result = await deliverPaidInternalOrder(prisma, {
      orderId: otherOrder.id,
      binanceTxId: staleTxId,
      amount: otherOrder.totalAmount,
    });

    expect(result.status).toBe("already_processed");
    const ledgerAfter = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: staleTxId } });
    expect(ledgerAfter?.outcome).toBe("stale");
    expect(ledgerAfter?.orderId).toBe(seedOrder.id);
    expect((await prisma.order.findUnique({ where: { id: otherOrder.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  // Adapted from "a re-claimed tx whose order turns out stale is reverted to
  // unmatched, not stranded as matched" (Task 15 review, Important #1): that
  // test seeded the reclaim from "unmatched", which can no longer happen on
  // this rail — "unmatched" is terminal again (see the module-fix note
  // above), so a reclaim attempt against it now short-circuits to
  // already_processed before ever touching the order (pinned by the
  // money-loss regression test above). The revert-on-stale logic itself is
  // still real and still needed for "delivery_failed", the one outcome that
  // remains reclaimable on this rail — this test now seeds from that instead.
  it("a re-claimed tx whose order turns out stale is reverted to delivery_failed, not stranded as matched", async () => {
    const originalOrder = await makePendingInternalOrder();
    // Created BEFORE stock is wiped below — createOrderDirect requires
    // available stock at creation time even though this order's own status
    // check (not stock) is what the test cares about.
    const staleOrder = await makePendingInternalOrder();
    const binanceTxId = "tx-delivery-failed-then-stale-1";

    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: StockStatus.DEAD } });
    await expect(
      deliverPaidInternalOrder(prisma, { orderId: originalOrder.id, binanceTxId, amount: originalOrder.totalAmount }),
    ).rejects.toThrow();
    const failedLedger = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId } });
    expect(failedLedger?.outcome).toBe("delivery_failed");
    expect(failedLedger?.orderId).toBe(originalOrder.id);

    // A later poller cycle re-claims the SAME tx id against a DIFFERENT
    // order that has since left PENDING_PAYMENT (e.g. cancelled).
    await prisma.order.update({ where: { id: staleOrder.id }, data: { status: OrderStatus.CANCELLED } });

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: staleOrder.id,
      binanceTxId,
      amount: staleOrder.totalAmount,
    });
    expect(result.status).toBe("stale");

    const ledgerAfter = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId } });
    expect(ledgerAfter?.outcome).toBe("delivery_failed");
    expect(ledgerAfter?.orderId).toBe(originalOrder.id);

    // Still re-claimable — a later, legitimate poller pass can still deliver
    // it (delivery_failed has no manual-match tool; recovery is automatic).
    await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials: "retry-cred-binance-2@example.com:pwd", status: StockStatus.AVAILABLE },
    });
    const recoveryOrder = await makePendingInternalOrder();
    const recovered = await deliverPaidInternalOrder(prisma, {
      orderId: recoveryOrder.id,
      binanceTxId,
      amount: recoveryOrder.totalAmount,
    });
    expect(recovered.status).toBe("delivered");
  });
});

describe("deliverPaidInternalOrder — WALLET_TOPUP routing", () => {
  async function makeReferredUser() {
    const referrer = await upsertUser(prisma, { telegramId: 9301, username: "topup-referrer-bi", fullName: "Referrer" });
    const referee = await upsertUser(prisma, {
      telegramId: 9302,
      username: "topup-referee-bi",
      fullName: "Referee",
      referredByCode: referrer.referralCode,
    });
    return { referrer, referee };
  }

  async function makePendingTopupOrder(userId: number, amount: string = "10") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId, amount, currency: "USDT", method: PaymentMethod.BINANCE_INTERNAL, rate: "16000" }),
    );
  }

  it("a WALLET_TOPUP order routes to settleWalletTopup: wallet credited, no stock/referral side effects", async () => {
    const { referee } = await makeReferredUser();
    const order = await makePendingTopupOrder(referee.id, "10");
    expect(order.kind).toBe(OrderKind.WALLET_TOPUP);

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-topup-1",
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

    const first = await deliverPaidInternalOrder(prisma, { orderId: order.id, binanceTxId: "tx-topup-dup-1", amount: order.totalAmount });
    expect(first.status).toBe("delivered");

    const second = await deliverPaidInternalOrder(prisma, { orderId: order.id, binanceTxId: "tx-topup-dup-1", amount: order.totalAmount });
    expect(second.status).toBe("already_processed");

    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "wallet_topup" } });
    expect(rows).toHaveLength(1);
  });

  // F8 Part A. A top-up reserves nothing, so once the transfer has actually
  // arrived, crediting it is right even though the order was auto-cancelled
  // when its window lapsed. Keeping the buyer's USDT is not an option.
  it("a top-up auto-cancelled at window close is still credited when the transfer lands late", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");
    await prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await prisma.$transaction((tx) => cancelOrder(tx, order.id, "expired"));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CANCELLED);

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-topup-late-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalanceUsdt).equals(order.totalAmount)).toBe(true);

    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "wallet_topup" } });
    expect(rows).toHaveLength(1);
  });

  it("a CANCELLED PRODUCT order paid late is still stale — the top-up relaxation does not leak", async () => {
    const order = await makePendingInternalOrder();
    await prisma.$transaction((tx) => cancelOrder(tx, order.id, "expired"));

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-product-late-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("stale");

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe(OrderStatus.CANCELLED);
  });

  // Task E1: WALLET_TOPUP_CREDITED_DM is now enqueued from inside
  // settleWalletTopup itself — the ONE call site for that event across all
  // six top-up rails, including this poller-only one (Binance Internal is a
  // POLLER-ONLY rail: deliverPaidInternalOrder only ever runs inside the bot
  // process's own internal-transfer poller, never a web request). This used
  // to be split — three webhook rails enqueued it while three poller rails
  // (including this one) DM'd the buyer directly from the bot process — and
  // that split is exactly what let a QRIS top-up double-notify; the poller's
  // own `onDelivered` no longer sends a direct DM, so this row is now the
  // buyer's only notification.
  it("enqueues a WALLET_TOPUP_CREDITED_DM outbox row — settleWalletTopup is the one producer, even for this poller-only rail", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");

    const result = await deliverPaidInternalOrder(prisma, { orderId: order.id, binanceTxId: "tx-topup-nodm-1", amount: order.totalAmount });
    expect(result.status).toBe("delivered");

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.order_code).toBe(order.orderCode);
  });
});

// Task 18: markUnderpaid's ledger claim, order.update, and transitionOrderStatus
// used to run as three separate statements outside any transaction — a crash
// or error between them could leave the ledger claiming the transfer was
// handled while the order never actually moved to UNDERPAID (or vice versa).
// These pin the existing return values (must not change) and the new
// all-or-nothing rollback behavior.
describe("markUnderpaid — transactional (Task 18)", () => {
  it("flags the order once (idempotent) — return values unchanged", async () => {
    const order = await makePendingInternalOrder();

    const first = await markUnderpaid(prisma, { orderId: order.id, binanceTxId: "tx-underpaid-1", amount: "1.00" });
    expect(first).toBe(true);
    const flagged = await prisma.order.findUnique({ where: { id: order.id } });
    expect(flagged!.status).toBe(OrderStatus.UNDERPAID);
    expect(flagged!.adminNote).toBe("[underpaid] received 1 via tx tx-underpaid-1");

    const second = await markUnderpaid(prisma, { orderId: order.id, binanceTxId: "tx-underpaid-1", amount: "1.00" });
    expect(second).toBe(false);

    const rows = await prisma.processedBinanceTx.findMany({ where: { binanceTxId: "tx-underpaid-1" } });
    expect(rows).toHaveLength(1);
  });

  // The RED test for Task 18: before the fix, the ledger create and
  // order.update ran as separate statements ahead of transitionOrderStatus,
  // so forcing that last write to fail left a torn state — a claimed ledger
  // row and a stamped adminNote on an order that never moved to UNDERPAID.
  // Moving the order out of PENDING_PAYMENT before calling markUnderpaid
  // makes transitionOrderStatus throw naturally (illegal transition), with
  // no need to mock internals.
  it("leaves the order untouched when the status transition fails partway", async () => {
    const order = await makePendingInternalOrder();
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });

    await expect(
      markUnderpaid(prisma, { orderId: order.id, binanceTxId: "tx-underpaid-partial-1", amount: "1.00" }),
    ).rejects.toThrow();

    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "tx-underpaid-partial-1" } });
    expect(ledgerRow).toBeNull();

    const refreshedOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshedOrder!.status).toBe(OrderStatus.CANCELLED);
    expect(refreshedOrder!.adminNote).toBeNull();
    expect(refreshedOrder!.binanceTxid).toBeNull();
  });
});

// refundUnderpaidOrder credits the buyer whatever they actually sent, read
// back from the ledger row the flagging rail wrote. Three rails can flag an
// order UNDERPAID and they use two different tables: Binance Internal writes
// `processedBinanceTx`, while Bybit and Bybit BSC share `processedBybitTx`.
// The lookup used to read only `processedBinanceTx`, so a Bybit-flagged order
// refunded to 0.00 — the buyer's money silently vanished.
describe("refundUnderpaidOrder — reads the received amount from whichever rail flagged the order", () => {
  it("credits the amount from processedBinanceTx for a Binance-Internal-flagged order", async () => {
    const order = await makePendingInternalOrder();
    expect(await markUnderpaid(prisma, { orderId: order.id, binanceTxId: "tx-refund-binance-1", amount: "4.25" })).toBe(true);

    const { refunded } = await refundUnderpaidOrder(prisma, { orderId: order.id, adminId: 444 });

    expect(refunded.toString()).toBe("4.25");
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).toString()).toBe("4.25");
  });

  // The regression test: before the fix this credited 0 because the lookup
  // never looked at processedBybitTx.
  it("credits the amount from processedBybitTx for a Bybit-flagged order instead of refunding 0", async () => {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT } });
    expect(await markUnderpaidBybit(prisma, { orderId: order.id, bybitTxId: "tx-refund-bybit-1", amount: "3.75" })).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.UNDERPAID);

    const { refunded, refundId } = await refundUnderpaidOrder(prisma, { orderId: order.id, adminId: 444 });

    expect(refunded.toString()).toBe("3.75");
    expect(refundId).not.toBeNull();

    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).toString()).toBe("3.75");

    const walletTx = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "underpaid_refund" } });
    expect(walletTx).toHaveLength(1);
    expect(new Decimal(walletTx[0]!.delta).toString()).toBe("3.75");

    const resolvedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(resolvedOrder.status).toBe(OrderStatus.REFUNDED);
  });

  // Bybit BSC shares processedBybitTx with Bybit — one table, no sub-rail
  // column — so the same lookup already covers it; this pins that.
  it("credits the amount from processedBybitTx for a Bybit-BSC-flagged order too (both sub-rails share the table)", async () => {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT_BSC } });
    expect(await markUnderpaidBybitBsc(prisma, { orderId: order.id, bybitTxId: "0xdeadbeef-refund-1", amount: "2.5" })).toBe(true);

    const { refunded } = await refundUnderpaidOrder(prisma, { orderId: order.id, adminId: 444 });

    expect(refunded.toString()).toBe("2.5");
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).toString()).toBe("2.5");
  });

  // No ledger row at all (e.g. an order moved to UNDERPAID by hand): still
  // resolves the order, but writes no wallet credit and no Refund record —
  // a COMPLETED 0.00 refund would imply a payout that never happened.
  it("refunds nothing and writes no Refund record when no rail recorded a received amount", async () => {
    const order = await makePendingInternalOrder();
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.UNDERPAID } });

    const { refunded, refundId } = await refundUnderpaidOrder(prisma, { orderId: order.id, adminId: 444 });

    expect(refunded.toString()).toBe("0");
    expect(refundId).toBeNull();
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id } })).toBe(0);
  });

  // The refund has to land in the balance column matching the ORDER's own
  // currency. `adjustWallet` defaults to IDR when no currency is passed, and
  // this call site passed none — so a USDT order refunded 4.25 USDT into the
  // buyer's rupiah balance, inventing rupiah out of nothing and leaving the
  // USDT they actually sent unreturned.
  //
  // The bug was unreachable until the QrisUnderpaidTx ledger landed: it is
  // NOWPayments — a USDT crypto-invoice rail that structurally flags
  // underpayment through the QRIS/IDR ledger table — that made
  // `findUnderpaidReceived` resolve a real amount for a USDT order for the
  // first time. Before that it always read 0 for this rail and the credit was
  // skipped entirely, so the wrong-column credit never actually ran. This test
  // therefore drives the exact newly-reachable path: a USDT order flagged via
  // `markOrderUnderpaid`.
  it("credits a USDT order's refund to walletBalanceUsdt, leaving the rupiah balance untouched", async () => {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({
      where: { id: order.id },
      data: { paymentMethod: PaymentMethod.NOWPAYMENTS, currency: "USDT", fxRate: "16000" },
    });
    expect(
      await markOrderUnderpaid(prisma, {
        orderId: order.id,
        gateway: "NOWPayments",
        receivedAmount: "4.25",
        expectedAmount: "10",
      }),
    ).toBe(true);

    const { refunded, refundId, currency } = await refundUnderpaidOrder(prisma, { orderId: order.id, adminId: 444 });

    expect(refunded.toString()).toBe("4.25");
    expect(refundId).not.toBeNull();
    // The currency comes back with the amount so the calling route's audit
    // line can name it — "4.25" alone reads the same whether it is USDT or
    // rupiah, and the refund now lands in the order's own currency.
    expect(currency).toBe("USDT");

    // Same reason on the order's admin note: it is the record a shop admin
    // reads months later, so it has to say which money was returned.
    const noted = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(noted.adminNote).toContain("[refund] 4.25 USDT to wallet");

    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalanceUsdt).toString()).toBe("4.25");
    expect(new Decimal(buyer.walletBalance).toString()).toBe("0");

    const walletTx = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "underpaid_refund" } });
    expect(walletTx).toHaveLength(1);
    expect(walletTx[0]!.currency).toBe("USDT");
    expect(new Decimal(walletTx[0]!.delta).toString()).toBe("4.25");
  });
});

// T2-A: the generic cross-method query the paid-order bubble-flip sweeper
// polls. Not locked to one payment method or to DELIVERED — see each proof
// below. (It replaced an earlier, TokoPay/PayDisini-only query,
// `listDeliveredOrdersAwaitingEdit`, removed in Task T2-F once the generic
// sweeper covered every rail — that function's own query-level-cap test used
// to live here too; see "respects `limit`, returning the oldest rows first"
// further down for the equivalent pin on this query.)
describe("listSettledOrdersAwaitingBubbleEdit", () => {
  /** Create + stamp an order with the given status/method/anchor in one go. */
  async function makeAnchoredOrder(opts: {
    status: string;
    paymentMethod: string;
    paymentMsgChatId?: bigint | null;
    paymentMsgId?: number | null;
    createdAt?: Date;
  }) {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: opts.status,
        paymentMethod: opts.paymentMethod,
        paymentMsgChatId: opts.paymentMsgChatId === undefined ? BigInt(555) : opts.paymentMsgChatId,
        paymentMsgId: opts.paymentMsgId === undefined ? 777 : opts.paymentMsgId,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
    return order.id;
  }

  it("returns settled orders across different payment methods in one call", async () => {
    const tokopayId = await makeAnchoredOrder({ status: OrderStatus.DELIVERED, paymentMethod: PaymentMethod.TOKOPAY });
    const binanceId = await makeAnchoredOrder({ status: OrderStatus.DELIVERED, paymentMethod: PaymentMethod.BINANCE_INTERNAL });
    const nowpaymentsId = await makeAnchoredOrder({ status: OrderStatus.DELIVERED, paymentMethod: PaymentMethod.NOWPAYMENTS });

    const result = await listSettledOrdersAwaitingBubbleEdit(prisma);

    expect(result.map((o) => o.id).sort((a, b) => a - b)).toEqual([tokopayId, binanceId, nowpaymentsId].sort((a, b) => a - b));
  });

  it("returns both PROCESSING (manual-fulfilment) and DELIVERED orders", async () => {
    const processingId = await makeAnchoredOrder({ status: OrderStatus.PROCESSING, paymentMethod: PaymentMethod.TOKOPAY });
    const deliveredId = await makeAnchoredOrder({ status: OrderStatus.DELIVERED, paymentMethod: PaymentMethod.TOKOPAY });

    const result = await listSettledOrdersAwaitingBubbleEdit(prisma);

    expect(result.map((o) => o.id).sort((a, b) => a - b)).toEqual([processingId, deliveredId].sort((a, b) => a - b));
  });

  it("does not return an order whose paymentMsgId is null (already flipped or never anchored)", async () => {
    await makeAnchoredOrder({
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.BINANCE_INTERNAL,
      paymentMsgChatId: null,
      paymentMsgId: null,
    });

    const result = await listSettledOrdersAwaitingBubbleEdit(prisma);

    expect(result).toHaveLength(0);
  });

  it("does not return Bybit BSC intermediate tracking statuses (PAYMENT_DETECTED, CONFIRMING, CONFIRMED)", async () => {
    await makeAnchoredOrder({ status: OrderStatus.PAYMENT_DETECTED, paymentMethod: PaymentMethod.BYBIT_BSC });
    await makeAnchoredOrder({ status: OrderStatus.CONFIRMING, paymentMethod: PaymentMethod.BYBIT_BSC });
    await makeAnchoredOrder({ status: OrderStatus.CONFIRMED, paymentMethod: PaymentMethod.BYBIT_BSC });

    const result = await listSettledOrdersAwaitingBubbleEdit(prisma);

    expect(result).toHaveLength(0);
  });

  it("respects `limit`, returning the oldest rows first", async () => {
    const now = Date.now();
    const older = await makeAnchoredOrder({
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.TOKOPAY,
      createdAt: new Date(now - 5000),
    });
    await makeAnchoredOrder({
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.TOKOPAY,
      createdAt: new Date(now - 1000),
    });

    const result = await listSettledOrdersAwaitingBubbleEdit(prisma, 1);

    expect(result.map((o) => o.id)).toEqual([older]);
  });

  it("projects kind for a WALLET_TOPUP row", async () => {
    // `currency`/`totalAmount` used to be pinned here too, but
    // `settledPaymentBubble` (apps/order-bot/src/util/delivery.ts) no longer
    // reads either off its `SettledBubbleOrder` parameter — the WALLET_TOPUP
    // bubble renders a neutral status line (Task E1) and neither field was
    // ever added back — so this `select` (and this test) dropped them along
    // with the rest of that review follow-up. `kind` stays pinned since the
    // sweeper still branches on it via `settledPaymentBubble`.
    const id = await makeAnchoredOrder({ status: OrderStatus.DELIVERED, paymentMethod: PaymentMethod.TOKOPAY });
    await prisma.order.update({
      where: { id },
      data: { kind: OrderKind.WALLET_TOPUP, currency: "IDR", totalAmount: "150000" },
    });

    const result = await listSettledOrdersAwaitingBubbleEdit(prisma);

    expect(result).toHaveLength(1);
    const [row] = result;
    expect(row!.kind).toBe(OrderKind.WALLET_TOPUP);
    expect(row).not.toHaveProperty("currency");
    expect(row).not.toHaveProperty("totalAmount");
  });

  it("never includes passwordHash on the returned user (explicit select, not include)", async () => {
    await prisma.user.update({ where: { id: sample.user.id }, data: { passwordHash: "should-never-leak" } });
    await makeAnchoredOrder({ status: OrderStatus.DELIVERED, paymentMethod: PaymentMethod.TOKOPAY });

    const result = await listSettledOrdersAwaitingBubbleEdit(prisma);

    expect(result).toHaveLength(1);
    const [row] = result;
    expect(row!.user).not.toHaveProperty("passwordHash");
    expect(row!.user).not.toHaveProperty("email");
  });
});

// E3: the single-row counterpart the payment-bubble flush hook
// (`flushSettledOrderBubble`, apps/order-bot/src/jobs/index.ts) reads through
// once per settlement DM. It exists because that hook used to call `getOrder`,
// whose `fullInclude` drags the buyer's items, stockItem CREDENTIALS, product
// and voucher into memory to read six scalars — on single-writer SQLite, on
// every settled order. These tests pin both halves of "same projection as the
// sweep query, minus the sweep's where clause".
describe("getSettledBubbleOrder", () => {
  /** Create + stamp one order with the given status/anchor. */
  async function makeOrder(opts: { status: string; anchored: boolean }) {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: opts.status,
        paymentMethod: PaymentMethod.BINANCE_INTERNAL,
        paymentMsgChatId: opts.anchored ? BigInt(555) : null,
        paymentMsgId: opts.anchored ? 777 : null,
      },
    });
    return order.id;
  }

  it("projects exactly the bubble-flip fields, and never the buyer's credentials or passwordHash", async () => {
    await prisma.user.update({ where: { id: sample.user.id }, data: { passwordHash: "should-never-leak" } });
    const id = await makeOrder({ status: OrderStatus.DELIVERED, anchored: true });

    const row = await getSettledBubbleOrder(prisma, id);

    expect(row).not.toBeNull();
    expect(Object.keys(row!).sort()).toEqual(
      ["id", "kind", "orderCode", "paymentMsgChatId", "paymentMsgId", "status", "user"].sort(),
    );
    expect(row!.user).not.toHaveProperty("passwordHash");
    expect(row!.user).not.toHaveProperty("email");
    expect(Object.keys(row!.user!)).toEqual(["language"]);
  });

  it("still returns an order the sweep query would filter out, so the caller can classify it itself", async () => {
    // No `where` on status/anchor here on purpose: `flipSettledOrderBubble`
    // already turns these two into "not_settled"/"no_anchor". Filtering in the
    // query would collapse both into an indistinguishable "order not found".
    const unsettled = await makeOrder({ status: OrderStatus.PENDING_PAYMENT, anchored: true });
    const unanchored = await makeOrder({ status: OrderStatus.DELIVERED, anchored: false });

    const unsettledRow = await getSettledBubbleOrder(prisma, unsettled);
    const unanchoredRow = await getSettledBubbleOrder(prisma, unanchored);

    expect(unsettledRow?.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(unanchoredRow?.paymentMsgId).toBeNull();
  });

  it("returns null for an order id that does not exist", async () => {
    expect(await getSettledBubbleOrder(prisma, 999_999)).toBeNull();
  });
});

// F2: a payment bubble IS the chat's menu message (every caller passes
// `ctx.session.menuMsgId`), so a second checkout in the same chat re-renders
// the SAME Telegram message with new instructions. Whoever anchors a
// (chatId, messageId) pair last is the only order that message still shows —
// every earlier anchor on that pair is stale and must be dropped, or the
// sweeper flips a bubble that now carries somebody else's unpaid instructions.
describe("payment-message anchor reuse", () => {
  /** Create an order and point its anchor at (chatId, messageId). */
  async function makeAnchoredOrder(
    opts: { status?: string; chatId?: number; messageId?: number } = {},
  ) {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: opts.status ?? OrderStatus.PENDING_PAYMENT,
        paymentMethod: PaymentMethod.BINANCE_INTERNAL,
        paymentMsgChatId: BigInt(opts.chatId ?? 555),
        paymentMsgId: opts.messageId ?? 777,
      },
    });
    return order.id;
  }

  /** A bare order with no anchor yet — the "next checkout" in these tests. */
  async function makeUnanchoredOrder() {
    return (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!.id;
  }

  /** The (chatId, messageId) an order currently points at. */
  async function anchorOf(orderId: number) {
    const row = await prisma.order.findUnique({
      where: { id: orderId },
      select: { paymentMsgChatId: true, paymentMsgId: true },
    });
    return { chatId: row!.paymentMsgChatId, messageId: row!.paymentMsgId };
  }

  it("clears an older order's anchor when a newer order takes over the same message", async () => {
    const older = await makeAnchoredOrder({ chatId: 555, messageId: 777 });
    const newer = await makeUnanchoredOrder();

    await setOrderPaymentMessage(prisma, newer, 555, 777);

    expect(await anchorOf(older)).toEqual({ chatId: null, messageId: null });
    expect(await anchorOf(newer)).toEqual({ chatId: BigInt(555), messageId: 777 });
  });

  it("leaves an order anchored at a different message in the same chat alone", async () => {
    const other = await makeAnchoredOrder({ chatId: 555, messageId: 776 });
    const newer = await makeUnanchoredOrder();

    await setOrderPaymentMessage(prisma, newer, 555, 777);

    expect(await anchorOf(other)).toEqual({ chatId: BigInt(555), messageId: 776 });
  });

  it("leaves another chat's order alone even when its message id is identical", async () => {
    const otherChat = await makeAnchoredOrder({ chatId: 556, messageId: 777 });
    const newer = await makeUnanchoredOrder();

    await setOrderPaymentMessage(prisma, newer, 555, 777);

    expect(await anchorOf(otherChat)).toEqual({ chatId: BigInt(556), messageId: 777 });
  });

  it("re-anchoring the same order to the same message keeps that order's own anchor", async () => {
    const order = await makeAnchoredOrder({ chatId: 555, messageId: 777 });

    await setOrderPaymentMessage(prisma, order, 555, 777);

    expect(await anchorOf(order)).toEqual({ chatId: BigInt(555), messageId: 777 });
  });

  it.each([OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING, OrderStatus.CONFIRMED])(
    "clears even a Bybit BSC %s order's anchor when another order takes the message over",
    async (status) => {
      // The message now shows the NEW order's deposit address, so the tracked
      // order's claim on it is false whatever its status. Leaving it would let
      // the confirmation tracker edit that bubble every cycle, straight over
      // an unpaid deposit address — money lost. The accepted cost is the
      // tracked buyer's live tracking screen going quiet (My Orders still
      // works); see setOrderPaymentMessage's comment.
      const tracked = await makeAnchoredOrder({ status, chatId: 555, messageId: 777 });
      const newer = await makeUnanchoredOrder();

      await setOrderPaymentMessage(prisma, newer, 555, 777);

      expect(await anchorOf(tracked)).toEqual({ chatId: null, messageId: null });
      expect(await anchorOf(newer)).toEqual({ chatId: BigInt(555), messageId: 777 });
    },
  );

  it.each([OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING, OrderStatus.CONFIRMED])(
    "keeps a Bybit BSC %s order's anchor when the caller asks for keepOnChainTracked",
    async (status) => {
      // The navigate-away path (releasePaymentAnchorIfReused): nobody else
      // claimed the bubble, and the on-chain tracker will re-render it.
      const tracked = await makeAnchoredOrder({ status, chatId: 555, messageId: 777 });

      await clearPaymentMessageAnchorsAt(prisma, 555, 777, { keepOnChainTracked: true });

      expect(await anchorOf(tracked)).toEqual({ chatId: BigInt(555), messageId: 777 });
    },
  );

  it("clearPaymentMessageAnchorsAt drops every stale anchor on one message", async () => {
    const first = await makeAnchoredOrder({ chatId: 555, messageId: 777 });
    const second = await makeAnchoredOrder({ chatId: 555, messageId: 777 });
    const elsewhere = await makeAnchoredOrder({ chatId: 555, messageId: 778 });

    await clearPaymentMessageAnchorsAt(prisma, 555, 777);

    expect(await anchorOf(first)).toEqual({ chatId: null, messageId: null });
    expect(await anchorOf(second)).toEqual({ chatId: null, messageId: null });
    expect(await anchorOf(elsewhere)).toEqual({ chatId: BigInt(555), messageId: 778 });
  });

  it("clearPaymentMessageAnchorsAt leaves everything alone when nothing is anchored there", async () => {
    const anchored = await makeAnchoredOrder({ chatId: 555, messageId: 777 });

    await clearPaymentMessageAnchorsAt(prisma, 555, 999);

    expect(await anchorOf(anchored)).toEqual({ chatId: BigInt(555), messageId: 777 });
  });
});

describe("resolveBinanceInternalConfig — encrypted secrets (Task 13)", () => {
  it("decrypts binance_api_key and binance_api_secret when stored as encrypted envelopes", async () => {
    await setSetting(prisma, "binance_receive_uid", "db-uid");
    await setSetting(prisma, "binance_api_key", encryptCredentials("real-binance-apikey"));
    await setSetting(prisma, "binance_api_secret", encryptCredentials("real-binance-apisecret"));
    const cfg = await resolveBinanceInternalConfig(prisma);
    expect(cfg.apiKey).toBe("real-binance-apikey");
    expect(cfg.apiSecret).toBe("real-binance-apisecret");
  });
});
