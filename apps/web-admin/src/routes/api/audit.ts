import type { FastifyInstance } from "fastify";
import { prisma, listAuditLogs, countAuditLogs } from "@app/db";
import { currentAdmin } from "../../plugins/auth";
import { displayDateTime } from "../../dateDisplay";

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
    const customerId = q.customer_id && /^\d+$/.test(q.customer_id) ? Number(q.customer_id) : null;
    // Phase H's customer-action audit trail (logCustomerAction) writes rows
    // into this same table with actorType: "CUSTOMER". Every existing row and
    // every existing logAdminAction call site predates that, so this route's
    // own default has to keep meaning "admin activity only" — otherwise every
    // order/ticket a customer creates would flood the 100-per-page admin
    // review surface (final whole-branch review, finding I-1). "ALL" is the
    // explicit opt-in to see both actor kinds; any other value (e.g.
    // "CUSTOMER") passes straight through as an exact-match filter.
    const actorTypeParam = q.actor_type ? q.actor_type.toUpperCase() : "ADMIN";
    const actorType = actorTypeParam === "ALL" ? null : actorTypeParam;

    const filter = {
      adminId,
      action: q.action || null,
      targetType: q.target_type || null,
      since: parseDate(q.since),
      until: parseDate(q.until),
      actorType,
      customerId,
    };

    const [rows, total] = await Promise.all([
      listAuditLogs(prisma, { ...filter, limit: PAGE_SIZE, offset }),
      countAuditLogs(prisma, filter),
    ]);

    // telegramUserId is a Prisma BigInt column — reply.send()'s JSON
    // serialization (no response schema on this route) throws on a raw
    // BigInt, so it must be stringified before it reaches the wire, same
    // convention as apps/web-admin/src/routes/api/users.ts:185.
    const rowsWithDisplay = rows.map((r) => ({
      ...r,
      telegramUserId: r.telegramUserId != null ? r.telegramUserId.toString() : null,
      createdAtDisplay: displayDateTime(r.createdAt),
    }));
    return reply.send({ rows: rowsWithDisplay, total, page, hasNext: offset + rows.length < total });
  });
}
