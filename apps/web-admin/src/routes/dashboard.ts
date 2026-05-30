/**
 * Read-only dashboard — port of routers/dashboard.py.
 */
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { addDays } from "@app/core/datetime";
import {
  prisma,
  botOverallStats,
  revenueSummary,
  lowStockProducts,
  listPendingVerifications,
  listAuditLogs,
} from "@app/db";
import { currentAdmin } from "../plugins/auth";

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
    });
  });
}
