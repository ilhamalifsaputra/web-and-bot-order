/**
 * Reports & reconciliation — port of the "Reports" + reconcile_finances
 * sections of crud.py. reconcile_finances detects drift WITHOUT mutating rows.
 * Revenue/profit/analytics-by-day computations live in ./revenue.ts.
 */
import { OrderStatus } from "@app/core/enums";
import { quantizeMoney, usdtFromIdr } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { addDays } from "@app/core/datetime";
import type { Db } from "./_types";

const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);

export interface ReconcileFindings {
  order_drift: Array<{ order_id: number; order_code: string; expected: string; actual: string }>;
  voucher_drift: Array<{ voucher_id: number; code: string; recorded_used: number; actual_orders: number }>;
  negative_wallets: Array<{ user_id: number; telegram_id: string | null; balance: string; currency: "IDR" | "USDT" }>;
}

export async function reconcileFinances(db: Db): Promise<ReconcileFindings> {
  const findings: ReconcileFindings = {
    order_drift: [],
    voucher_drift: [],
    negative_wallets: [],
  };

  // 1. Order total integrity (non-cancelled orders).
  const orders = await db.order.findMany({
    where: { status: { not: OrderStatus.CANCELLED } },
  });
  for (const o of orders) {
    const afterDisc = new Decimal(o.subtotalAmount)
      .minus(o.bulkDiscountAmount)
      .minus(o.discountAmount);
    // Subtotals are stored in the central price unit (IDR post-cutover; the
    // pre-cutover snapshot unit before). The CHARGED total depends on the
    // pay-time choice (plan.md §15.1): a USDT order with an fxRate snapshot is
    // round(base/rate, 0.1) + cents; an IDR order is the whole-Rupiah base.
    let expected: Decimal;
    if (o.currency === "USDT" && o.fxRate != null) {
      // walletUsed on a USDT order is USDT-denominated: applyUsdtWalletToOrder
      // (orders.ts) debits the USDT balance and subtracts it from the
      // ALREADY-converted totalAmount, after the IDR->USDT conversion — unlike
      // the IDR wallet paths below, which subtract IDR walletUsed before any
      // conversion happens.
      let afterWallet = usdtFromIdr(afterDisc, o.fxRate).minus(o.walletUsed);
      if (afterWallet.lessThan(0)) afterWallet = new Decimal(0);
      expected = q4(afterWallet.plus(o.uniqueCents));
    } else if (o.currency === "IDR") {
      let afterWallet = afterDisc.minus(o.walletUsed);
      if (afterWallet.lessThan(0)) afterWallet = new Decimal(0);
      expected = quantizeMoney(afterWallet, 0);
    } else {
      let afterWallet = afterDisc.minus(o.walletUsed);
      if (afterWallet.lessThan(0)) afterWallet = new Decimal(0);
      expected = q4(afterWallet.plus(o.uniqueCents));
    }
    if (expected.minus(o.totalAmount).abs().greaterThan("0.0001")) {
      findings.order_drift.push({
        order_id: o.id,
        order_code: o.orderCode,
        expected: expected.toString(),
        actual: new Decimal(o.totalAmount).toString(),
      });
    }
  }

  // 2. Voucher usage drift.
  const vouchers = await db.voucher.findMany();
  const voucherOrderCounts = await db.order.groupBy({
    by: ["voucherId"],
    where: { voucherId: { in: vouchers.map((v) => v.id) }, status: { not: OrderStatus.CANCELLED } },
    _count: { _all: true },
  });
  const actualByVoucherId = new Map(voucherOrderCounts.map((g) => [g.voucherId, g._count._all]));
  for (const v of vouchers) {
    const actual = actualByVoucherId.get(v.id) ?? 0;
    if (actual !== v.usedCount) {
      findings.voucher_drift.push({
        voucher_id: v.id,
        code: v.code,
        recorded_used: v.usedCount,
        actual_orders: actual,
      });
    }
  }

  // 3. Negative wallet balances (both IDR and USDT).
  const negativesIdr = await db.user.findMany({ where: { walletBalance: { lt: 0 } } });
  for (const u of negativesIdr) {
    findings.negative_wallets.push({
      user_id: u.id,
      telegram_id: u.telegramId ? u.telegramId.toString() : null,
      balance: new Decimal(u.walletBalance).toString(),
      currency: "IDR",
    });
  }

  const negativesUsdt = await db.user.findMany({ where: { walletBalanceUsdt: { lt: 0 } } });
  for (const u of negativesUsdt) {
    findings.negative_wallets.push({
      user_id: u.id,
      telegram_id: u.telegramId ? u.telegramId.toString() : null,
      balance: new Decimal(u.walletBalanceUsdt).toString(),
      currency: "USDT",
    });
  }

  return findings;
}

export interface StatusCount {
  status: string;
  count: number;
}

/** Order counts grouped by status (the funnel). */
export async function ordersByStatus(db: Db): Promise<StatusCount[]> {
  const grouped = await db.order.groupBy({ by: ["status"], _count: { _all: true } });
  return grouped
    .map((g) => ({ status: g.status, count: g._count._all }))
    .sort((a, b) => b.count - a.count);
}

/** Order counts grouped by status, restricted to orders created since `since` — the dashboard's "today" funnel. */
export async function ordersByStatusSince(db: Db, since: Date): Promise<StatusCount[]> {
  const grouped = await db.order.groupBy({
    by: ["status"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  return grouped
    .map((g) => ({ status: g.status, count: g._count._all }))
    .sort((a, b) => b.count - a.count);
}

export interface VoucherUsage {
  id: number;
  code: string;
  usedCount: number;
  usageLimit: number | null;
  isActive: boolean;
}

/** Vouchers ordered by how heavily they've been used. */
export async function voucherUsage(db: Db, limit = 20): Promise<VoucherUsage[]> {
  const rows = await db.voucher.findMany({
    orderBy: { usedCount: "desc" },
    take: limit,
  });
  return rows.map((v) => ({
    id: v.id,
    code: v.code,
    usedCount: v.usedCount,
    usageLimit: v.usageLimit ?? null,
    isActive: v.isActive,
  }));
}

export interface ManualMatchQueueCounts {
  unmatched: number;
  deliveryFailed: number;
}

/**
 * Counts of `unmatched` / `delivery_failed` ledger rows across all five
 * payment-method idempotency tables (Binance, Bybit, TokoPay, Paydisini,
 * NOWPayments) — generalizes the Binance-only `processedTxOutcomeCounts()`
 * (binance_internal.ts) for the dashboard's cross-provider "manual
 * approvals" / "failed deliveries" counts.
 */
export async function manualMatchQueueCounts(db: Db): Promise<ManualMatchQueueCounts> {
  const groups = await Promise.all([
    db.processedBinanceTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
    db.processedBybitTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
    db.processedTokopayTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
    db.processedPaydisiniTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
    db.processedNowpaymentsTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
  ]);

  let unmatched = 0;
  let deliveryFailed = 0;
  for (const grouped of groups) {
    for (const g of grouped) {
      if (g.outcome === "unmatched") unmatched += g._count._all;
      if (g.outcome === "delivery_failed") deliveryFailed += g._count._all;
    }
  }
  return { unmatched, deliveryFailed };
}

/** OrderItems whose warranty (delivered_at + snapshot days) falls in [start,end]. */
export async function listOrderItemsExpiringWarranty(
  db: Db,
  start: Date,
  end: Date,
) {
  const lookback = addDays(end, -400);
  const rows = await db.orderItem.findMany({
    where: {
      order: {
        status: OrderStatus.DELIVERED,
        deliveredAt: { not: null, gte: lookback },
      },
    },
    include: { product: true, order: { include: { user: true } } },
  });
  return rows.filter((item) => {
    const deliveredAt = item.order.deliveredAt;
    if (!deliveredAt) return false;
    const expiry = addDays(deliveredAt, item.warrantyDaysSnapshot);
    return start.getTime() <= expiry.getTime() && expiry.getTime() <= end.getTime();
  });
}

export interface RecentOrderRow {
  orderId: number;
  orderCode: string;
  productLabel: string;
  customerLabel: string;
  amount: string;
  currency: string;
  status: string;
  createdAt: string;
}

/** Latest orders for the dashboard's Recent Orders table, newest first. */
export async function recentOrders(db: Db, limit = 10): Promise<RecentOrderRow[]> {
  const orders = await db.order.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      user: { select: { username: true, telegramId: true } },
      items: { select: { product: { select: { name: true } } }, orderBy: { id: "asc" }, take: 1 },
      _count: { select: { items: true } },
    },
  });
  return orders.map((o) => {
    const firstItemName = o.items[0]?.product.name ?? "—";
    const extra = o._count.items - 1;
    return {
      orderId: o.id,
      orderCode: o.orderCode,
      productLabel: extra > 0 ? `${firstItemName} +${extra} more` : firstItemName,
      customerLabel: o.user.username ?? (o.user.telegramId != null ? `Telegram ${o.user.telegramId}` : "Unknown customer"),
      amount: new Decimal(o.totalAmount).toString(),
      currency: o.currency,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    };
  });
}
