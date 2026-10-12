import type { FastifyInstance } from "fastify";
import { prisma, createSupportUpload, finalizeSupportUpload } from "@app/db";
import { supportMediaAvailable, supportMediaLimits, supportObjectUrl } from "@app/core/supportMedia";
import { ValidationError } from "@app/core/errors";
import { errorBody } from "@app/core/errorBody";
import { csrfProtect, currentAdmin } from "../../plugins/auth";

export async function supportMediaRoutes(app: FastifyInstance) {
  app.get("/api/support/media/options", { preHandler: currentAdmin }, async () => ({ enabled: await supportMediaAvailable(), ...supportMediaLimits() }));
  app.post<{ Body: { ticket_id: number; draft_id: string; filename: string; mime: string; bytes: number } }>("/api/support/uploads", { preHandler: csrfProtect }, async (req, reply) => {
    const b = req.body;
    if (!b || !Number.isSafeInteger(b.ticket_id) || typeof b.draft_id !== "string" || typeof b.filename !== "string" || typeof b.mime !== "string" || !Number.isSafeInteger(b.bytes)) return reply.code(400).send({ error: "Invalid upload request." });
    const ticket = await prisma.supportTicket.findFirst({ where: { id: b.ticket_id, status: { not: "CLOSED" } } });
    if (!ticket) return reply.code(404).send({ error: "Ticket unavailable." });
    try { return await createSupportUpload(prisma, { ownerId: req.admin!.userId, ticketId: ticket.id, draftId: b.draft_id, filename: b.filename, mime: b.mime, bytes: b.bytes }); }
    catch (e) { if (e instanceof ValidationError) return reply.code(400).send(errorBody(e)); throw e; }
  });
  app.post<{ Params: { id: string } }>("/api/support/uploads/:id/finalize", { preHandler: csrfProtect }, async (req, reply) => {
    try { return await finalizeSupportUpload(prisma, req.params.id, req.admin!.userId); }
    catch (e) { if (e instanceof ValidationError) return reply.code(400).send(errorBody(e)); throw e; }
  });
  app.post<{ Params: { id: string } }>("/api/support/uploads/:id/abort", { preHandler: csrfProtect }, async (req) => {
    await prisma.supportAttachment.updateMany({ where: { id: req.params.id, ownerId: req.admin!.userId, attachedAt: null }, data: { status: "REJECTED", expiresAt: new Date() } });
    return { ok: true };
  });
  app.get<{ Params: { id: string; filename: string } }>("/api/support/media/:id/:filename", { preHandler: currentAdmin }, async (req, reply) => {
    const row = await prisma.supportAttachment.findFirst({ where: { id: req.params.id, ticketId: { not: null }, attachedAt: { not: null }, status: "READY" } });
    if (!row) return reply.code(404).send({ error: "Attachment unavailable." });
    reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer");
    return reply.redirect(await supportObjectUrl(row.storageKey, "GET", undefined, undefined, row.bucket));
  });
}
