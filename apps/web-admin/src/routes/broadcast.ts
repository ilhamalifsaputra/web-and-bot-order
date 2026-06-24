/**
 * Broadcast composer — WEB.md roadmap Tier 3 §12. Compose + segment + schedule,
 * then ENQUEUE to the broadcasts table. The web NEVER sends Telegram — the
 * order-bot drains the queue (see jobs/index.ts drainBroadcasts). Every enqueue
 * is audited.
 */
import type { FastifyInstance } from "fastify";
import {
  prisma,
  BROADCAST_SEGMENTS,
  isBroadcastSegment,
  countSegment,
  createBroadcast,
  listBroadcasts,
  cancelBroadcast,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

const MAX_MESSAGE = 4000;

export default async function broadcastRoutes(app: FastifyInstance): Promise<void> {
  app.get("/broadcast", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const counts: Record<string, number> = {};
    for (const s of BROADCAST_SEGMENTS) counts[s] = await countSegment(prisma, s);
    const history = await listBroadcasts(prisma, 30);

    return reply.view("broadcast.njk", {
      admin: req.admin,
      active_nav: "/broadcast",
      segments: BROADCAST_SEGMENTS,
      counts,
      history,
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  app.post("/broadcast", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const message = (body.message ?? "").trim();
    const segment = (body.segment ?? "").toUpperCase();
    const scheduleRaw = (body.scheduled_at ?? "").trim();

    if (!message) {
      return redirectWithFlash(reply, "/broadcast", "Message can't be empty.", "error");
    }
    if (message.length > MAX_MESSAGE) {
      return redirectWithFlash(reply, "/broadcast", `Message is too long (max ${MAX_MESSAGE}).`, "error");
    }
    if (!isBroadcastSegment(segment)) {
      return redirectWithFlash(reply, "/broadcast", "Pick a valid segment.", "error");
    }
    let scheduledAt: Date | null = null;
    if (scheduleRaw) {
      const d = new Date(scheduleRaw);
      if (Number.isNaN(d.getTime())) {
        return redirectWithFlash(reply, "/broadcast", "Invalid schedule time.", "error");
      }
      scheduledAt = d;
    }

    const total = await countSegment(prisma, segment);
    const bc = await createBroadcast(prisma, {
      message,
      segment,
      scheduledAt,
      createdById: req.admin!.userId,
      total,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "broadcast_enqueue",
      targetType: "broadcast",
      targetId: bc.id,
      details: `${scheduledAt ? "Scheduled" : "Queued"} a broadcast to ${total} recipient(s) in segment "${segment}"${scheduledAt ? ` for ${scheduledAt.toISOString()}` : ""}.`,
    });
    const when = scheduledAt ? "scheduled" : "queued";
    return redirectWithFlash(reply, "/broadcast", `Broadcast ${when} for ${total} recipient(s). The bot will deliver it.`, "success");
  });

  app.post("/broadcast/:id/cancel", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const ok = await cancelBroadcast(prisma, id);
    if (!ok) {
      return redirectWithFlash(reply, "/broadcast", "Only a pending broadcast can be cancelled.", "error");
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "broadcast_cancel",
      targetType: "broadcast",
      targetId: id,
    });
    return redirectWithFlash(reply, "/broadcast", "Broadcast cancelled.", "success");
  });
}
