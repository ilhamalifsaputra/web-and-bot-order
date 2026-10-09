import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { OrderKind, StockActorType } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import { cancelOrder, rejectOrder } from "./orders";
import {
  ordersByStatus,
  ordersByStatusSince,
  actionableManualMatchQueueCounts,
  actionableLedgerOutcomeCounts,
  ledgerOutcomeCountsForView,
  ledgerOutcomeCounts,
  countLedgerRowsToday,
  listCombinedLedger,
  recentOrders,
  reconcileFinances,
  orderHasIncomingLedgerPayment,
  consumeIncomingLedgerPayment,
  USDT_ROUNDING_CEIL_SINCE_KEY,
} from "./reports";
import { setSetting, __clearSettingsCacheForTests } from "./settings";

let db: TestDb;
let prisma: PrismaClient;
let userId: number;
let parentProductId: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  // Refunds (-> Order) and wallet movements (-> User) are both Restrict FKs,
  // written by the CANCELLED-resolution tests below.
  await prisma.refundExecution.deleteMany();
  await prisma.refundItem.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.walletTransaction.deleteMany();
  // cancelOrder records a status-history row (-> Order, Restrict).
  await prisma.orderStatusHistory.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.voucher.deleteMany();
  // StockItemEvent -> StockItem is onDelete:Restrict, so clear events and stock first.
  await prisma.stockItemEvent.deleteMany();
  await prisma.stockItem.deleteMany();
  await prisma.denomination.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
  await prisma.processedBinanceTx.deleteMany();
  await prisma.processedBybitTx.deleteMany();
  await prisma.processedTokopayTx.deleteMany();
  await prisma.processedPaydisiniTx.deleteMany();
  await prisma.processedNowpaymentsTx.deleteMany();
  await prisma.qrisUnderpaidTx.deleteMany();
  // D8 gave the legacy-rounding exemption a dated cutoff read from settings, so
  // a leftover row would silently decide a later test's outcome. The cache has
  // to go with the rows: `getSetting` holds a 30s per-client cache, and wiping
  // the table behind it leaves it serving values for rows that no longer exist.
  await prisma.setting.deleteMany();
  __clearSettingsCacheForTests(prisma);

  const user = await prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
  });
  userId = user.id;
  const category = await createCategory(prisma, `Cat-${Math.random()}`);
  const parentProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: `Prod-${Math.random()}`, description: "x" });
  parentProductId = parentProduct.id;
});

describe("ordersByStatusSince", () => {
  it("does not report voucher drift after rejection releases its use", async () => {
    const voucher = await prisma.voucher.create({ data: { code: "REJECTED", type: "PERCENT", value: "10", usedCount: 1 } });
    const order = await prisma.order.create({ data: { orderCode: "REJECTED-VOUCHER", userId, subtotalAmount: "100", totalAmount: "90", discountAmount: "10", voucherId: voucher.id, status: "PENDING_VERIFICATION" } });
    await prisma.$transaction((tx) => rejectOrder(tx, order.id, { adminId: userId, reason: "Invalid proof" }));
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).usedCount).toBe(0);
    expect((await reconcileFinances(prisma)).voucher_drift).toEqual([]);
  });
  it("only counts orders created since the cutoff", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 86_400_000 * 2);
    await prisma.order.create({
      data: { orderCode: `ORD-old-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", createdAt: old },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-new-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status: "PENDING_PAYMENT", createdAt: now },
    });

    const result = await ordersByStatusSince(prisma, new Date(now.getTime() - 60_000));
    expect(result).toEqual([{ status: "PENDING_PAYMENT", count: 1 }]);
  });

  // Task 6a (Financial Ledger M6). This funnel feeds the dashboard's "Orders
  // Today" card (GET /api/dashboard/kpis -> OrdersKpiCard), a sales-volume
  // metric — a buyer funding their wallet is not an order the shop sold, so a
  // settled WALLET_TOPUP must not inflate the "delivered" leg of the funnel.
  it("excludes WALLET_TOPUP orders from the funnel", async () => {
    const now = new Date();
    await prisma.order.create({
      data: { orderCode: `ORD-${Math.random()}`, userId, kind: OrderKind.PRODUCT, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", createdAt: now, deliveredAt: now },
    });
    await prisma.order.create({
      data: { orderCode: `TOPUP-${Math.random()}`, userId, kind: OrderKind.WALLET_TOPUP, subtotalAmount: "100000", totalAmount: "100000", status: "DELIVERED", createdAt: now, deliveredAt: now },
    });

    const result = await ordersByStatusSince(prisma, new Date(now.getTime() - 60_000));
    expect(result).toEqual([{ status: "DELIVERED", count: 1 }]);
  });
});

describe("orderHasIncomingLedgerPayment", () => {
  async function makeOrder() {
    return prisma.order.create({
      data: { orderCode: `ORD-${Math.random()}`, userId, subtotalAmount: "5", totalAmount: "5", status: "CANCELLED" },
    });
  }

  it("is false for an order no ledger row points at, even when rows exist for other orders or none", async () => {
    const order = await makeOrder();
    const other = await makeOrder();
    await prisma.processedTokopayTx.create({ data: { trxId: "TP-other", orderId: other.id, amount: "5", outcome: "matched" } });
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "BN-unlinked", amount: "5", outcome: "unmatched" } });
    expect(await orderHasIncomingLedgerPayment(prisma, order.id)).toBe(false);
  });

  it("is true when any one of the five gateway tables has a delivery_failed or unmatched row linked to the order", async () => {
    const linkers: Array<(orderId: number) => Promise<unknown>> = [
      (orderId) => prisma.processedBinanceTx.create({ data: { binanceTxId: `BN-${orderId}`, orderId, amount: "5", outcome: "unmatched" } }),
      (orderId) => prisma.processedBybitTx.create({ data: { bybitTxId: `BY-${orderId}`, orderId, amount: "5", outcome: "delivery_failed" } }),
      (orderId) => prisma.processedTokopayTx.create({ data: { trxId: `TP-${orderId}`, orderId, amount: "5", outcome: "delivery_failed" } }),
      (orderId) => prisma.processedPaydisiniTx.create({ data: { trxId: `PD-${orderId}`, orderId, amount: "5", outcome: "unmatched" } }),
      (orderId) => prisma.processedNowpaymentsTx.create({ data: { trxId: `NP-${orderId}`, orderId, amount: "5", outcome: "delivery_failed" } }),
    ];
    for (const link of linkers) {
      const order = await makeOrder();
      await link(order.id);
      expect(await orderHasIncomingLedgerPayment(prisma, order.id)).toBe(true);
    }
  });

  // Regression guard (re-review Critical): an `underpaid` row is linked to its
  // order too, but underpaid orders have their own resolution flows
  // (`creditUnderpaidTopupAnyway`, the underpaid cancel/refund routes). Counting
  // it here let the CANCELLED-order credit double-credit an underpaid top-up
  // already credited via `admin_adjust`, or credit the full total for an order
  // that only ever received part of it.
  it("is false when the only linked row is an underpaid one, on every rail that records one", async () => {
    const linkers: Array<(orderId: number) => Promise<unknown>> = [
      (orderId) => prisma.processedBinanceTx.create({ data: { binanceTxId: `BN-u-${orderId}`, orderId, amount: "3", outcome: "underpaid" } }),
      (orderId) => prisma.processedBybitTx.create({ data: { bybitTxId: `BY-u-${orderId}`, orderId, amount: "3", outcome: "underpaid" } }),
      // The QRIS/IDR gateways record their shortfall in qrisUnderpaidTx (see
      // _underpaid.ts), never in a processed*Tx table.
      (orderId) => prisma.qrisUnderpaidTx.create({ data: { orderId, gateway: "TokoPay", receivedAmount: "3", expectedAmount: "5" } }),
    ];
    for (const link of linkers) {
      const order = await makeOrder();
      await link(order.id);
      expect(await orderHasIncomingLedgerPayment(prisma, order.id)).toBe(false);
    }
  });

  // Only the two outcomes this admin action exists to close out count as proof;
  // every other outcome has its own resolution path (or none is owed).
  it("is false when the only linked rows carry a non-actionable outcome", async () => {
    for (const outcome of ["matched", "stale", "dismissed", "credited_to_balance", "underpaid"]) {
      const order = await makeOrder();
      const id = order.id;
      await prisma.processedBinanceTx.create({ data: { binanceTxId: `BN-${outcome}-${id}`, orderId: id, amount: "5", outcome } });
      await prisma.processedBybitTx.create({ data: { bybitTxId: `BY-${outcome}-${id}`, orderId: id, amount: "5", outcome } });
      await prisma.processedTokopayTx.create({ data: { trxId: `TP-${outcome}-${id}`, orderId: id, amount: "5", outcome } });
      await prisma.processedPaydisiniTx.create({ data: { trxId: `PD-${outcome}-${id}`, orderId: id, amount: "5", outcome } });
      await prisma.processedNowpaymentsTx.create({ data: { trxId: `NP-${outcome}-${id}`, orderId: id, amount: "5", outcome } });
      expect(await orderHasIncomingLedgerPayment(prisma, id), outcome).toBe(false);
    }
  });
});

// Sibling of ordersByStatusSince above, with no time bound — its one caller is
// the Reports page's order funnel (GET /api/reports), alongside revenueByDay
// and topProducts, so it is a sales report too and gets the same filter.
describe("ordersByStatus", () => {
  it("excludes WALLET_TOPUP orders from the funnel", async () => {
    const now = new Date();
    await prisma.order.create({
      data: { orderCode: `ORD-${Math.random()}`, userId, kind: OrderKind.PRODUCT, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", deliveredAt: now },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-p-${Math.random()}`, userId, kind: OrderKind.PRODUCT, subtotalAmount: "1", totalAmount: "1", status: "PENDING_PAYMENT" },
    });
    await prisma.order.create({
      data: { orderCode: `TOPUP-${Math.random()}`, userId, kind: OrderKind.WALLET_TOPUP, subtotalAmount: "100000", totalAmount: "100000", status: "DELIVERED", deliveredAt: now },
    });

    // Order-insensitive: two buckets tied at count 1 have no defined order.
    const result = await ordersByStatus(prisma);
    expect([...result].sort((a, b) => a.status.localeCompare(b.status))).toEqual([
      { status: "DELIVERED", count: 1 },
      { status: "PENDING_PAYMENT", count: 1 },
    ]);
  });
});

// The dashboard's "Pending actions" card: a delivery_failed/unmatched ledger
// row stays in its table forever, even after an admin fulfils the order by
// hand, refunds it or cancels it. Counting every such row made the card claim
// work that was already done. Only rows whose order is still open (or that
// have no order at all) are actionable.
describe("actionableManualMatchQueueCounts", () => {
  async function order(status: string) {
    return prisma.order.create({
      data: { orderCode: `ORD-${status}-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status },
    });
  }

  it("excludes delivery_failed rows whose order is DELIVERED or REFUNDED, across gateway tables", async () => {
    const delivered = await order("DELIVERED");
    const refunded = await order("REFUNDED");
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-delivered", amount: "1", outcome: "delivery_failed", orderId: delivered.id } });
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-refunded", amount: "1", outcome: "delivery_failed", orderId: refunded.id } });

    expect(await actionableManualMatchQueueCounts(prisma)).toEqual({ unmatched: 0, deliveryFailed: 0 });
    // The raw lifetime tally the Payments tiles read is unchanged.
    expect(await ledgerOutcomeCounts(prisma)).toEqual({ delivery_failed: 2 });
  });

  // Money safety: a gateway settle whose delivery throws only rewrites the
  // ledger row to `delivery_failed` — the order stays PENDING_PAYMENT with no
  // `paidAt`, so the expiry sweep (or the buyer) can then cancel it. The buyer
  // paid and got nothing; CANCELLED alone must never hide that row.
  describe("CANCELLED orders count as resolved only with proof the money went back", () => {
    it("still counts a delivery_failed row whose order the expiry sweep cancelled with no credit or refund", async () => {
      const pending = await order("PENDING_PAYMENT");
      await prisma.processedTokopayTx.create({ data: { trxId: "tp-expired", amount: "1", outcome: "delivery_failed", orderId: pending.id } });
      await cancelOrder(prisma, pending.id, "expired", { type: StockActorType.SYSTEM });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("CANCELLED");

      expect(await actionableManualMatchQueueCounts(prisma)).toEqual({ unmatched: 0, deliveryFailed: 1 });
      const list = await listCombinedLedger(prisma, { outcome: "delivery_failed", actionable: true });
      expect(list.rows.map((r) => r.reference)).toEqual(["tp-expired"]);
      expect(list.total).toBe(1);
    });

    it("drops a cancelled order's row once an unfulfilled_credit wallet movement exists for it", async () => {
      const cancelled = await order("CANCELLED");
      await prisma.processedNowpaymentsTx.create({ data: { trxId: "np-credited", amount: "1", outcome: "delivery_failed", orderId: cancelled.id } });
      await prisma.walletTransaction.create({
        data: { userId, delta: "1", balanceAfter: "1", reason: "unfulfilled_credit", orderId: cancelled.id },
      });

      expect(await actionableManualMatchQueueCounts(prisma)).toEqual({ unmatched: 0, deliveryFailed: 0 });
      expect((await listCombinedLedger(prisma, { outcome: "delivery_failed", actionable: true })).total).toBe(0);
    });

    it("drops a cancelled order's row once a COMPLETED refund exists for it", async () => {
      const cancelled = await order("CANCELLED");
      await prisma.processedBybitTx.create({ data: { bybitTxId: "by-refunded", amount: "1", outcome: "unmatched", orderId: cancelled.id } });
      await prisma.refund.create({ data: { orderId: cancelled.id, amount: "1", currency: "IDR", status: "COMPLETED" } });

      expect(await actionableManualMatchQueueCounts(prisma)).toEqual({ unmatched: 0, deliveryFailed: 0 });
      expect((await listCombinedLedger(prisma, { outcome: "unmatched", actionable: true })).total).toBe(0);
    });

    it("still counts a cancelled order whose only evidence is a refund not yet paid out, or a non-credit wallet movement", async () => {
      const pendingRefund = await order("CANCELLED");
      const walletUsedBack = await order("CANCELLED");
      await prisma.processedTokopayTx.create({ data: { trxId: "tp-pending-refund", amount: "1", outcome: "delivery_failed", orderId: pendingRefund.id } });
      await prisma.processedTokopayTx.create({ data: { trxId: "tp-order-refund", amount: "1", outcome: "delivery_failed", orderId: walletUsedBack.id } });
      await prisma.refund.create({ data: { orderId: pendingRefund.id, amount: "1", currency: "IDR", status: "PENDING" } });
      // `order_refund` is only the wallet portion `releaseOrderHolds` hands back
      // on any cancel — not the external payment this row recorded.
      await prisma.walletTransaction.create({
        data: { userId, delta: "1", balanceAfter: "1", reason: "order_refund", orderId: walletUsedBack.id },
      });

      expect(await actionableManualMatchQueueCounts(prisma)).toEqual({ unmatched: 0, deliveryFailed: 2 });
    });

    it("still counts a row whose order was REJECTED", async () => {
      const rejected = await order("REJECTED");
      await prisma.processedPaydisiniTx.create({ data: { trxId: "pd-rejected", amount: "1", outcome: "delivery_failed", orderId: rejected.id } });

      expect(await actionableManualMatchQueueCounts(prisma)).toEqual({ unmatched: 0, deliveryFailed: 1 });
      expect((await listCombinedLedger(prisma, { outcome: "delivery_failed", actionable: true })).total).toBe(1);
    });
  });

  it("includes delivery_failed rows whose order is still open", async () => {
    const processing = await order("PROCESSING");
    const paid = await order("PAID");
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-open", amount: "1", outcome: "delivery_failed", orderId: processing.id } });
    await prisma.processedPaydisiniTx.create({ data: { trxId: "pd-open", amount: "1", outcome: "delivery_failed", orderId: paid.id } });

    expect(await actionableManualMatchQueueCounts(prisma)).toEqual({ unmatched: 0, deliveryFailed: 2 });
  });

  it("includes unmatched rows with no order, and rows pointing at an order that no longer exists", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-unmatched", amount: "1", outcome: "unmatched" } });
    await prisma.processedBybitTx.create({ data: { bybitTxId: "by-unmatched", amount: "1", outcome: "unmatched" } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-ghost", amount: "1", outcome: "delivery_failed", orderId: 987654321 } });
    // A resolved unmatched row (admin matched it and the order got delivered) is not.
    const delivered = await order("DELIVERED");
    await prisma.processedBybitTx.create({ data: { bybitTxId: "by-matched-later", amount: "1", outcome: "unmatched", orderId: delivered.id } });
    // Other outcomes never count, whatever their order says.
    const processing = await order("PROCESSING");
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-matched", amount: "1", outcome: "matched", orderId: processing.id } });

    expect(await actionableManualMatchQueueCounts(prisma)).toEqual({ unmatched: 2, deliveryFailed: 1 });
  });

  it("agrees with listCombinedLedger's actionable filter for the same outcome", async () => {
    const delivered = await order("DELIVERED");
    const processing = await order("PROCESSING");
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-a", amount: "1", outcome: "delivery_failed", orderId: delivered.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-b", amount: "1", outcome: "delivery_failed", orderId: processing.id } });
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-c", amount: "1", outcome: "delivery_failed" } });
    await prisma.processedBybitTx.create({ data: { bybitTxId: "by-d", amount: "1", outcome: "unmatched" } });
    await prisma.processedBybitTx.create({ data: { bybitTxId: "by-e", amount: "1", outcome: "unmatched", orderId: delivered.id } });

    const counts = await actionableManualMatchQueueCounts(prisma);
    const failed = await listCombinedLedger(prisma, { outcome: "delivery_failed", actionable: true });
    const unmatched = await listCombinedLedger(prisma, { outcome: "unmatched", actionable: true });
    expect(failed.total).toBe(counts.deliveryFailed);
    expect(failed.rows.map((r) => r.reference).sort()).toEqual(["bn-c", "tp-b"]);
    expect(unmatched.total).toBe(counts.unmatched);
    expect(unmatched.rows.map((r) => r.reference)).toEqual(["by-d"]);

    // Without the flag the list is unchanged: every delivery_failed row.
    expect((await listCombinedLedger(prisma, { outcome: "delivery_failed" })).total).toBe(3);
  });

  it("has no effect on the list when the outcome filter is not one of the actionable outcomes", async () => {
    const delivered = await order("DELIVERED");
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-m", amount: "1", outcome: "matched", orderId: delivered.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-f", amount: "1", outcome: "delivery_failed", orderId: delivered.id } });

    for (const outcome of ["matched", null] as const) {
      const off = await listCombinedLedger(prisma, { outcome });
      const on = await listCombinedLedger(prisma, { outcome, actionable: true });
      expect(on.total).toBe(off.total);
      expect(on.rows.map((r) => r.reference)).toEqual(off.rows.map((r) => r.reference));
    }
  });
});

describe("actionableLedgerOutcomeCounts", () => {
  async function order(status: string) {
    return prisma.order.create({
      data: { orderCode: `ORD-${status}-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status },
    });
  }

  it("applies the actionable rule to every outcome when called without onlyOutcomes", async () => {
    const delivered = await order("DELIVERED");
    const processing = await order("PROCESSING");
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-1", amount: "1", outcome: "matched", orderId: delivered.id } });
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-2", amount: "1", outcome: "matched", orderId: processing.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-1", amount: "1", outcome: "delivery_failed", orderId: delivered.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-2", amount: "1", outcome: "unmatched" } });

    expect(await actionableLedgerOutcomeCounts(prisma)).toEqual({ matched: 1, unmatched: 1 });
  });

  it("reads only the requested outcomes when given onlyOutcomes", async () => {
    const processing = await order("PROCESSING");
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-1", amount: "1", outcome: "matched", orderId: processing.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-1", amount: "1", outcome: "delivery_failed", orderId: processing.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-2", amount: "1", outcome: "unmatched" } });

    expect(await actionableLedgerOutcomeCounts(prisma, ["delivery_failed"])).toEqual({ delivery_failed: 1 });
  });
});

describe("ledgerOutcomeCountsForView", () => {
  it("replaces only the unmatched/delivery_failed counts with their actionable figures when actionable is on", async () => {
    const delivered = await prisma.order.create({
      data: { orderCode: `ORD-D-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED" },
    });
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-1", amount: "1", outcome: "matched", orderId: delivered.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-1", amount: "1", outcome: "delivery_failed", orderId: delivered.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-2", amount: "1", outcome: "unmatched", orderId: delivered.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-3", amount: "1", outcome: "unmatched" } });

    expect(await ledgerOutcomeCountsForView(prisma, false)).toEqual({ matched: 1, delivery_failed: 1, unmatched: 2 });
    // matched keeps its lifetime count; a fully resolved outcome reads 0, not
    // its lifetime figure.
    expect(await ledgerOutcomeCountsForView(prisma, true)).toEqual({ matched: 1, delivery_failed: 0, unmatched: 1 });
  });
});

describe("ledgerOutcomeCounts", () => {
  it("counts rows per outcome across all five gateway tables, including failed rows that are not on Binance", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: `bn-${Math.random()}`, amount: "1", outcome: "matched" } });
    await prisma.processedBybitTx.create({ data: { bybitTxId: `by-${Math.random()}`, amount: "1", outcome: "unmatched" } });
    await prisma.processedTokopayTx.create({ data: { trxId: `tp-${Math.random()}`, amount: "1", outcome: "delivery_failed" } });
    await prisma.processedTokopayTx.create({ data: { trxId: `tp-${Math.random()}`, amount: "1", outcome: "delivery_failed" } });
    await prisma.processedPaydisiniTx.create({ data: { trxId: `pd-${Math.random()}`, amount: "1", outcome: "unmatched" } });
    await prisma.processedNowpaymentsTx.create({ data: { trxId: `np-${Math.random()}`, amount: "1", outcome: "delivery_failed" } });
    await prisma.processedNowpaymentsTx.create({ data: { trxId: `np-${Math.random()}`, amount: "1", outcome: "matched" } });

    expect(await ledgerOutcomeCounts(prisma)).toEqual({ matched: 2, unmatched: 2, delivery_failed: 3 });
  });

  it("is empty when no gateway has recorded anything", async () => {
    expect(await ledgerOutcomeCounts(prisma)).toEqual({});
  });
});

describe("countLedgerRowsToday", () => {
  const now = new Date("2026-06-15T06:00:00.000Z");
  const twoDaysAgo = new Date("2026-06-13T06:00:00.000Z");

  it("counts today's rows of every outcome across all five gateway tables and skips earlier days", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-today", amount: "1", outcome: "matched", createdAt: now } });
    await prisma.processedBybitTx.create({ data: { bybitTxId: "by-today", amount: "1", outcome: "unmatched", createdAt: now } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-today", amount: "1", outcome: "delivery_failed", createdAt: now } });
    await prisma.processedPaydisiniTx.create({ data: { trxId: "pd-today", amount: "1", outcome: "matched", createdAt: now } });
    await prisma.processedNowpaymentsTx.create({ data: { trxId: "np-today", amount: "1", outcome: "dismissed", createdAt: now } });
    // Older rows, one per table, must not count.
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-old", amount: "1", outcome: "matched", createdAt: twoDaysAgo } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-old", amount: "1", outcome: "delivery_failed", createdAt: twoDaysAgo } });
    await prisma.processedNowpaymentsTx.create({ data: { trxId: "np-old", amount: "1", outcome: "matched", createdAt: twoDaysAgo } });

    expect(await countLedgerRowsToday(prisma, now)).toBe(5);
  });

  it("counts a day that only non-Binance gateways have rows on", async () => {
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-only", amount: "1", outcome: "matched", createdAt: now } });
    expect(await countLedgerRowsToday(prisma, now)).toBe(1);
  });
});

describe("listCombinedLedger", () => {
  it("normalizes rows from all five gateway tables into one shape, tagged with their gateway", async () => {
    const binance = await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-1", amount: "1.5", outcome: "unmatched" } });
    const tokopay = await prisma.processedTokopayTx.create({ data: { trxId: "tp-1", amount: "50000", outcome: "delivery_failed" } });

    const { rows, total } = await listCombinedLedger(prisma);
    expect(rows).toHaveLength(2);
    expect(total).toBe(2);

    const binanceRow = rows.find((r) => r.reference === "bn-1");
    expect(binanceRow).toMatchObject({ id: binance.id, gateway: "binance", reference: "bn-1", amount: "1.5", outcome: "unmatched", orderId: null });

    const tokopayRow = rows.find((r) => r.reference === "tp-1");
    expect(tokopayRow).toMatchObject({ id: tokopay.id, gateway: "tokopay", reference: "tp-1", amount: "50000", outcome: "delivery_failed", orderId: null });
  });

  it("sorts merged rows by createdAt descending across gateways", async () => {
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-06-01T00:00:00.000Z");
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-old", amount: "1", outcome: "matched", createdAt: older } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-new", amount: "1", outcome: "matched", createdAt: newer } });

    const { rows } = await listCombinedLedger(prisma);
    expect(rows.map((r) => r.reference)).toEqual(["tp-new", "bn-old"]);
  });

  it("filters by outcome across gateways — the regression this task fixes: a non-Binance delivery_failed row used to be structurally invisible", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-fail", amount: "1", outcome: "delivery_failed" } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-fail", amount: "1", outcome: "delivery_failed" } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-ok", amount: "1", outcome: "matched" } });

    const { rows, total } = await listCombinedLedger(prisma, { outcome: "delivery_failed" });
    expect(rows.map((r) => r.reference).sort()).toEqual(["bn-fail", "tp-fail"]);
    expect(total).toBe(2);
  });

  it("paginates the merged, sorted set in memory", async () => {
    for (let i = 0; i < 3; i++) {
      await prisma.processedBinanceTx.create({ data: { binanceTxId: `bn-${i}`, amount: "1", outcome: "unmatched", createdAt: new Date(2026, 0, i + 1) } });
    }
    const page1 = await listCombinedLedger(prisma, { limit: 2, offset: 0 });
    const page2 = await listCombinedLedger(prisma, { limit: 2, offset: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(1);
    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);
    expect(page1.rows.map((r) => r.reference)).toEqual(["bn-2", "bn-1"]);
    expect(page2.rows.map((r) => r.reference)).toEqual(["bn-0"]);
  });
});

/**
 * Wraps a real PrismaClient so `order.findMany` calls can be counted without
 * mutating (and having to restore) the shared client — the N+1 guard below
 * needs a call count, not a stub, so every call still hits the real database.
 */
function countingDb(client: PrismaClient, counter: { orderFindMany: number }): PrismaClient {
  const wrapDelegate = (delegate: Record<string, unknown>) =>
    new Proxy(delegate, {
      get(target, prop) {
        const value = target[prop as string];
        if (prop === "findMany" && typeof value === "function") {
          return (...args: unknown[]) => {
            counter.orderFindMany += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(client, {
    get(target, prop) {
      const value = (target as unknown as Record<string, unknown>)[prop as string];
      if (prop === "order") return wrapDelegate(value as Record<string, unknown>);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

describe("listCombinedLedger order enrichment (top-ups vs product sales)", () => {
  it("carries the order's code and kind onto every ledger row that has an orderId", async () => {
    const sale = await prisma.order.create({
      data: { orderCode: "ORD-SALE-1", userId, subtotalAmount: "1", totalAmount: "50000", status: "DELIVERED", kind: "PRODUCT" },
    });
    const topup = await prisma.order.create({
      data: { orderCode: "ORD-TOPUP-1", userId, subtotalAmount: "1", totalAmount: "100000", status: "DELIVERED", kind: "WALLET_TOPUP" },
    });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-sale", amount: "50000", outcome: "matched", orderId: sale.id } });
    await prisma.processedPaydisiniTx.create({ data: { trxId: "pd-topup", amount: "100000", outcome: "matched", orderId: topup.id } });

    const { rows } = await listCombinedLedger(prisma);
    expect(rows.find((r) => r.reference === "tp-sale")).toMatchObject({ orderCode: "ORD-SALE-1", orderKind: "PRODUCT" });
    expect(rows.find((r) => r.reference === "pd-topup")).toMatchObject({ orderCode: "ORD-TOPUP-1", orderKind: "WALLET_TOPUP" });
  });

  it("keeps rows whose orderId is null, with null code and kind", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-orphan", amount: "1", outcome: "unmatched" } });

    const { rows, total } = await listCombinedLedger(prisma);
    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reference: "bn-orphan", orderId: null, orderCode: null, orderKind: null });
  });

  it("enriches the whole merged set with ONE order query, not one per row", async () => {
    for (let i = 0; i < 8; i++) {
      const order = await prisma.order.create({
        data: { orderCode: `ORD-N1-${i}`, userId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", kind: "PRODUCT" },
      });
      await prisma.processedTokopayTx.create({ data: { trxId: `tp-n1-${i}`, amount: "1", outcome: "matched", orderId: order.id } });
    }

    const counter = { orderFindMany: 0 };
    const { rows } = await listCombinedLedger(countingDb(prisma, counter), { limit: 50 });
    expect(rows).toHaveLength(8);
    expect(counter.orderFindMany).toBe(1);
  });

  it("filters by order kind consistently across page boundaries — total matches the rows the filter really yields", async () => {
    // 3 top-ups and 5 product sales, interleaved by createdAt so a page of 2
    // can never accidentally hold only one kind.
    const references: string[] = [];
    for (let i = 0; i < 8; i++) {
      const kind = i % 3 === 0 ? "WALLET_TOPUP" : "PRODUCT";
      const order = await prisma.order.create({
        data: { orderCode: `ORD-MIX-${i}`, userId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", kind },
      });
      const reference = `tp-mix-${i}`;
      references.push(reference);
      await prisma.processedTokopayTx.create({
        data: { trxId: reference, amount: "1", outcome: "matched", orderId: order.id, createdAt: new Date(2026, 0, i + 1) },
      });
    }
    // A ledger row with no order at all must not be counted as either kind.
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-mix-orphan", amount: "1", outcome: "unmatched" } });

    const first = await listCombinedLedger(prisma, { kind: "WALLET_TOPUP", limit: 2, offset: 0 });
    expect(first.total).toBe(3);
    expect(first.rows).toHaveLength(2);

    const second = await listCombinedLedger(prisma, { kind: "WALLET_TOPUP", limit: 2, offset: 2 });
    expect(second.total).toBe(3);
    expect(second.rows).toHaveLength(1);

    const paged = [...first.rows, ...second.rows];
    expect(paged).toHaveLength(first.total);
    expect(paged.every((r) => r.orderKind === "WALLET_TOPUP")).toBe(true);
    expect(paged.map((r) => r.reference).sort()).toEqual(["tp-mix-0", "tp-mix-3", "tp-mix-6"]);

    // A third page past the end stays consistent rather than wrapping around.
    const third = await listCombinedLedger(prisma, { kind: "WALLET_TOPUP", limit: 2, offset: 4 });
    expect(third.total).toBe(3);
    expect(third.rows).toHaveLength(0);

    // And the complementary filter accounts for the rest — the orphan row
    // belongs to neither kind.
    const sales = await listCombinedLedger(prisma, { kind: "PRODUCT", limit: 50 });
    expect(sales.total).toBe(5);
    expect(sales.rows).toHaveLength(5);

    const unfiltered = await listCombinedLedger(prisma, { limit: 50 });
    expect(unfiltered.total).toBe(references.length + 1);
  });
});

describe("listCombinedLedger currency and suggested order", () => {
  it("stamps each row with its gateway's currency", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-cur", amount: "1.5", outcome: "unmatched" } });
    await prisma.processedBybitTx.create({ data: { bybitTxId: "by-cur", amount: "2", outcome: "unmatched" } });
    await prisma.processedNowpaymentsTx.create({ data: { trxId: "np-cur", amount: "3", outcome: "unmatched" } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-cur", amount: "50000", outcome: "unmatched" } });
    await prisma.processedPaydisiniTx.create({ data: { trxId: "pd-cur", amount: "60000", outcome: "unmatched" } });

    const { rows } = await listCombinedLedger(prisma);
    const currencyByReference = Object.fromEntries(rows.map((r) => [r.reference, r.currency]));
    expect(currencyByReference).toEqual({
      "bn-cur": "USDT",
      "by-cur": "USDT",
      "np-cur": "USDT",
      "tp-cur": "IDR",
      "pd-cur": "IDR",
    });
  });

  it("returns the suggested order's id, code and kind on an unmatched row that carries a hint, leaving orderId null", async () => {
    const topup = await prisma.order.create({
      data: { orderCode: "ORD-HINT-1", userId, subtotalAmount: "1", totalAmount: "100000", status: "UNDERPAID", kind: "WALLET_TOPUP" },
    });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-hint", amount: "40000", outcome: "unmatched", suggestedOrderId: topup.id } });
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-nohint", amount: "1", outcome: "unmatched" } });
    // A hint pointing at an order that no longer exists keeps the id but no code/kind.
    await prisma.processedPaydisiniTx.create({ data: { trxId: "pd-ghost-hint", amount: "1", outcome: "unmatched", suggestedOrderId: 987654321 } });

    const { rows } = await listCombinedLedger(prisma);
    expect(rows.find((r) => r.reference === "tp-hint")).toMatchObject({
      orderId: null,
      orderCode: null,
      orderKind: null,
      orderStatus: null,
      suggestedOrderId: topup.id,
      suggestedOrderCode: "ORD-HINT-1",
      suggestedOrderKind: "WALLET_TOPUP",
    });
    expect(rows.find((r) => r.reference === "bn-nohint")).toMatchObject({
      suggestedOrderId: null,
      suggestedOrderCode: null,
      suggestedOrderKind: null,
    });
    expect(rows.find((r) => r.reference === "pd-ghost-hint")).toMatchObject({
      suggestedOrderId: 987654321,
      suggestedOrderCode: null,
      suggestedOrderKind: null,
    });
  });

  it("resolves linked and suggested orders in the same single order query", async () => {
    const sale = await prisma.order.create({
      data: { orderCode: "ORD-ONEQ-1", userId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", kind: "PRODUCT" },
    });
    const hinted = await prisma.order.create({
      data: { orderCode: "ORD-ONEQ-2", userId, subtotalAmount: "1", totalAmount: "1", status: "UNDERPAID", kind: "PRODUCT" },
    });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-oneq-a", amount: "1", outcome: "matched", orderId: sale.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-oneq-b", amount: "0", outcome: "unmatched", suggestedOrderId: hinted.id } });

    const counter = { orderFindMany: 0 };
    const { rows } = await listCombinedLedger(countingDb(prisma, counter), { limit: 50 });
    expect(counter.orderFindMany).toBe(1);
    expect(rows.find((r) => r.reference === "tp-oneq-b")).toMatchObject({ suggestedOrderCode: "ORD-ONEQ-2" });
  });

  it("filters by kind using the suggested order's kind when the row has no linked order", async () => {
    const topup = await prisma.order.create({
      data: { orderCode: "ORD-KIND-HINT", userId, subtotalAmount: "1", totalAmount: "100000", status: "UNDERPAID", kind: "WALLET_TOPUP" },
    });
    const sale = await prisma.order.create({
      data: { orderCode: "ORD-KIND-SALE", userId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", kind: "PRODUCT" },
    });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-kind-hint", amount: "1", outcome: "unmatched", suggestedOrderId: topup.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-kind-sale", amount: "1", outcome: "matched", orderId: sale.id } });
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-kind-orphan", amount: "1", outcome: "unmatched" } });

    const topups = await listCombinedLedger(prisma, { kind: "WALLET_TOPUP" });
    expect(topups.rows.map((r) => r.reference)).toEqual(["tp-kind-hint"]);
    expect(topups.total).toBe(1);
    const sales = await listCombinedLedger(prisma, { kind: "PRODUCT" });
    expect(sales.rows.map((r) => r.reference)).toEqual(["tp-kind-sale"]);
  });

  it("keeps the actionable filter on orderId only — a hint at a DELIVERED order does not hide the row", async () => {
    const delivered = await prisma.order.create({
      data: { orderCode: "ORD-ACT-HINT", userId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", kind: "PRODUCT" },
    });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-act-hint", amount: "1", outcome: "unmatched", suggestedOrderId: delivered.id } });

    const list = await listCombinedLedger(prisma, { outcome: "unmatched", actionable: true });
    expect(list.rows.map((r) => r.reference)).toEqual(["tp-act-hint"]);
    expect(await actionableManualMatchQueueCounts(prisma)).toEqual({ unmatched: 1, deliveryFailed: 0 });
  });
});

// Money guard rail: `suggestedOrderId` is a display hint only. An unmatched row
// that merely suggests an order (a short or unverified payment) must never be
// read as proof the order was paid in full, or an admin could credit the whole
// order total to the buyer's balance off a partial payment.
describe("suggestedOrderId is never payment evidence", () => {
  it("a short-paid unmatched TokoPay row with only suggestedOrderId set proves nothing and is not consumed", async () => {
    const order = await prisma.order.create({
      data: { orderCode: "ORD-SHORT-HINT", userId, subtotalAmount: "100000", totalAmount: "100000", status: "CANCELLED", kind: "PRODUCT" },
    });
    await prisma.processedTokopayTx.create({
      data: { trxId: "tp-short-hint", amount: "40000", outcome: "unmatched", suggestedOrderId: order.id },
    });

    expect(await orderHasIncomingLedgerPayment(prisma, order.id)).toBe(false);
    expect(await prisma.$transaction((tx) => consumeIncomingLedgerPayment(tx, order.id))).toBe(0);
    const row = await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "tp-short-hint" } });
    expect(row.outcome).toBe("unmatched");
    expect(row.orderId).toBeNull();
  });
});

describe("recentOrders", () => {
  it("returns newest first, with the first item's product name and an overflow count when there are more", async () => {
    const now = new Date();
    const productA = await createDenomination(prisma, { productId: parentProductId, name: "Product A", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const productB = await createDenomination(prisma, { productId: parentProductId, name: "Product B", type: "SHARED", durationLabel: "1 Month", price: "10000" });

    const order1 = await prisma.order.create({ data: { orderCode: "ORD-1", userId, subtotalAmount: "1", totalAmount: "10000", currency: "IDR", status: "DELIVERED", createdAt: new Date(now.getTime() - 60_000) } });
    await prisma.orderItem.create({ data: { orderId: order1.id, productId: productA.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });
    await prisma.orderItem.create({ data: { orderId: order1.id, productId: productB.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const order2 = await prisma.order.create({ data: { orderCode: "ORD-2", userId, subtotalAmount: "1", totalAmount: "5000", currency: "IDR", status: "PENDING_PAYMENT", createdAt: now } });
    await prisma.orderItem.create({ data: { orderId: order2.id, productId: productA.id, quantity: 1, unitPrice: "5000", warrantyDaysSnapshot: 30 } });

    const result = await recentOrders(prisma, 10);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ orderId: order2.id, orderCode: "ORD-2", productLabel: "Product A", amount: "5000", currency: "IDR", status: "PENDING_PAYMENT" });
    expect(result[1]).toMatchObject({ orderId: order1.id, orderCode: "ORD-1", productLabel: "Product A +1 more", amount: "10000" });
  });

  it("falls back to a Telegram-id label when the user has no username", async () => {
    const product = await createDenomination(prisma, { productId: parentProductId, name: "Solo product", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const order = await prisma.order.create({ data: { orderCode: "ORD-solo", userId, subtotalAmount: "1", totalAmount: "10000", currency: "IDR", status: "DELIVERED" } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const result = await recentOrders(prisma, 10);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(result[0]!.customerLabel).toBe(`Telegram ${user.telegramId}`);
  });
});

describe("reconcileFinances", () => {
  it("excludes WALLET_TOPUP orders from order_drift check", async () => {
    // Create a WALLET_TOPUP order with a mismatch that would show drift
    // if the PRODUCT-only formula were applied
    await prisma.order.create({
      data: {
        orderCode: "ORD-TOPUP-DRIFT",
        userId,
        subtotalAmount: "100000",
        totalAmount: "50000",
        currency: "IDR",
        status: "DELIVERED",
        kind: "WALLET_TOPUP",
      },
    });

    const findings = await reconcileFinances(prisma);

    // The WALLET_TOPUP order should NOT appear in order_drift
    expect(findings.order_drift).toHaveLength(0);
  });

  it("still detects drift in PRODUCT orders", async () => {
    // Create a PRODUCT order with a mismatch
    await prisma.order.create({
      data: {
        orderCode: "ORD-PRODUCT-DRIFT",
        userId,
        subtotalAmount: "100000",
        totalAmount: "50000",
        currency: "IDR",
        status: "DELIVERED",
        kind: "PRODUCT",
      },
    });

    const findings = await reconcileFinances(prisma);

    // The PRODUCT order should appear in order_drift
    expect(findings.order_drift).toHaveLength(1);
    expect(findings.order_drift[0]).toMatchObject({
      order_code: "ORD-PRODUCT-DRIFT",
    });
  });

  // M13 / P2-1. `usdtFromIdr`'s step moved from 0.1 half-up to 0.01 ceil, and
  // this check re-derives what a USDT order's total SHOULD be. Every order
  // finalized before that change carries a total rounded the old way, so a
  // naive re-derivation reports the whole USDT history as drift — a
  // reconciliation report that cries wolf on every past order is worse than no
  // report, because it is the one an admin stops reading.
  it("does not report a USDT order priced under the previous rounding policy as drift", async () => {
    // The exemption is now dated (D8), so this order has to be on the historical
    // side of the cutoff for it to apply at all.
    await setSetting(prisma, USDT_ROUNDING_CEIL_SINCE_KEY, new Date().toISOString());
    // Rp44.500 at 16.000: 2.78125 → 2.8 under the old rule, 2.79 under the new.
    await prisma.order.create({
      data: {
        orderCode: "ORD-USDT-OLD-ROUNDING",
        userId,
        subtotalAmount: "44500",
        totalAmount: "2.8",
        currency: "USDT",
        fxRate: "16000",
        status: "DELIVERED",
        kind: "PRODUCT",
        createdAt: new Date(Date.now() - 86_400_000),
      },
    });

    const findings = await reconcileFinances(prisma);

    expect(findings.order_drift.map((f) => f.order_code)).not.toContain("ORD-USDT-OLD-ROUNDING");
  });

  it("still reports a USDT order whose total matches NEITHER rounding rule", async () => {
    // Neither 2.79 (new) nor 2.8 (old) — this is real drift and must survive
    // the historical-rounding tolerance above.
    await prisma.order.create({
      data: {
        orderCode: "ORD-USDT-REAL-DRIFT",
        userId,
        subtotalAmount: "44500",
        totalAmount: "1.5",
        currency: "USDT",
        fxRate: "16000",
        status: "DELIVERED",
        kind: "PRODUCT",
      },
    });

    const findings = await reconcileFinances(prisma);

    const entry = findings.order_drift.find((f) => f.order_code === "ORD-USDT-REAL-DRIFT");
    expect(entry).toBeTruthy();
    // The figure reported is the CURRENT rule's, never the legacy one — the
    // legacy value is only ever an exemption, never something we claim is right.
    expect(entry!.expected).toBe("2.79");
    expect(entry!.actual).toBe("1.5");
  });

  it("reports a USDT order priced under the CURRENT rule as clean", async () => {
    await prisma.order.create({
      data: {
        orderCode: "ORD-USDT-NEW-ROUNDING",
        userId,
        subtotalAmount: "44500",
        totalAmount: "2.79",
        currency: "USDT",
        fxRate: "16000",
        status: "DELIVERED",
        kind: "PRODUCT",
      },
    });

    const findings = await reconcileFinances(prisma);

    expect(findings.order_drift.map((f) => f.order_code)).not.toContain("ORD-USDT-NEW-ROUNDING");
  });

  /**
   * Whole-branch review D8 — the legacy-rounding exemption needed an end date.
   *
   * It was open-ended: ANY USDT order whose total happened to land on the old
   * 0.1-half-up figure was excused forever, including one created today, long
   * after `usdtFromIdr` stopped producing that figure. A total that shape on a
   * present-day order is not history, it is a bug in whatever wrote it — and it
   * was the one category of pricing bug this report could never see.
   * `usdt_rounding_ceil_since` closes it: before the cutoff is history, on or
   * after it is drift.
   */
  describe("usdt_rounding_ceil_since — the legacy-rounding exemption has an end date (D8)", () => {
    // Rp44.500 at 16.000 is 2.78125: 2.8 under the old rule, 2.79 under the new.
    // Every order below is that same order, moved around the cutoff.
    const legacyShapedOrder = (orderCode: string, createdAt: Date) =>
      prisma.order.create({
        data: {
          orderCode,
          userId,
          subtotalAmount: "44500",
          totalAmount: "2.8",
          currency: "USDT",
          fxRate: "16000",
          status: "DELIVERED",
          kind: "PRODUCT",
          createdAt,
        },
      });

    it("exempts an order created before the cutoff", async () => {
      await setSetting(prisma, USDT_ROUNDING_CEIL_SINCE_KEY, "2026-09-18T00:00:00.000Z");
      await legacyShapedOrder("ORD-BEFORE-CUTOFF", new Date("2026-09-17T23:59:59.000Z"));

      const findings = await reconcileFinances(prisma);

      expect(findings.order_drift.map((f) => f.order_code)).not.toContain("ORD-BEFORE-CUTOFF");
    });

    it("reports the same total on an order created after the cutoff, against the current rule", async () => {
      await setSetting(prisma, USDT_ROUNDING_CEIL_SINCE_KEY, "2026-09-18T00:00:00.000Z");
      await legacyShapedOrder("ORD-AFTER-CUTOFF", new Date("2026-09-18T00:00:01.000Z"));

      const findings = await reconcileFinances(prisma);

      const entry = findings.order_drift.find((f) => f.order_code === "ORD-AFTER-CUTOFF");
      expect(entry).toBeTruthy();
      // The figure reported is the current rule's, exactly as for any other
      // drift: the legacy value was only ever an exemption, never a claim.
      expect(entry!.expected).toBe("2.79");
      expect(entry!.actual).toBe("2.8");
    });

    it("treats an order created exactly AT the cutoff as new pricing, not history", async () => {
      // The cutoff is the instant the new rule took effect, so the instant
      // itself belongs to the new rule. Picking the other boundary would exempt
      // the first order of the new era, which is the one most worth checking.
      await setSetting(prisma, USDT_ROUNDING_CEIL_SINCE_KEY, "2026-09-18T00:00:00.000Z");
      await legacyShapedOrder("ORD-AT-CUTOFF", new Date("2026-09-18T00:00:00.000Z"));

      const findings = await reconcileFinances(prisma);

      expect(findings.order_drift.map((f) => f.order_code)).toContain("ORD-AT-CUTOFF");
    });

    it("exempts nothing when no cutoff is configured", async () => {
      // An unset cutoff means this shop has never recorded when its rounding
      // changed, so no order can be shown to predate the change and none is
      // excused. Deliberately the strict direction: the alternative is a shop
      // that silently keeps the old open-ended exemption forever.
      await legacyShapedOrder("ORD-NO-CUTOFF", new Date("2020-01-01T00:00:00.000Z"));

      const findings = await reconcileFinances(prisma);

      expect(findings.order_drift.map((f) => f.order_code)).toContain("ORD-NO-CUTOFF");
    });

    it("exempts nothing when the cutoff is blank or unparseable", async () => {
      for (const junk of ["", "   ", "not a date", "yesterday"]) {
        await prisma.order.deleteMany();
        await setSetting(prisma, USDT_ROUNDING_CEIL_SINCE_KEY, junk);
        await legacyShapedOrder("ORD-JUNK-CUTOFF", new Date("2020-01-01T00:00:00.000Z"));

        const findings = await reconcileFinances(prisma);

        expect(
          findings.order_drift.map((f) => f.order_code),
          `cutoff ${JSON.stringify(junk)} should exempt nothing`,
        ).toContain("ORD-JUNK-CUTOFF");
      }
    });

    it("leaves an IDR order alone — the cutoff only ever gated a USDT conversion", async () => {
      await setSetting(prisma, USDT_ROUNDING_CEIL_SINCE_KEY, "2026-09-18T00:00:00.000Z");
      await prisma.order.create({
        data: {
          orderCode: "ORD-IDR-AFTER-CUTOFF",
          userId,
          subtotalAmount: "44500",
          totalAmount: "44500",
          currency: "IDR",
          status: "DELIVERED",
          kind: "PRODUCT",
          createdAt: new Date("2026-09-19T00:00:00.000Z"),
        },
      });

      const findings = await reconcileFinances(prisma);

      expect(findings.order_drift.map((f) => f.order_code)).not.toContain("ORD-IDR-AFTER-CUTOFF");
    });
  });

  it("leaves voucher_drift and negative_wallets unaffected by WALLET_TOPUP orders", async () => {
    // Create a WALLET_TOPUP order
    await prisma.order.create({
      data: {
        orderCode: "ORD-TOPUP",
        userId,
        subtotalAmount: "100000",
        totalAmount: "100000",
        currency: "IDR",
        status: "DELIVERED",
        kind: "WALLET_TOPUP",
      },
    });

    const findings = await reconcileFinances(prisma);

    // voucher_drift and negative_wallets should be empty (no vouchers, no negative wallets)
    expect(findings.voucher_drift).toHaveLength(0);
    expect(findings.negative_wallets).toHaveLength(0);
  });
});
