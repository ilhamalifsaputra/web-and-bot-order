/**
 * Reports & reconciliation — port of the "Reports" + reconcile_finances
 * sections of crud.py. reconcile_finances detects drift WITHOUT mutating rows.
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
  negative_wallets: Array<{ user_id: number; telegram_id: string | null; balance: string }>;
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
    let afterWallet = afterDisc.minus(o.walletUsed);
    if (afterWallet.lessThan(0)) afterWallet = new Decimal(0);
    // Subtotals are stored in the central price unit (IDR post-cutover; the
    // pre-cutover snapshot unit before). The CHARGED total depends on the
    // pay-time choice (plan.md §15.1): a USDT order with an fxRate snapshot is
    // round(base/rate, 0.1) + cents; an IDR order is the whole-Rupiah base.
    let expected: Decimal;
    if (o.currency === "USDT" && o.fxRate != null) {
      expected = q4(usdtFromIdr(afterWallet, o.fxRate).plus(o.uniqueCents));
    } else if (o.currency === "IDR") {
      expected = quantizeMoney(afterWallet, 0);
    } else {
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
  for (const v of vouchers) {
    const actual = await db.order.count({
      where: { voucherId: v.id, status: { not: OrderStatus.CANCELLED } },
    });
    if (actual !== v.usedCount) {
      findings.voucher_drift.push({
        voucher_id: v.id,
        code: v.code,
        recorded_used: v.usedCount,
        actual_orders: actual,
      });
    }
  }

  // 3. Negative wallet balances.
  const negatives = await db.user.findMany({ where: { walletBalance: { lt: 0 } } });
  for (const u of negatives) {
    findings.negative_wallets.push({
      user_id: u.id,
      telegram_id: u.telegramId ? u.telegramId.toString() : null,
      balance: new Decimal(u.walletBalance).toString(),
    });
  }

  return findings;
}

/** Delivered-order totals split per transaction currency (plan.md §15.8 —
 * reports keep currencies apart instead of pretending one unit). Orders
 * predating the currency column count as USDT (their snapshot currency). */
async function deliveredRevenueByCurrency(
  db: Db,
  extraWhere: Record<string, unknown> = {},
): Promise<{ idr: Decimal; usdt: Decimal; orders: number }> {
  const groups = await db.order.groupBy({
    by: ["currency"],
    where: { status: OrderStatus.DELIVERED, ...extraWhere },
    _sum: { totalAmount: true },
    _count: { _all: true },
  });
  let idr = new Decimal(0);
  let usdt = new Decimal(0);
  let orders = 0;
  for (const g of groups) {
    const sum = new Decimal(g._sum.totalAmount ?? 0);
    if (g.currency === "IDR") idr = idr.plus(sum);
    else usdt = usdt.plus(sum);
    orders += g._count._all;
  }
  return { idr, usdt, orders };
}

export async function botOverallStats(db: Db): Promise<{
  items_sold: number;
  revenue_idr: Decimal;
  revenue_usdt: Decimal;
  total_users: number;
}> {
  const itemsAgg = await db.orderItem.aggregate({
    where: { order: { status: OrderStatus.DELIVERED } },
    _sum: { quantity: true },
  });
  const rev = await deliveredRevenueByCurrency(db);
  const totalUsers = await db.user.count();
  return {
    items_sold: itemsAgg._sum.quantity ?? 0,
    revenue_idr: rev.idr,
    revenue_usdt: rev.usdt,
    total_users: totalUsers,
  };
}

export async function revenueSummary(
  db: Db,
  since: Date,
  until: Date = new Date(),
): Promise<{ revenue_idr: Decimal; revenue_usdt: Decimal; orders: number }> {
  const rev = await deliveredRevenueByCurrency(db, { deliveredAt: { gte: since, lte: until } });
  return { revenue_idr: rev.idr, revenue_usdt: rev.usdt, orders: rev.orders };
}

// ---- Reports & charts (web admin) ----------------------------------------

export interface DayRevenue {
  day: string; // YYYY-MM-DD (UTC)
  revenue_idr: string;
  revenue_usdt: string;
  orders: number;
}

/**
 * Daily delivered revenue for the last `days` days, oldest→newest, with empty
 * days filled with zero so the sparkline has no gaps. Buckets by UTC date; the
 * dashboard is single-operator so a TZ-exact daily cut isn't worth a raw query.
 *
 * Split by `currency` (mirrors `deliveredRevenueByCurrency` above) — summing
 * `totalAmount` across orders regardless of currency would add a USDT order's
 * small decimal total straight into the Rupiah figure, the reports-page
 * equivalent of the "Rp3" display bug.
 */
export async function revenueByDay(db: Db, days = 30): Promise<DayRevenue[]> {
  const now = new Date();
  const since = addDays(now, -(days - 1));
  since.setUTCHours(0, 0, 0, 0);

  const orders = await db.order.findMany({
    where: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } },
    select: { deliveredAt: true, totalAmount: true, currency: true },
  });

  const buckets = new Map<string, { idr: Decimal; usdt: Decimal; orders: number }>();
  for (let i = 0; i < days; i++) {
    const d = addDays(since, i);
    buckets.set(d.toISOString().slice(0, 10), { idr: new Decimal(0), usdt: new Decimal(0), orders: 0 });
  }
  for (const o of orders) {
    if (!o.deliveredAt) continue;
    const key = o.deliveredAt.toISOString().slice(0, 10);
    const b = buckets.get(key);
    if (!b) continue; // outside the window (shouldn't happen)
    if (o.currency === "IDR") b.idr = b.idr.plus(o.totalAmount);
    else b.usdt = b.usdt.plus(o.totalAmount);
    b.orders += 1;
  }
  return [...buckets.entries()].map(([day, b]) => ({
    day,
    revenue_idr: q4(b.idr).toString(),
    revenue_usdt: q4(b.usdt).toString(),
    orders: b.orders,
  }));
}

export interface TopProduct {
  productId: number;
  name: string;
  qty: number;
  revenue: string;
}

/** Best-selling products by delivered quantity, with revenue (unit_price ×
 * quantity summed in JS — OrderItem has no stored line subtotal). */
export async function topProducts(db: Db, limit = 10): Promise<TopProduct[]> {
  const items = await db.orderItem.findMany({
    where: { order: { status: OrderStatus.DELIVERED } },
    select: { productId: true, quantity: true, unitPrice: true },
  });
  // OrderItem is keyed by denomination (column is `product_id`).
  const products = await db.denomination.findMany({ select: { id: true, name: true } });
  const nameById = new Map(products.map((p) => [p.id, p.name]));

  const acc = new Map<number, { qty: number; revenue: Decimal }>();
  for (const it of items) {
    const a = acc.get(it.productId) ?? { qty: 0, revenue: new Decimal(0) };
    a.qty += it.quantity;
    a.revenue = a.revenue.plus(new Decimal(it.unitPrice).times(it.quantity));
    acc.set(it.productId, a);
  }
  return [...acc.entries()]
    .map(([productId, a]) => ({
      productId,
      name: nameById.get(productId) ?? `#${productId}`,
      qty: a.qty,
      revenue: q4(a.revenue).toString(),
    }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, limit);
}

export interface TopProductMargin {
  productId: number;
  name: string;
  unitsSold: number;
  revenueIdrEquiv: string;
  profitIdrEquiv: string | null;
  costUnknownUnits: number;
}

/**
 * Best-selling products since `since`, ranked by units sold, with revenue and
 * profit normalized to IDR-equivalent — USDT lines convert via each order's
 * own `fxRate` snapshot, the same "Combined" conversion `combinedRevenueByDay`
 * uses, never a live rate. `costPrice` is always catalog-central IDR, so it
 * needs no conversion. Any cost-unknown unit nulls that product's profit
 * (rather than silently treating unknown cost as zero) while still reporting
 * its revenue and the count of affected units.
 */
export async function topProductsByMargin(db: Db, since: Date, limit = 5): Promise<TopProductMargin[]> {
  const items = await db.orderItem.findMany({
    where: { order: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } } },
    select: {
      productId: true,
      quantity: true,
      unitPrice: true,
      product: { select: { name: true, costPrice: true } },
      order: { select: { currency: true, fxRate: true } },
    },
  });

  const acc = new Map<number, { name: string; units: number; revenue: Decimal; cost: Decimal; costUnknownUnits: number }>();
  for (const item of items) {
    const idrUnitPrice = item.order.currency === "USDT" && item.order.fxRate != null
      ? new Decimal(item.unitPrice).times(item.order.fxRate)
      : new Decimal(item.unitPrice);
    const a = acc.get(item.productId) ?? { name: item.product.name, units: 0, revenue: new Decimal(0), cost: new Decimal(0), costUnknownUnits: 0 };
    a.units += item.quantity;
    a.revenue = a.revenue.plus(idrUnitPrice.times(item.quantity));
    if (item.product.costPrice == null) {
      a.costUnknownUnits += item.quantity;
    } else {
      a.cost = a.cost.plus(new Decimal(item.product.costPrice).times(item.quantity));
    }
    acc.set(item.productId, a);
  }

  return [...acc.entries()]
    .map(([productId, a]) => ({
      productId,
      name: a.name,
      unitsSold: a.units,
      revenueIdrEquiv: q4(a.revenue).toString(),
      profitIdrEquiv: a.costUnknownUnits > 0 ? null : q4(a.revenue.minus(a.cost)).toString(),
      costUnknownUnits: a.costUnknownUnits,
    }))
    .sort((a, b) => b.unitsSold - a.unitsSold)
    .slice(0, limit);
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

export interface CurrencyProfit {
  netProfit: string;
  marginPct: string | null;
  excludedItemCount: number;
}

export interface ProfitSummary {
  idr: CurrencyProfit | null;
  usdt: CurrencyProfit | null;
}

/**
 * Net profit + margin for delivered OrderItems since `since`, split by the
 * order's currency — never blended (the "Rp137 + 20.25 USDT" bug this
 * dashboard exists to fix). `Denomination.costPrice` is always catalog-
 * central IDR; a USDT-currency line converts it to USDT-equivalent via THAT
 * order's own `fxRate` snapshot (never a live rate) before subtracting it
 * from the USDT revenue it corresponds to. Items whose Denomination has no
 * costPrice are excluded from both the profit sum and the margin%
 * denominator (counting them at cost=0 would read as a fabricated 100%
 * margin) and counted in `excludedItemCount` instead.
 */
export async function profitSummarySince(db: Db, since: Date): Promise<ProfitSummary> {
  const items = await db.orderItem.findMany({
    where: { order: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } } },
    select: {
      quantity: true,
      unitPrice: true,
      product: { select: { costPrice: true } },
      order: { select: { currency: true, fxRate: true } },
    },
  });

  const byCurrency: Record<"IDR" | "USDT", { revenue: Decimal; cost: Decimal; excluded: number }> = {
    IDR: { revenue: new Decimal(0), cost: new Decimal(0), excluded: 0 },
    USDT: { revenue: new Decimal(0), cost: new Decimal(0), excluded: 0 },
  };

  for (const item of items) {
    const isUsdt = item.order.currency === "USDT";
    const bucket = isUsdt ? byCurrency.USDT : byCurrency.IDR;
    if (item.product.costPrice == null) {
      bucket.excluded += 1;
      continue;
    }
    const lineRevenue = new Decimal(item.unitPrice).times(item.quantity);
    const lineCostIdr = new Decimal(item.product.costPrice).times(item.quantity);
    const lineCost = isUsdt && item.order.fxRate != null ? lineCostIdr.div(item.order.fxRate) : lineCostIdr;
    bucket.revenue = bucket.revenue.plus(lineRevenue);
    bucket.cost = bucket.cost.plus(lineCost);
  }

  const shape = (b: { revenue: Decimal; cost: Decimal; excluded: number }): CurrencyProfit | null => {
    if (b.revenue.isZero() && b.excluded === 0) return null;
    const profit = b.revenue.minus(b.cost);
    const marginPct = b.revenue.isZero() ? null : profit.div(b.revenue).times(100).toDecimalPlaces(2).toString();
    return { netProfit: q4(profit).toString(), marginPct, excludedItemCount: b.excluded };
  };

  return { idr: shape(byCurrency.IDR), usdt: shape(byCurrency.USDT) };
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
