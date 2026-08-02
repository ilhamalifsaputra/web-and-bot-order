import type { FastifyInstance } from "fastify";
import { Decimal } from "@app/core/money";
import { addDays } from "@app/core/datetime";
import { prisma, revenueByDay, topProducts, ordersByStatus, voucherUsage } from "@app/db";
import { currentAdmin } from "../../plugins/auth";

/** Quotes a CSV field per RFC 4180: wrap in double quotes if it contains a
 * comma, quote, or newline, doubling any embedded quotes. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(",") + "\r\n";
}

export default async function reportsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/reports", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const days = Math.min(Math.max(Number(q.days) || 30, 7), 90);

    const [daily, products, funnel, vouchers] = await Promise.all([
      revenueByDay(prisma, days),
      // Scoped to the same `days` window as the rest of this page (was
      // previously all-time — see task-42-report.md for why that changed).
      topProducts(prisma, addDays(new Date(), -days), 10),
      ordersByStatus(prisma),
      voucherUsage(prisma, 20),
    ]);

    const total30dIdr = daily.reduce((acc, d) => acc.plus(d.revenue_idr), new Decimal(0));
    const total30dUsdt = daily.reduce((acc, d) => acc.plus(d.revenue_usdt), new Decimal(0));

    return reply.send({
      daily,
      totalIdr: total30dIdr.toString(),
      totalUsdt: total30dUsdt.isZero() ? null : total30dUsdt.toString(),
      products,
      funnel,
      vouchers,
      days,
    });
  });

  // Exports the same revenue-by-day series the summary endpoint shows, as a
  // CSV download — mirrors /api/orders/export's pattern (routes/api/orders.ts).
  app.get("/api/reports/export", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const days = Math.min(Math.max(Number(q.days) || 30, 7), 90);
    const daily = await revenueByDay(prisma, days);

    const header = ["Date", "Revenue (IDR)", "Revenue (USDT)", "Orders"];
    let csv = csvRow(header);
    for (const d of daily) {
      csv += csvRow([d.day, d.revenue_idr, d.revenue_usdt, String(d.orders)]);
    }

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="reports.csv"');
    return reply.send(csv);
  });
}
