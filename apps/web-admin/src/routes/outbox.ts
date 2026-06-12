/**
 * Notification outbox monitor — WEB.md roadmap §2.
 *
 * Surfaces notification_outbox (PENDING / SENT / FAILED) with attempts +
 * last_error, and lets the operator requeue a failed row. Delivery itself is
 * the notifier's job — retry only flips the row back to PENDING; the web NEVER
 * sends Telegram. Every retry is audited.
 */
import type { FastifyInstance } from "fastify";
import { NotificationStatus } from "@app/core/enums";
import { logger } from "@app/core/logger";
import {
  prisma,
  listNotifications,
  countNotifications,
  outboxStatusCounts,
  retryNotification,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

const PAGE_SIZE = 50;
const STATUS_VALUES = Object.values(NotificationStatus) as string[];

export default async function outboxRoutes(app: FastifyInstance): Promise<void> {
  app.get("/outbox", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const status = q.status && STATUS_VALUES.includes(q.status) ? q.status : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const rows = await listNotifications(prisma, { status, limit: PAGE_SIZE, offset });
    const total = await countNotifications(prisma, { status });
    const counts = await outboxStatusCounts(prisma);

    return reply.view("outbox.njk", {
      admin: req.admin,
      active_nav: "/outbox",
      rows,
      total,
      page,
      page_size: PAGE_SIZE,
      has_next: offset + rows.length < total,
      statuses: STATUS_VALUES,
      counts,
      f: { status: status ?? "" },
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  app.post("/outbox/:id/retry", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const ok = await retryNotification(prisma, id);
    if (!ok) {
      return redirectWithFlash(reply, "/outbox", "That notification no longer exists.", "error");
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "outbox_retry",
      targetType: "notification",
      targetId: id,
    });
    logger.info(`Outbox notification ${id} requeued via web by admin_id=${req.admin!.userId}`);
    return redirectWithFlash(reply, "/outbox", "Notification requeued for delivery.", "success");
  });
}
