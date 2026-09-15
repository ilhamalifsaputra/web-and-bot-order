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
import {
  TOKOPAY_POLL_STALE_MS,
  PAYDISINI_POLL_STALE_MS,
  NOWPAYMENTS_POLL_STALE_MS,
} from "@app/core/payments/reconcileCycleBudget";
import { displayDateTime } from "../../dateDisplay";
import {
  prisma,
  revenueSummary,
  grossSalesForNetSales,
  refundTotalsSince,
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
  revenueByPeriod,
  ordersByPeriod,
  profitByPeriod,
  profitByDay,
  type PeriodGranularity,
  resolveBotCredentials,
  resolveBinanceInternalConfig,
  resolveBybitConfig,
  resolveBybitBscConfig,
  getBinancePollHealth,
  getBybitPollHealth,
  getBybitBscPollHealth,
  getPollHealth,
  getTokopayCreds,
  getPaydisiniCreds,
  getNowpaymentsCreds,
  getDigiflazzCreds,
} from "@app/db";
import { currentAdmin } from "../../plugins/auth";

/**
 * Staleness threshold for the digiflazzCatalogSync Business Health rail —
 * see the doc comment at this constant's one call site (inside the
 * /api/dashboard/health handler below) for the full "why not the crypto-rail
 * default" derivation. The hourly cron (apps/order-bot/src/jobs/index.ts's
 * scheduleDigiflazzCatalogSync, "15 * * * *") is the source of truth for
 * "1 hour" — this constant is not derived from a shared config value the
 * way the QRIS rails' own staleMs is (QRIS_STALE_MARGIN_MS derives from
 * config.POLL_INTERVAL_SECONDS), since the cron expression itself isn't
 * exposed as one. 70 minutes = the hourly cadence + a flat 10-minute
 * margin: generous enough to absorb one run's own duration (a bounded
 * price-list HTTP fetch plus a batch of local writes — seconds in
 * practice, never remotely close to 10 minutes) plus ordinary process
 * restart/scheduling jitter, while still flipping this card red within
 * ~10 minutes of a genuinely missed hourly run rather than waiting for a
 * second missed run to notice.
 */
const DIGIFLAZZ_CATALOG_SYNC_STALE_MS = 70 * 60_000;

function shapeRevenue(r: { revenue_idr: Decimal; revenue_usdt: Decimal }) {
  const idr = new Decimal(r.revenue_idr);
  const usdt = new Decimal(r.revenue_usdt);
  return {
    idr: idr.isZero() ? null : idr.toString(),
    usdt: usdt.isZero() ? null : usdt.toString(),
    usd: usdt.isZero() ? null : usdt.toString(), // 1 USDT ≈ 1 USD, same figure under a second label
  };
}

/**
 * The same null-when-zero convention `shapeRevenue` above uses, for the
 * two-currency money figures Task 6b adds (`refunds`, `netSales`): zero means
 * "nothing to report", and the card renders its own empty state rather than a
 * literal Rp0. These two carry no `usd` alias — only the revenue card renders
 * the USDT figure a second time under a USD label.
 *
 * A consequence worth naming for `netSales`: a day whose refunds exactly cancel
 * its gross sales reads the same as a day with no activity at all. That is the
 * existing convention applied consistently rather than a second, different
 * null rule invented for one field — and it is only the exact-zero knife edge,
 * since a genuinely negative net figure is non-zero and renders in full.
 */
function shapeMoneyPair(idr: Decimal, usdt: Decimal) {
  return {
    idr: idr.isZero() ? null : idr.toString(),
    usdt: usdt.isZero() ? null : usdt.toString(),
  };
}

/**
 * The calendar granularity a `range` query value asks for, or `null` for the
 * two rolling daily windows (`7d`/`30d`) and for anything unrecognised — the
 * daily path is the endpoint's original behavior and stays the default.
 */
function periodGranularity(range: string | undefined): PeriodGranularity | null {
  return range === "week" || range === "month" || range === "year" ? range : null;
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
    const todayRefunds = await refundTotalsSince(prisma, todayStart);
    // Net Sales' own gross basis — NOT `todayRevenue`. See the comment on the
    // `netSales` field below, and grossSalesForNetSales' own doc comment.
    const todayGrossForNet = await grossSalesForNetSales(prisma, todayStart);
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
      // Refunds actually paid out today, and today's gross sales net of them
      // (Financial Ledger M6, Task 6b). This is the first thing on the
      // dashboard that reflects a refund at all.
      //
      // The gross basis subtracted from is `grossSalesForNetSales`, NOT the
      // `revenue` figure above, and the two genuinely differ on a day with a
      // FULL refund: a fully-refunded order leaves DELIVERED for REFUNDED, so
      // it drops out of "Revenue Today" (delivered-only, by design) while the
      // sale itself still happened that day. Subtracting the payout from the
      // figure it had already left charged the same refund twice and reported
      // -Rp10.000 for a day that netted zero. `revenue` above is unchanged —
      // only Net Sales' internal basis differs. See grossSalesForNetSales'
      // doc comment for why Gross and Net are allowed to disagree here.
      //
      // Net Sales is a plain Decimal subtraction and is deliberately NOT clamped
      // at zero: a refund can legitimately be for an order sold on an earlier
      // day, so "more refunded today than sold today" is a real, negative
      // signal an operator needs to see, not an error to be hidden behind a 0.
      refunds: shapeMoneyPair(todayRefunds.refunds_idr, todayRefunds.refunds_usdt),
      netSales: shapeMoneyPair(
        todayGrossForNet.idr.minus(todayRefunds.refunds_idr),
        todayGrossForNet.usdt.minus(todayRefunds.refunds_usdt),
      ),
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

    const [creds, binanceConfig, bybitConfig, bybitBscConfig, tokopayCreds, paydisiniCreds, nowpaymentsCreds, digiflazzCreds] =
      await Promise.all([
        resolveBotCredentials(prisma),
        resolveBinanceInternalConfig(prisma),
        resolveBybitConfig(prisma),
        resolveBybitBscConfig(prisma),
        getTokopayCreds(prisma),
        getPaydisiniCreds(prisma),
        getNowpaymentsCreds(prisma),
        getDigiflazzCreds(prisma),
      ]);
    // Same credential gate the QRIS watchdogs use (tokopayPollWatchdog and its
    // two twins, apps/order-bot/src/jobs/index.ts) — a rail the shop has never
    // turned on must read "unmonitored", not red, same as a disabled crypto rail.
    const tokopayEnabled = tokopayCreds !== null;
    const paydisiniEnabled = paydisiniCreds !== null;
    const nowpaymentsEnabled = nowpaymentsCreds !== null;
    const digiflazzEnabled = digiflazzCreds !== null;

    const [binanceHealth, bybitHealth, bybitBscHealth, tokopayHealth, paydisiniHealth, nowpaymentsHealth, digiflazzCatalogSyncHealth] =
      await Promise.all([
        binanceConfig.enabled ? getBinancePollHealth(prisma) : null,
        bybitConfig.enabled ? getBybitPollHealth(prisma) : null,
        bybitBscConfig.enabled ? getBybitBscPollHealth(prisma) : null,
        tokopayEnabled ? getPollHealth(prisma, "tokopay") : null,
        paydisiniEnabled ? getPollHealth(prisma, "paydisini") : null,
        nowpaymentsEnabled ? getPollHealth(prisma, "nowpayments") : null,
        digiflazzEnabled ? getPollHealth(prisma, "digiflazzCatalogSync") : null,
      ]);

    return {
      telegramBot: {
        status: creds.botToken === null ? "red" : "green",
        detail: creds.botToken === null ? "No Telegram bot token is configured." : "Bot token is configured.",
      },
      binance: toEntry(evaluatePollHealth(binanceHealth, { enabled: binanceConfig.enabled })),
      bybit: toEntry(evaluatePollHealth(bybitHealth, { enabled: bybitConfig.enabled })),
      bybitBsc: toEntry(evaluatePollHealth(bybitBscHealth, { enabled: bybitBscConfig.enabled })),
      // The three QRIS/IDR rails pass their own, much wider staleMs — same as
      // tokopayPollWatchdog and its two twins (apps/order-bot/src/jobs/
      // index.ts) — instead of evaluatePollHealth's 5-minute crypto-rail
      // default. One reconcile cycle on these rails can legitimately make up
      // to 50 sequential, individually-timed-out gateway calls, so a cycle
      // that runs several minutes past the 5-minute mark is ordinary
      // slowness, not a hang; using the default here would turn this card red
      // while the watchdog stays correctly silent — the exact
      // three-consumers-three-rules divergence this branch's P1 exists to
      // prevent (Task 13 review follow-up). See
      // packages/core/src/payments/reconcileCycleBudget.ts for the shared
      // derivation both this endpoint and the watchdog read.
      tokopay: toEntry(evaluatePollHealth(tokopayHealth, { enabled: tokopayEnabled, staleMs: TOKOPAY_POLL_STALE_MS })),
      paydisini: toEntry(evaluatePollHealth(paydisiniHealth, { enabled: paydisiniEnabled, staleMs: PAYDISINI_POLL_STALE_MS })),
      nowpayments: toEntry(evaluatePollHealth(nowpaymentsHealth, { enabled: nowpaymentsEnabled, staleMs: NOWPAYMENTS_POLL_STALE_MS })),
      // Review fix (Task 12): the hourly catalog re-sync
      // (scheduleDigiflazzCatalogSync, cron "15 * * * *",
      // apps/order-bot/src/jobs/index.ts) writes its heartbeat once per
      // COMPLETED run, not continuously — so it is EVEN LESS frequent than
      // the QRIS rails' own multi-minute reconcile cycles, not "frequent
      // enough for the crypto-rail default" as first assumed here. Passing
      // no staleMs (evaluatePollHealth's 5-minute DEFAULT_STALE_MS,
      // packages/core/src/payments/pollHealth.ts, tuned for the ~2-minute
      // crypto pollers) would flip this card red roughly 55 of every 60
      // minutes even when the job is running exactly on schedule — the
      // same "watching a slow-cadence job with a fast-cadence rail's
      // threshold" mistake the comment above already explains for
      // tokopay/paydisini/nowpayments, just from the opposite direction (an
      // hourly job, not a slow-running one). DIGIFLAZZ_CATALOG_SYNC_STALE_MS
      // is local to this file rather than living in
      // reconcileCycleBudget.ts (the QRIS rails' shared derivation) because
      // there is no watchdog cron for this rail today (unlike
      // tokopayPollWatchdog and its two twins) — this dashboard endpoint is
      // the only consumer, so there is nothing else to keep in sync with.
      digiflazzCatalogSync: toEntry(
        evaluatePollHealth(digiflazzCatalogSyncHealth, {
          enabled: digiflazzEnabled,
          staleMs: DIGIFLAZZ_CATALOG_SYNC_STALE_MS,
        }),
      ),
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
    // `7d`/`30d` are rolling daily windows (the original two ranges, untouched);
    // `week`/`month`/`year` are calendar rollups added by Task 6c. Anything
    // unrecognised keeps the original default of a 7-day daily series.
    const granularity = periodGranularity(q.range);
    const days = q.range === "30d" ? 30 : 7;
    const currency = q.currency ?? "idr";
    const metric = q.metric ?? "revenue";

    if (metric === "profit") {
      // There is no combined-PROFIT figure anywhere: only revenue has a
      // currency blend (`combinedRevenueByDay`/`PeriodRevenue.revenueIdrEquiv`,
      // both built on `Order.totalAmount`, which genuinely follows the order's
      // currency). Profit is derived from catalog-central IDR unitPrice/
      // costPrice per line, so a "combined profit" would have to be invented.
      // Falling back to the IDR series reports a real number under a slightly
      // narrower label instead; the card also hides the Combined option while
      // Profit is selected, so this is a backstop for a hand-written query
      // string, not the path a user clicks.
      const rows = granularity ? await profitByPeriod(prisma, granularity) : await profitByDay(prisma, days);
      return rows.map((r) => ({ day: r.day, value: currency === "usdt" ? r.profit_usdt : r.profit_idr }));
    }
    if (metric === "orders") {
      const rows = granularity ? await ordersByPeriod(prisma, granularity) : await ordersByDay(prisma, days);
      return rows.map((r) => ({ day: r.day, value: currency === "usdt" ? r.ordersUsdt : r.ordersIdr }));
    }
    if (granularity) {
      const rows = await revenueByPeriod(prisma, granularity);
      return rows.map((r) => ({
        day: r.day,
        value: currency === "combined" ? r.revenueIdrEquiv : currency === "usdt" ? r.revenue_usdt : r.revenue_idr,
      }));
    }
    if (currency === "combined") {
      const rows = await combinedRevenueByDay(prisma, days);
      return rows.map((r) => ({ day: r.day, value: r.revenueIdrEquiv }));
    }
    const rows = await revenueByDay(prisma, days);
    return rows.map((r) => ({ day: r.day, value: currency === "usdt" ? r.revenue_usdt : r.revenue_idr }));
  });
}
