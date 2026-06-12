/**
 * Reports & charts — WEB.md roadmap Tier 2 §7. Read-only analytics beyond the
 * dashboard's headline cards: daily revenue (30d), top products, voucher usage,
 * and the orders-by-status funnel. The revenue trend is a server-rendered SVG
 * sparkline — no client charting lib, keeping the "no build" rule.
 */
import type { FastifyInstance } from "fastify";
import { Decimal } from "@app/core/money";
import {
  prisma,
  revenueByDay,
  topProducts,
  ordersByStatus,
  voucherUsage,
  type DayRevenue,
} from "@app/db";
import { currentAdmin } from "../plugins/auth";

/** Build an SVG polyline path for the daily-revenue series in a viewBox of
 * WxH. Returns the points string plus the area path for a subtle fill. */
function sparkline(series: DayRevenue[], width = 600, height = 120) {
  const vals = series.map((d) => new Decimal(d.revenue).toNumber());
  const max = Math.max(1, ...vals);
  const n = vals.length;
  const dx = n > 1 ? width / (n - 1) : 0;
  const pts = vals.map((v, i) => {
    const x = +(i * dx).toFixed(2);
    const y = +(height - (v / max) * (height - 8) - 4).toFixed(2);
    return { x, y };
  });
  const line = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const area = pts.length
    ? `0,${height} ${line} ${pts[pts.length - 1]!.x},${height}`
    : "";
  return { line, area, width, height, max };
}

export default async function reportsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/reports", { preHandler: currentAdmin }, async (req, reply) => {
    const daily = await revenueByDay(prisma, 30);
    const spark = sparkline(daily);
    const total30d = daily.reduce((acc, d) => acc.plus(d.revenue), new Decimal(0));
    const products = await topProducts(prisma, 10);
    const funnel = await ordersByStatus(prisma);
    const vouchers = await voucherUsage(prisma, 20);

    return reply.view("reports.njk", {
      admin: req.admin,
      active_nav: "/reports",
      daily,
      spark,
      total_30d: total30d.toString(),
      products,
      funnel,
      vouchers,
    });
  });
}
