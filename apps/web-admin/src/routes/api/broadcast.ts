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
import { currentAdmin, csrfProtect } from "../../plugins/auth";

const MAX_MESSAGE = 4000;

export default async function broadcastApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/broadcast", { preHandler: currentAdmin }, async (req, reply) => {
    const counts: Record<string, number> = {};
    for (const s of BROADCAST_SEGMENTS) counts[s] = await countSegment(prisma, s);
    const history = await listBroadcasts(prisma, 30);
    return reply.send({ segments: BROADCAST_SEGMENTS, counts, history });
  });

  app.post("/api/broadcast", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const message = (body.message ?? "").trim();
    const segment = (body.segment ?? "").toUpperCase();
    const scheduleRaw = (body.scheduled_at ?? "").trim();

    if (!message) return reply.code(400).send({ error: "Message can't be empty." });
    if (message.length > MAX_MESSAGE) return reply.code(400).send({ error: `Message is too long (max ${MAX_MESSAGE}).` });
    if (!isBroadcastSegment(segment)) return reply.code(400).send({ error: "Pick a valid segment." });

    let scheduledAt: Date | null = null;
    if (scheduleRaw) {
      const d = new Date(scheduleRaw);
      if (Number.isNaN(d.getTime())) return reply.code(400).send({ error: "Invalid schedule time." });
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
    return reply.code(201).send({ broadcast: bc, total });
  });

  app.post("/api/broadcast/:id/cancel", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const ok = await cancelBroadcast(prisma, id);
    if (!ok) return reply.code(409).send({ error: "Only a pending broadcast can be cancelled." });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "broadcast_cancel",
      targetType: "broadcast",
      targetId: id,
    });
    return reply.send({ ok: true });
  });
}
