/**
 * Read-only dashboard — port of routers/dashboard.py, plus the SLA action-queue
 * widgets from WEB.md roadmap §3 (stale verifications, pending-payment about to
 * expire, warranties expiring soon). The SLA block is also served as a fragment
 * at /partials/dashboard-sla so HTMX can poll-refresh it without a full reload.
 */
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { addDays, addMinutes } from "@app/core/datetime";
import { Decimal } from "@app/core/money";
import {
  prisma,
  type Db,
  resolveBotCredentials,
  resolveBinanceInternalConfig,
  botOverallStats,
  revenueSummary,
  lowStockDenominations,
  listPendingVerifications,
  listAuditLogs,
  listOrdersAgingInVerification,
  listExpiringPendingPayments,
  listOrderItemsExpiringWarranty,
  processedTxOutcomeCounts,
} from "@app/db";
import { currentAdmin } from "../plugins/auth";

// Action-queue thresholds. Kept as constants (not env) — sensible defaults for a
// single-operator dashboard; promote to config if an operator needs to tune them.
const STALE_VERIFICATION_HOURS = 12;
const EXPIRING_SOON_MINUTES = 15;
const WARRANTY_HORIZON_DAYS = 3;

/**
 * Flatten a {revenue_idr, revenue_usdt, orders} summary into template-friendly
 * primitives. Revenue is split per currency in the DB layer (reports.ts), so the
 * cards show IDR as the headline and surface USDT only when there actually is
 * USDT revenue — a Decimal is always truthy in Nunjucks, so the zero check must
 * happen here, not in the template.
 */
function shapeRevenue(r: { revenue_idr: Decimal; revenue_usdt: Decimal; orders: number }) {
  return {
    idr: r.revenue_idr.toString(),
    usdt: new Decimal(r.revenue_usdt).isZero() ? null : r.revenue_usdt.toString(),
    orders: r.orders,
  };
}

/** Gather the SLA action-queue lists shared by the page and its HTMX fragment. */
async function slaContext(db: Db) {
  const now = new Date();
  const stale = await listOrdersAgingInVerification(db, addMinutes(now, -STALE_VERIFICATION_HOURS * 60));
  const expiring = await listExpiringPendingPayments(db, now, addMinutes(now, EXPIRING_SOON_MINUTES));
  const warranty = await listOrderItemsExpiringWarranty(db, now, addDays(now, WARRANTY_HORIZON_DAYS));
  return {
    stale,
    expiring,
    warranty,
    stale_hours: STALE_VERIFICATION_HOURS,
    expiring_minutes: EXPIRING_SOON_MINUTES,
    warranty_days: WARRANTY_HORIZON_DAYS,
  };
}

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", { preHandler: currentAdmin }, async (req, reply) => {
    const now = new Date();
    const overall = await botOverallStats(prisma);
    const rev24h = await revenueSummary(prisma, addDays(now, -1));
    const rev7d = await revenueSummary(prisma, addDays(now, -7));
    const rev30d = await revenueSummary(prisma, addDays(now, -30));
    const lowStockRows = await lowStockDenominations(prisma, config.LOW_STOCK_THRESHOLD);
    const lowStock = lowStockRows.map((r) => ({ product: r.denomination, available: r.available }));
    const pending = await listPendingVerifications(prisma);
    const recentAudit = await listAuditLogs(prisma, { limit: 10 });
    const sla = await slaContext(prisma);
    // §16.3 bootstrap case: no bot token anywhere → the bot is off until an
    // admin fills it in Settings and restarts. Surface that loudly here.
    const creds = await resolveBotCredentials(prisma);

    // Surface money that arrived but didn't deliver (unmatched / delivery_failed).
    let binance: { unmatched: number; delivery_failed: number } | null = null;
    if ((await resolveBinanceInternalConfig(prisma)).enabled) {
      const counts = await processedTxOutcomeCounts(prisma);
      binance = { unmatched: counts.unmatched ?? 0, delivery_failed: counts.delivery_failed ?? 0 };
    }

    return reply.view("dashboard.njk", {
      admin: req.admin,
      active_nav: "/",
      overall,
      all_time: shapeRevenue({ ...overall, revenue_idr: overall.revenue_idr, revenue_usdt: overall.revenue_usdt, orders: 0 }),
      rev_24h: shapeRevenue(rev24h),
      rev_7d: shapeRevenue(rev7d),
      rev_30d: shapeRevenue(rev30d),
      low_stock: lowStock,
      low_stock_count: lowStock.length,
      low_stock_threshold: config.LOW_STOCK_THRESHOLD,
      pending_count: pending.length,
      recent_audit: recentAudit,
      sla,
      binance,
      bot_token_missing: creds.botToken === null,
    });
  });

  // HTMX poll target: re-renders just the SLA block.
  app.get("/partials/dashboard-sla", { preHandler: currentAdmin }, async (req, reply) => {
    const sla = await slaContext(prisma);
    return reply.view("_sla.njk", { admin: req.admin, sla });
  });
}
