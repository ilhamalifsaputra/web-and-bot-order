import type { FastifyInstance } from "fastify";
import { NotificationStatus } from "@app/core/enums";
import { prisma, listNotifications, countNotifications, outboxStatusCounts, retryNotification, getNotification, logAdminAction } from "@app/db";
import { logger } from "@app/core/logger";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { displayDateTime } from "../../dateDisplay";

const PAGE_SIZE = 50;
const STATUS_VALUES = Object.values(NotificationStatus) as string[];

export default async function outboxApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/outbox", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const status = q.status && STATUS_VALUES.includes(q.status) ? q.status : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const [rows, total, counts] = await Promise.all([
      listNotifications(prisma, { status, limit: PAGE_SIZE, offset }),
      countNotifications(prisma, { status }),
      outboxStatusCounts(prisma),
    ]);

    const rowsWithDisplay = rows.map((r) => ({
      ...r,
      createdAtDisplay: displayDateTime(r.createdAt),
      sentAtDisplay: displayDateTime(r.sentAt),
    }));
    return reply.send({ rows: rowsWithDisplay, total, page, hasNext: offset + rows.length < total, counts });
  });

  // JSON counterpart of the legacy POST /outbox/:id/retry (routes/outbox.ts),
  // which 303-redirects to a retired GET /outbox and breaks fetch()'s
  // res.json() once the SPA catch-all serves HTML there instead. The web
  // panel's React page calls this one; the legacy route is left in place
  // (still covered by test/web.test.ts) since nothing requires removing it.
  app.post("/api/outbox/:id/retry", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = await getNotification(prisma, id);
    const ok = await retryNotification(prisma, id);
    if (!ok) return reply.code(404).send({ error: "That notification no longer exists." });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "outbox_retry",
      targetType: "notification",
      targetId: id,
      details: `Requeued a ${existing?.event ?? "notification"} notification for delivery.`,
    });
    logger.info(`Admin ${req.admin!.userId} requeued outbox notification ${id} for delivery via the web panel`);
    return reply.send({ ok: true });
  });
}
