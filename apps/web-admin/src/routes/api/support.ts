import type { FastifyInstance } from "fastify";
import { SenderType } from "@app/core/enums";
import {
  prisma,
  listOpenTickets,
  getTicket,
  listTicketMessages,
  getUser,
  addTicketMessage,
  closeTicket,
  assignTicket,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";

export default async function supportApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/support", { preHandler: currentAdmin }, async (req, reply) => {
    const tickets = await listOpenTickets(prisma, 100);
    return reply.send({ tickets });
  });

  app.get("/api/support/:ticketId", { preHandler: currentAdmin }, async (req, reply) => {
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    const ticket = await getTicket(prisma, ticketId);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found." });
    const [messages, ticketUser] = await Promise.all([
      listTicketMessages(prisma, ticketId, 100),
      getUser(prisma, ticket.userId),
    ]);
    return reply.send({ ticket, messages, user: ticketUser });
  });

  app.post("/api/support/:ticketId/reply", { preHandler: csrfProtect }, async (req, reply) => {
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    const content = ((req.body as Record<string, string>).content ?? "").trim();
    if (!content) return reply.code(400).send({ error: "Reply cannot be empty." });
    if (!(await getTicket(prisma, ticketId))) return reply.code(404).send({ error: "Ticket not found." });
    await addTicketMessage(prisma, {
      ticketId,
      senderType: SenderType.ADMIN,
      senderId: req.admin!.userId,
      content,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "ticket_reply",
      targetType: "ticket",
      targetId: ticketId,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/support/:ticketId/close", { preHandler: csrfProtect }, async (req, reply) => {
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    const result = await closeTicket(prisma, ticketId);
    if (result === null) return reply.code(404).send({ error: "Ticket not found." });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "ticket_close",
      targetType: "ticket",
      targetId: ticketId,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/support/:ticketId/assign", { preHandler: csrfProtect }, async (req, reply) => {
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    if (!Number.isInteger(ticketId)) return reply.code(400).send({ error: "Invalid ticket id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.adminId !== null && typeof body.adminId !== "number") {
      return reply.code(400).send({ error: "adminId must be a number or null." });
    }
    const adminId = body.adminId as number | null;

    if (!(await getTicket(prisma, ticketId))) return reply.code(404).send({ error: "Ticket not found." });

    let adminName: string | null = null;
    if (adminId !== null) {
      const assignee = await getUser(prisma, adminId);
      if (!assignee) return reply.code(400).send({ error: "Admin not found." });
      adminName = assignee.fullName ?? assignee.username ?? `Telegram ID ${assignee.telegramId}`;
    }

    await assignTicket(prisma, ticketId, adminId);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "ticket_assign",
      targetType: "ticket",
      targetId: ticketId,
      details: adminId !== null
        ? `Assigned ticket #${ticketId} to "${adminName}".`
        : `Unassigned ticket #${ticketId}.`,
    });
    return reply.send({ ok: true });
  });
}
