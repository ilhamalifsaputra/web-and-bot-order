/**
 * Read-only dashboard — port of routers/dashboard.py, plus the SLA action-queue
 * widgets from WEB.md roadmap §3 (stale verifications, pending-payment about to
 * expire, warranties expiring soon). The SLA block is also served as a fragment
 * at /partials/dashboard-sla so HTMX can poll-refresh it without a full reload.
 */
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { addDays, addMinutes } from "@app/core/datetime";
import {
  prisma,
  type Db,
  botOverallStats,
  revenueSummary,
  lowStockProducts,
  listPendingVerifications,
  listAuditLogs,
  listOrdersAgingInVerification,
  listExpiringPendingPayments,
  listOrderItemsExpiringWarranty,
} from "@app/db";
import { currentAdmin } from "../plugins/auth";

// Action-queue thresholds. Kept as constants (not env) — sensible defaults for a
// single-operator dashboard; promote to config if an operator needs to tune them.
const STALE_VERIFICATION_HOURS = 12;
const EXPIRING_SOON_MINUTES = 15;
const WARRANTY_HORIZON_DAYS = 3;

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
    const lowStock = await lowStockProducts(prisma, config.LOW_STOCK_THRESHOLD);
    const pending = await listPendingVerifications(prisma);
    const recentAudit = await listAuditLogs(prisma, { limit: 10 });
    const sla = await slaContext(prisma);

    return reply.view("dashboard.njk", {
      admin: req.admin,
      active_nav: "/",
      overall,
      rev_24h: rev24h,
      rev_7d: rev7d,
      rev_30d: rev30d,
      low_stock: lowStock,
      low_stock_count: lowStock.length,
      low_stock_threshold: config.LOW_STOCK_THRESHOLD,
      pending_count: pending.length,
      recent_audit: recentAudit,
      sla,
    });
  });

  // HTMX poll target: re-renders just the SLA block.
  app.get("/partials/dashboard-sla", { preHandler: currentAdmin }, async (req, reply) => {
    const sla = await slaContext(prisma);
    return reply.view("_sla.njk", { admin: req.admin, sla });
  });
}
