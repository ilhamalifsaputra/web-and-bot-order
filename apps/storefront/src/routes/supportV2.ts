import type { FastifyInstance } from "fastify";
import { SUPPORT_CATEGORIES, supportIssue, SUPPORT_MIN_DESCRIPTION, SUPPORT_MAX_TEXT } from "@app/core/supportCatalog";
import { supportMediaAvailable, supportMediaLimits, supportObjectUrl } from "@app/core/supportMedia";
import { t } from "@app/core/i18n";
import { ValidationError } from "@app/core/errors";
import { errorBody } from "@app/core/errorBody";
import { prisma, createTicket, getOrderByCodeFull, getOpenTicketForOrder, createSupportUpload, finalizeSupportUpload, logCustomerAction } from "@app/db";
import { requireCustomer, csrfHeaderOk } from "./apiAccount";

export async function supportV2Routes(app: FastifyInstance) {
  app.get("/account/support/options", async (req, reply) => {
    if (!await requireCustomer(req, reply)) return;
    return { categories: SUPPORT_CATEGORIES, media: { enabled: await supportMediaAvailable(), ...supportMediaLimits() } };
  });
  app.post<{ Body: { category?: string; issue?: string; description?: string; order_code?: string; request_id?: string; attachment_ids?: string[] } }>("/account/support/v2", async (req, reply) => {
    const customer = await requireCustomer(req, reply); if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    const body = req.body ?? {};
    if (typeof body.request_id !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.request_id)) return reply.code(400).send({ error: "helpdesk.invalid_request" });
    const previous = await prisma.supportTicket.findUnique({ where: { userId_requestKey: { userId: customer.userId, requestKey: body.request_id } } });
    if (previous) return { ok: true, ticket_id: previous.id, ticket_number: previous.ticketNumber };
    const issue = supportIssue(String(body.category ?? ""), String(body.issue ?? ""));
    if (!issue) return reply.code(400).send({ error: "helpdesk.issue_required" });
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (description.length < SUPPORT_MIN_DESCRIPTION || description.length > SUPPORT_MAX_TEXT) return reply.code(400).send({ error: "helpdesk.description_quality" });
    const ids = body.attachment_ids ?? [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return reply.code(400).send({ error: "helpdesk.invalid_request" });
    let orderId: number | null = null;
    if (body.order_code && issue.order) {
      const order = await getOrderByCodeFull(prisma, String(body.order_code));
      if (!order || order.userId !== customer.userId) return reply.code(400).send({ error: "error.order_not_found" });
      orderId = order.id;
      const duplicate = await getOpenTicketForOrder(prisma, orderId);
      if (duplicate) return { ok: false, duplicate: true, ticket_id: duplicate.id };
    }
    try {
      const ticket = await createTicket(prisma, customer.userId, description, null, null, orderId, { category: issue.category, subcategory: issue.issue, subject: t(issue.labelKey, customer.user.language ?? "id"), requestKey: body.request_id, attachmentIds: ids, dedupeOrder: true });
      await logCustomerAction(prisma, { customerId: customer.userId, channel: "WEB", action: "ticket_create", targetType: "ticket", targetId: ticket.id, details: "Created a support ticket via the help center." });
      return { ok: true, ticket_id: ticket.id, ticket_number: ticket.ticketNumber };
    } catch (e) { if (e instanceof ValidationError) return reply.code(400).send(errorBody(e)); throw e; }
  });
  app.post<{ Body: { draft_id: string; ticket_id?: number; filename: string; mime: string; bytes: number } }>("/account/support/uploads", async (req, reply) => {
    const customer = await requireCustomer(req, reply); if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    const b = req.body;
    if (!b || typeof b.draft_id !== "string" || typeof b.filename !== "string" || typeof b.mime !== "string" || !Number.isSafeInteger(b.bytes)) return reply.code(400).send({ error: "helpdesk.invalid_request" });
    if (b.ticket_id !== undefined && (!Number.isSafeInteger(b.ticket_id) || b.ticket_id <= 0)) return reply.code(400).send({ error: "helpdesk.invalid_request" });
    if (b.ticket_id) {
      const ticket = await prisma.supportTicket.findFirst({ where: { id: b.ticket_id, userId: customer.userId, status: { not: "CLOSED" } } });
      if (!ticket) return reply.code(404).send({ error: "not_found" });
    }
    try { return await createSupportUpload(prisma, { ownerId: customer.userId, draftId: b.draft_id, ticketId: b.ticket_id, filename: b.filename, mime: b.mime, bytes: b.bytes }); }
    catch (e) { if (e instanceof ValidationError) return reply.code(400).send(errorBody(e)); throw e; }
  });
  app.post<{ Params: { id: string } }>("/account/support/uploads/:id/finalize", async (req, reply) => {
    const customer = await requireCustomer(req, reply); if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    try { return await finalizeSupportUpload(prisma, req.params.id, customer.userId); }
    catch (e) { if (e instanceof ValidationError) return reply.code(400).send(errorBody(e)); throw e; }
  });
  app.post<{ Params: { id: string } }>("/account/support/uploads/:id/abort", async (req, reply) => {
    const customer = await requireCustomer(req, reply); if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    await prisma.supportAttachment.updateMany({ where: { id: req.params.id, ownerId: customer.userId, attachedAt: null }, data: { status: "REJECTED", expiresAt: new Date() } });
    return { ok: true };
  });
  app.get<{ Params: { id: string; filename: string } }>("/account/support/media/:id/:filename", async (req, reply) => {
    const customer = await requireCustomer(req, reply); if (!customer) return;
    const row = await prisma.supportAttachment.findFirst({ where: { id: req.params.id, status: "READY", ticket: { userId: customer.userId }, OR: [{ messageId: null }, { message: { internal: false } }] } });
    if (!row) return reply.code(404).send({ error: "not_found" });
    reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer");
    return reply.redirect(await supportObjectUrl(row.storageKey, "GET", undefined, undefined, row.bucket));
  });
}
