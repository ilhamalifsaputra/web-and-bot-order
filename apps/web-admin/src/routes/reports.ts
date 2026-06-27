/**
 * Reports & charts — WEB.md roadmap Tier 2 §7. Read-only analytics beyond the
 * dashboard's headline cards: daily revenue (30d), top products, voucher usage,
 * and the orders-by-status funnel. The revenue trend is a server-rendered SVG
 * sparkline — no client charting lib, keeping the "no build" rule.
 */
import type { FastifyInstance } from "fastify";
// Reports page migrated to React — see apps/web-admin/src/routes/api/reports.ts.
export default async function reportsRoutes(_app: FastifyInstance): Promise<void> {
  // GET /reports retired — now served by React SPA via GET /api/reports.
}
