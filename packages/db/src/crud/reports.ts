/**
 * Reports & reconciliation — port of the "Reports" + reconcile_finances
 * sections of crud.py. reconcile_finances detects drift WITHOUT mutating rows.
 */
import { OrderStatus } from "@app/core/enums";
import { quantizeMoney } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { addDays } from "@app/core/datetime";
import type { Db } from "./_types";

const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);

export interface ReconcileFindings {
  order_drift: Array<{ order_id: number; order_code: string; expected: string; actual: string }>;
  voucher_drift: Array<{ voucher_id: number; code: string; recorded_used: number; actual_orders: number }>;
  negative_wallets: Array<{ user_id: number; telegram_id: string; balance: string }>;
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
    const expected = q4(afterWallet.plus(o.uniqueCents));
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
      telegram_id: u.telegramId.toString(),
      balance: new Decimal(u.walletBalance).toString(),
    });
  }

  return findings;
}

export async function botOverallStats(
  db: Db,
): Promise<{ items_sold: number; total_revenue: Decimal; total_users: number }> {
  const itemsAgg = await db.orderItem.aggregate({
    where: { order: { status: OrderStatus.DELIVERED } },
    _sum: { quantity: true },
  });
  const revenueAgg = await db.order.aggregate({
    where: { status: OrderStatus.DELIVERED },
    _sum: { totalAmount: true },
  });
  const totalUsers = await db.user.count();
  return {
    items_sold: itemsAgg._sum.quantity ?? 0,
    total_revenue: new Decimal(revenueAgg._sum.totalAmount ?? 0),
    total_users: totalUsers,
  };
}

export async function revenueSummary(
  db: Db,
  since: Date,
): Promise<{ revenue: Decimal; orders: number }> {
  const agg = await db.order.aggregate({
    where: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } },
    _sum: { totalAmount: true },
    _count: { _all: true },
  });
  return {
    revenue: new Decimal(agg._sum.totalAmount ?? 0),
    orders: agg._count._all,
  };
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
