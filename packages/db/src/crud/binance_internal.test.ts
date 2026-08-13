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
  recordUnmatchedTx,
  manualMatchTx,
  createCategory,
  createCatalogProduct,
  createDenomination,
  createWalletTopupOrder,
  upsertUser,
  listDeliveredOrdersAwaitingEdit,
  bulkAddStock,
} from "@app/db";
import { OrderStatus, OrderKind, PaymentMethod, NotificationEvent, DeliveryType, StockStatus } from "@app/core/enums";
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

// Task 15: an `unmatched` ledger row (a transfer that matched no PENDING
// order) must not permanently block the SAME Binance tx id from ever being
// delivered by a later, legitimate poller pass. Only the terminal outcomes
// ("matched" | "overpaid" | "stale") may stay unclaimable forever;
// "unmatched" and "delivery_failed" never delivered anything, so they must
// stay re-claimable.
describe("deliverPaidInternalOrder — re-claiming a tx id across non-delivering outcomes", () => {
  it("a tx first recorded as unmatched by the poller can still be delivered by a later poller pass", async () => {
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
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

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
    // NON_DELIVERING_OUTCOMES, so this trx id is correctly never reclaimable
    // either way.
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

  // Task 15 review, Important #1: widening the re-claim gate to "unmatched"
  // introduced a new failure mode this rail is uniquely exposed to (its
  // trxId matches by amount against ANY pending order, unlike the QRIS
  // rails' 1:1 binding). Sequence: a transfer is recorded "unmatched" in one
  // cycle; a later cycle matches it by amount to a DIFFERENT order that has
  // since left PENDING_PAYMENT (expired, or delivered another way). The
  // re-claim flips the row unmatched -> matched before the order-status
  // check runs, so without the fix the row is stranded "matched" pointing at
  // an order that received nothing — invisible to manualMatchTx and
  // dismissUnmatchedTx, both of which require outcome "unmatched". The fix
  // must revert the row to its pre-reclaim state so it stays manually
  // matchable.
  it("a re-claimed tx whose order turns out stale is reverted to unmatched, not stranded as matched", async () => {
    const binanceTxId = "tx-unmatched-then-stale-1";
    const recorded = await recordUnmatchedTx(prisma, { binanceTxId, amount: new Decimal("5") });
    expect(recorded).toBe(true);

    const staleOrder = await makePendingInternalOrder();
    await prisma.order.update({ where: { id: staleOrder.id }, data: { status: OrderStatus.CANCELLED } });

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: staleOrder.id,
      binanceTxId,
      amount: staleOrder.totalAmount,
    });
    expect(result.status).toBe("stale");

    const ledgerAfter = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId } });
    expect(ledgerAfter?.outcome).toBe("unmatched");
    expect(ledgerAfter?.orderId).toBeNull();

    // Still manually matchable: an admin's own recovery path must accept it.
    const manuallyMatchableOrder = await makePendingInternalOrder();
    await expect(
      manualMatchTx(prisma, { binanceTxId, orderId: manuallyMatchableOrder.id, adminId: 1 }),
    ).resolves.not.toThrow();
    const finalLedger = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId } });
    expect(finalLedger?.outcome).toBe("matched");
    expect(finalLedger?.orderId).toBe(manuallyMatchableOrder.id);
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

  // Anti-double-notify guarantee (Task 7): Binance Internal is a POLLER-ONLY
  // rail — deliverPaidInternalOrder only ever runs inside the bot process's
  // own internal-transfer poller, never a web request — so the buyer is DM'd
  // directly by that poller's onDelivered handler instead. Settlement here
  // must NOT also enqueue WALLET_TOPUP_CREDITED_DM to the outbox, or the
  // buyer would be notified twice.
  it("does NOT enqueue a WALLET_TOPUP_CREDITED_DM outbox row — the bot DMs the buyer directly for this poller-only rail", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");

    const result = await deliverPaidInternalOrder(prisma, { orderId: order.id, binanceTxId: "tx-topup-nodm-1", amount: order.totalAmount });
    expect(result.status).toBe("delivered");

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(rows).toHaveLength(0);
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

// Task 11 review follow-up, Minor #4: `listDeliveredOrdersAwaitingEdit`
// gained the same `limit`/`take`/`orderBy` shape as the three
// `listPending*Orders` functions (see e.g. crud/tokopay.test.ts's
// "listPendingTokopayOrders — the query-level cap returns the oldest rows
// first"), but only those three ever got a test pinning it. This mirrors
// that exact test for the one list function that was missed.
describe("listDeliveredOrdersAwaitingEdit — the query-level cap returns the oldest rows first", () => {
  it("returns exactly `limit` rows, and they are the `limit` oldest by createdAt", async () => {
    const extraCreds = Array.from({ length: 53 }, (_, i) => `awaiting-edit-cap-${i}`);
    await bulkAddStock(prisma, sample.product.id, extraCreds);

    const created: { id: number; createdAt: Date }[] = [];
    for (let i = 0; i < 53; i++) {
      const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
      // Stagger createdAt explicitly — a tight creation loop can tie at
      // whatever resolution SQLite/JS Date store, which would make "the 50
      // oldest" ambiguous and the assertion below vacuous.
      const createdAt = new Date(Date.now() - (53 - i) * 1000);
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.DELIVERED,
          paymentMethod: PaymentMethod.TOKOPAY,
          paymentMsgChatId: BigInt(555),
          paymentMsgId: 777,
          createdAt,
        },
      });
      created.push({ id: order.id, createdAt });
    }
    const oldest50Ids = [...created].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, 50).map((o) => o.id);

    const result = await listDeliveredOrdersAwaitingEdit(prisma, PaymentMethod.TOKOPAY, 50);

    expect(result).toHaveLength(50);
    expect(result.map((o) => o.id)).toEqual(oldest50Ids);
  });

  it("without a limit, returns every anchored DELIVERED order of that payment method", async () => {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.DELIVERED, paymentMethod: PaymentMethod.PAYDISINI, paymentMsgChatId: BigInt(1), paymentMsgId: 2 },
    });
    // A DELIVERED order of a DIFFERENT payment method must never show up.
    const otherMethodOrder = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({
      where: { id: otherMethodOrder.id },
      data: { status: OrderStatus.DELIVERED, paymentMethod: PaymentMethod.TOKOPAY, paymentMsgChatId: BigInt(1), paymentMsgId: 2 },
    });
    // A DELIVERED PAYDISINI order whose anchor was already cleared must never show up.
    const clearedOrder = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({
      where: { id: clearedOrder.id },
      data: { status: OrderStatus.DELIVERED, paymentMethod: PaymentMethod.PAYDISINI, paymentMsgChatId: null, paymentMsgId: null },
    });

    const result = await listDeliveredOrdersAwaitingEdit(prisma, PaymentMethod.PAYDISINI);

    expect(result.map((o) => o.id)).toEqual([order.id]);
  });
});
