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
): Promise<{ revenue_idr: Decimal; revenue_usdt: Decimal; orders: number }> {
  const rev = await deliveredRevenueByCurrency(db, { deliveredAt: { gte: since } });
  return { revenue_idr: rev.idr, revenue_usdt: rev.usdt, orders: rev.orders };
}

// ---- Reports & charts (web admin) ----------------------------------------

export interface DayRevenue {
  day: string; // YYYY-MM-DD (UTC)
  revenue: string;
  orders: number;
}

/**
 * Daily delivered revenue for the last `days` days, oldest→newest, with empty
 * days filled with zero so the sparkline has no gaps. Buckets by UTC date; the
 * dashboard is single-operator so a TZ-exact daily cut isn't worth a raw query.
 */
export async function revenueByDay(db: Db, days = 30): Promise<DayRevenue[]> {
  const now = new Date();
  const since = addDays(now, -(days - 1));
  since.setUTCHours(0, 0, 0, 0);

  const orders = await db.order.findMany({
    where: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } },
    select: { deliveredAt: true, totalAmount: true },
  });

  const buckets = new Map<string, { revenue: Decimal; orders: number }>();
  for (let i = 0; i < days; i++) {
    const d = addDays(since, i);
    buckets.set(d.toISOString().slice(0, 10), { revenue: new Decimal(0), orders: 0 });
  }
  for (const o of orders) {
    if (!o.deliveredAt) continue;
    const key = o.deliveredAt.toISOString().slice(0, 10);
    const b = buckets.get(key);
    if (!b) continue; // outside the window (shouldn't happen)
    b.revenue = b.revenue.plus(o.totalAmount);
    b.orders += 1;
  }
  return [...buckets.entries()].map(([day, b]) => ({
    day,
    revenue: q4(b.revenue).toString(),
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
