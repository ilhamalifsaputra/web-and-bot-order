import type { FastifyInstance } from "fastify";
import { prisma, listAuditLogs, countAuditLogs } from "@app/db";
import { currentAdmin } from "../../plugins/auth";

const PAGE_SIZE = 100;

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default async function auditApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/audit", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;
    const adminId = q.admin_id && /^\d+$/.test(q.admin_id) ? Number(q.admin_id) : null;

    const filter = {
      adminId,
      action: q.action || null,
      targetType: q.target_type || null,
      since: parseDate(q.since),
      until: parseDate(q.until),
    };

    const [rows, total] = await Promise.all([
      listAuditLogs(prisma, { ...filter, limit: PAGE_SIZE, offset }),
      countAuditLogs(prisma, filter),
    ]);

    return reply.send({ rows, total, page, hasNext: offset + rows.length < total });
  });
}
