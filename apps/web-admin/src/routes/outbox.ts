/**
 * Notification outbox monitor — WEB.md roadmap §2.
 *
 * Surfaces notification_outbox (PENDING / SENT / FAILED) with attempts +
 * last_error, and lets the operator requeue a failed row. Delivery itself is
 * the notifier's job — retry only flips the row back to PENDING; the web NEVER
 * sends Telegram. Every retry is audited.
 */
import type { FastifyInstance } from "fastify";
import { logger } from "@app/core/logger";
import { prisma, retryNotification, logAdminAction } from "@app/db";
import { csrfProtect } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

export default async function outboxRoutes(app: FastifyInstance): Promise<void> {
  // GET /outbox retired — now served by React SPA via GET /api/outbox.

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
    logger.info(`Admin ${req.admin!.userId} requeued outbox notification ${id} for delivery via the web panel`);
    return redirectWithFlash(reply, "/outbox", "Notification requeued for delivery.", "success");
  });
}
