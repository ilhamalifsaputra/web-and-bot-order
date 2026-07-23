import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  prisma,
  BROADCAST_SEGMENTS,
  isBroadcastSegment,
  countSegment,
  createBroadcast,
  listBroadcasts,
  cancelBroadcast,
  queueDraftBroadcast,
  deleteBroadcast,
  logAdminAction,
} from "@app/db";
import { localize } from "@app/core/datetime";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { UPLOADS_DIR } from "../../paths";
import { displayDateTime } from "../../dateDisplay";

const MAX_MESSAGE = 4000;
const MAX_CAPTION = 1024; // Telegram's photo caption limit
const BROADCAST_IMAGE_RE = /^\/uploads\/broadcasts\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/;

export default async function broadcastApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/broadcast", { preHandler: currentAdmin }, async (req, reply) => {
    const counts: Record<string, number> = {};
    for (const s of BROADCAST_SEGMENTS) counts[s] = await countSegment(prisma, s);
    const history = await listBroadcasts(prisma, 30);
    const historyWithDisplay = history.map((b) => ({ ...b, scheduledAtDisplay: displayDateTime(b.scheduledAt) }));
    return reply.send({ segments: BROADCAST_SEGMENTS, counts, history: historyWithDisplay });
  });

  app.post("/api/broadcast", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = String(body.message ?? "").trim();
    const segment = String(body.segment ?? "").toUpperCase();
    const scheduleRaw = String(body.scheduled_at ?? "").trim();
    const imageUrlRaw = String(body.image_url ?? "").trim();
    const isDraft = body.draft === true;

    let webImageUrl: string | null = null;
    if (imageUrlRaw) {
      if (!BROADCAST_IMAGE_RE.test(imageUrlRaw)) {
        return reply.code(400).send({ error: "Invalid image reference." });
      }
      const filename = imageUrlRaw.slice("/uploads/broadcasts/".length);
      const onDisk = await stat(join(UPLOADS_DIR, "broadcasts", filename)).then(() => true).catch(() => false);
      if (!onDisk) return reply.code(400).send({ error: "Attached image was not found — please re-upload." });
      webImageUrl = imageUrlRaw;
    }

    if (!message) return reply.code(400).send({ error: "Message can't be empty." });
    const maxLen = webImageUrl ? MAX_CAPTION : MAX_MESSAGE;
    if (message.length > maxLen) {
      return reply.code(400).send({
        error: webImageUrl
          ? `Message is too long for a photo caption (max ${MAX_CAPTION}) — shorten it or remove the image.`
          : `Message is too long (max ${MAX_MESSAGE}).`,
      });
    }
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
      webImageUrl,
      status: isDraft ? "DRAFT" : "PENDING",
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: isDraft ? "broadcast_draft_save" : "broadcast_enqueue",
      targetType: "broadcast",
      targetId: bc.id,
      details: isDraft
        ? `Saved a draft broadcast to ${total} recipient(s) in segment "${segment}"${webImageUrl ? " with an attached image" : ""}.`
        : `${scheduledAt ? "Scheduled" : "Queued"} a broadcast to ${total} recipient(s) in segment "${segment}"${webImageUrl ? " with an attached image" : ""}${scheduledAt ? ` for ${localize(scheduledAt)}` : ""}.`,
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

  app.post("/api/broadcast/:id/queue", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const ok = await queueDraftBroadcast(prisma, id);
    if (!ok) return reply.code(409).send({ error: "Only a draft can be queued to send." });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "broadcast_queue_draft",
      targetType: "broadcast",
      targetId: id,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/broadcast/:id/delete", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const ok = await deleteBroadcast(prisma, id);
    if (!ok) return reply.code(409).send({ error: "Only a draft can be deleted." });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "broadcast_delete_draft",
      targetType: "broadcast",
      targetId: id,
    });
    return reply.send({ ok: true });
  });
}
