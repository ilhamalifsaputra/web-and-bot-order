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
}
