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
 * primitives. Both currencies are null when zero (not just USDT) — a Decimal
 * is always truthy in Nunjucks, so the zero check must happen here, not in
 * the template. This lets `ui.dual_currency_value` lead with whichever
 * currency actually had revenue instead of always defaulting to a "Rp0"
 * headline for a period whose only sale was USDT.
 */
function shapeRevenue(r: { revenue_idr: Decimal; revenue_usdt: Decimal; orders: number }) {
  const idr = new Decimal(r.revenue_idr);
  const usdt = new Decimal(r.revenue_usdt);
  return {
    idr: idr.isZero() ? null : idr.toString(),
    usdt: usdt.isZero() ? null : usdt.toString(),
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
  // HTMX poll target: re-renders just the SLA block.
  app.get("/partials/dashboard-sla", { preHandler: currentAdmin }, async (req, reply) => {
    const sla = await slaContext(prisma);
    return reply.view("_sla.njk", { admin: req.admin, sla });
  });
}
