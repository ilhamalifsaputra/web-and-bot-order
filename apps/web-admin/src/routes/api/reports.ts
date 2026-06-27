import type { FastifyInstance } from "fastify";
import { Decimal } from "@app/core/money";
import { prisma, revenueByDay, topProducts, ordersByStatus, voucherUsage } from "@app/db";
import { currentAdmin } from "../../plugins/auth";

export default async function reportsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/reports", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const days = Math.min(Math.max(Number(q.days) || 30, 7), 90);

    const [daily, products, funnel, vouchers] = await Promise.all([
      revenueByDay(prisma, days),
      topProducts(prisma, 10),
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
}
