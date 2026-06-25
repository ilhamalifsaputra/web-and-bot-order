/**
 * JSON API for the React dashboard pilot page (docs/superpowers/specs/
 * 2026-06-25-admin-dashboard-redesign-design.md). Every endpoint is a
 * read-only GET guarded by the same currentAdmin preHandler the Nunjucks
 * pages use — no separate auth model, no CSRF (nothing here mutates).
 */
import type { FastifyInstance } from "fastify";
import { startOfDayUtc } from "@app/core/datetime";
import { Decimal } from "@app/core/money";
import {
  prisma,
  revenueSummary,
  profitSummarySince,
  ordersByStatusSince,
  manualMatchQueueCounts,
  countPendingVerifications,
  countUnderpaid,
} from "@app/db";
import { currentAdmin } from "../../plugins/auth";

function shapeRevenue(r: { revenue_idr: Decimal; revenue_usdt: Decimal }) {
  const idr = new Decimal(r.revenue_idr);
  const usdt = new Decimal(r.revenue_usdt);
  return {
    idr: idr.isZero() ? null : idr.toString(),
    usdt: usdt.isZero() ? null : usdt.toString(),
    usd: usdt.isZero() ? null : usdt.toString(), // 1 USDT ≈ 1 USD, same figure under a second label
  };
}

function trendPct(curr: Decimal, prev: Decimal): string | null {
  if (prev.isZero()) return null;
  return curr.minus(prev).div(prev).times(100).toDecimalPlaces(1).toString();
}

export default async function dashboardApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/dashboard/kpis", { preHandler: currentAdmin }, async () => {
    const todayStart = startOfDayUtc();
    const yesterdayStart = startOfDayUtc(new Date(todayStart.getTime() - 1));
    const now = new Date();
    const yesterdaySameClock = new Date(yesterdayStart.getTime() + (now.getTime() - todayStart.getTime()));

    const todayRevenue = await revenueSummary(prisma, todayStart);
    const yesterdayRevenue = await revenueSummary(prisma, yesterdayStart, yesterdaySameClock);
    const profit = await profitSummarySince(prisma, todayStart);
    const orderStatus = await ordersByStatusSince(prisma, todayStart);
    const manualQueue = await manualMatchQueueCounts(prisma);
    const toReview = await countPendingVerifications(prisma);
    const underpaid = await countUnderpaid(prisma);

    const ordersTotal = orderStatus.reduce((sum, s) => sum + s.count, 0);
    const byStatus = (statuses: string[]) =>
      orderStatus.filter((s) => statuses.includes(s.status)).reduce((sum, s) => sum + s.count, 0);

    return {
      revenue: {
        ...shapeRevenue(todayRevenue),
        trendPct: {
          idr: trendPct(new Decimal(todayRevenue.revenue_idr), new Decimal(yesterdayRevenue.revenue_idr)),
          usdt: trendPct(new Decimal(todayRevenue.revenue_usdt), new Decimal(yesterdayRevenue.revenue_usdt)),
        },
      },
      profit,
      orders: {
        total: ordersTotal,
        delivered: byStatus(["DELIVERED"]),
        pending: byStatus(["PENDING_PAYMENT", "PAYMENT_DETECTED", "CONFIRMING", "PENDING_VERIFICATION", "UNDERPAID"]),
        failed: byStatus(["CANCELLED", "REJECTED", "FAILED"]),
      },
      pendingActions: {
        toReview,
        refundDecisions: underpaid,
        failedDeliveries: manualQueue.deliveryFailed,
        manualApprovals: manualQueue.unmatched,
      },
    };
  });
}
