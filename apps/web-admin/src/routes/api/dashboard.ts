/**
 * JSON API for the React dashboard pilot page (docs/superpowers/specs/
 * 2026-06-25-admin-dashboard-redesign-design.md). Every endpoint is a
 * read-only GET guarded by the same currentAdmin preHandler the Nunjucks
 * pages use — no separate auth model, no CSRF (nothing here mutates).
 */
import type { FastifyInstance } from "fastify";
import { startOfDayUtc, addDays } from "@app/core/datetime";
import { Decimal } from "@app/core/money";
import { config } from "@app/core/config";
import { evaluatePollHealth, type PollHealthEvaluation } from "@app/core/payments/pollHealth";
import { displayDateTime } from "../../dateDisplay";
import {
  prisma,
  revenueSummary,
  profitSummarySince,
  ordersByStatusSince,
  manualMatchQueueCounts,
  countPendingVerifications,
  countUnderpaid,
  countPendingPaymentLike,
  countProcessing,
  countAwaitingManualFulfillment,
  countExpiredPending,
  lowStockDenominations,
  listOrderItemsExpiringWarranty,
  recentOrders,
  topProductsByMargin,
  revenueByDay,
  ordersByDay,
  combinedRevenueByDay,
  resolveBotCredentials,
  resolveBinanceInternalConfig,
  resolveBybitConfig,
  resolveBybitBscConfig,
  getBinancePollHealth,
  getBybitPollHealth,
  getBybitBscPollHealth,
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

  app.get("/api/dashboard/operations", { preHandler: currentAdmin }, async () => {
    const now = new Date();
    const [pendingPayments, manualReviews, manualQueue, ordersProcessing, expiredPayments, awaitingFulfillment] =
      await Promise.all([
        countPendingPaymentLike(prisma),
        countPendingVerifications(prisma),
        manualMatchQueueCounts(prisma),
        countProcessing(prisma),
        countExpiredPending(prisma, now),
        countAwaitingManualFulfillment(prisma),
      ]);
    return {
      pendingPayments,
      manualReviews,
      failedDeliveries: manualQueue.deliveryFailed,
      ordersProcessing,
      expiredPayments,
      awaitingFulfillment,
    };
  });

  app.get("/api/dashboard/inventory", { preHandler: currentAdmin }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const threshold = q.threshold ? Number(q.threshold) : config.LOW_STOCK_THRESHOLD;
    const rows = await lowStockDenominations(prisma, threshold);
    return rows.map((r) => ({
      denominationId: r.denomination.id,
      productName: r.denomination.name,
      available: r.available,
      threshold,
    }));
  });

  app.get("/api/dashboard/expirations", { preHandler: currentAdmin }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const withinDays = q.withinDays ? Number(q.withinDays) : 7;
    const now = new Date();
    const rows = await listOrderItemsExpiringWarranty(prisma, now, addDays(now, withinDays));
    return rows.map((item) => ({
      orderId: item.order.id,
      orderCode: item.order.orderCode,
      productName: item.product.name,
      customerLabel: item.order.user.username ?? `Telegram ${item.order.user.telegramId}`,
      remainingDays: Math.max(
        0,
        Math.ceil((addDays(item.order.deliveredAt!, item.warrantyDaysSnapshot).getTime() - now.getTime()) / 86_400_000),
      ),
    }));
  });

  app.get("/api/dashboard/orders/recent", { preHandler: currentAdmin }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit ? Number(q.limit) : 10;
    const rows = await recentOrders(prisma, limit);
    return rows.map((r) => ({ ...r, createdAtDisplay: displayDateTime(new Date(r.createdAt)) }));
  });

  app.get("/api/dashboard/health", { preHandler: currentAdmin }, async () => {
    const toEntry = ({ status, detail }: PollHealthEvaluation) => ({ status, detail });

    const [creds, binanceConfig, bybitConfig, bybitBscConfig] = await Promise.all([
      resolveBotCredentials(prisma),
      resolveBinanceInternalConfig(prisma),
      resolveBybitConfig(prisma),
      resolveBybitBscConfig(prisma),
    ]);

    const [binanceHealth, bybitHealth, bybitBscHealth] = await Promise.all([
      binanceConfig.enabled ? getBinancePollHealth(prisma) : null,
      bybitConfig.enabled ? getBybitPollHealth(prisma) : null,
      bybitBscConfig.enabled ? getBybitBscPollHealth(prisma) : null,
    ]);

    // TokoPay, PayDisini, and NOWPayments have no heartbeat tracking yet
    // (that's Task 11, still ahead) — there is no getPollHealth for them and
    // none should be invented here. Routing a null heartbeat through the same
    // shared rule (instead of a bare hardcoded "unmonitored" string) means the
    // "unmonitored" verdict here carries a real, rule-derived `detail`
    // ("No heartbeat has been recorded for this poller yet.") rather than a
    // constant with no explanation — a reader can tell these apart from a
    // genuinely-disabled rail by that detail text.
    const noHeartbeatYet = evaluatePollHealth(null, { enabled: true });

    return {
      telegramBot: {
        status: creds.botToken === null ? "red" : "green",
        detail: creds.botToken === null ? "No Telegram bot token is configured." : "Bot token is configured.",
      },
      binance: toEntry(evaluatePollHealth(binanceHealth, { enabled: binanceConfig.enabled })),
      bybit: toEntry(evaluatePollHealth(bybitHealth, { enabled: bybitConfig.enabled })),
      bybitBsc: toEntry(evaluatePollHealth(bybitBscHealth, { enabled: bybitBscConfig.enabled })),
      tokopay: toEntry(noHeartbeatYet),
      paydisini: toEntry(noHeartbeatYet),
      nowpayments: toEntry(noHeartbeatYet),
    };
  });

  app.get("/api/dashboard/top-products", { preHandler: currentAdmin }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const days = q.days ? Number(q.days) : 30;
    const limit = q.limit ? Number(q.limit) : 5;
    return topProductsByMargin(prisma, addDays(new Date(), -days), limit);
  });

  app.get("/api/dashboard/analytics", { preHandler: currentAdmin }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const days = q.range === "30d" ? 30 : 7;
    const currency = q.currency ?? "idr";
    const metric = q.metric ?? "revenue";

    if (metric === "orders") {
      const rows = await ordersByDay(prisma, days);
      return rows.map((r) => ({ day: r.day, value: currency === "usdt" ? r.ordersUsdt : r.ordersIdr }));
    }
    if (currency === "combined") {
      const rows = await combinedRevenueByDay(prisma, days);
      return rows.map((r) => ({ day: r.day, value: r.revenueIdrEquiv }));
    }
    const rows = await revenueByDay(prisma, days);
    return rows.map((r) => ({ day: r.day, value: currency === "usdt" ? r.revenue_usdt : r.revenue_idr }));
  });
}
