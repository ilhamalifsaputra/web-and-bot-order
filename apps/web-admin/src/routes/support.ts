/**
 * Support tickets — list, thread view, admin reply, close. Port of
 * routers/support.py.
 *
 * Replies are persisted as TicketMessage rows only; the web app never sends
 * Telegram messages (see migrate.md §4 / WEB.md). Web-authored replies are
 * recorded but not auto-delivered to the customer.
 */
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
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash, renderError } from "../flash";

export default async function supportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/support", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const tickets = await listOpenTickets(prisma, 100);
    return reply.view("support.njk", {
      admin: req.admin,
      active_nav: "/support",
      tickets,
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  app.get("/support/:ticketId", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    const ticket = await getTicket(prisma, ticketId);
    if (!ticket) {
      return renderError(reply, { statusCode: 404, title: "Not found", message: "Ticket not found." });
    }
    const messages = await listTicketMessages(prisma, ticketId, 100);
    const ticketUser = await getUser(prisma, ticket.userId);

    return reply.view("ticket_detail.njk", {
      admin: req.admin,
      active_nav: "/support",
      ticket,
      messages,
      ticket_user: ticketUser,
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  app.post("/support/:ticketId/reply", { preHandler: csrfProtect }, async (req, reply) => {
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    const content = ((req.body as Record<string, string>).content ?? "").trim();
    if (!content) return redirectWithFlash(reply, `/support/${ticketId}`, "Reply cannot be empty.", "error");
    if (!(await getTicket(prisma, ticketId))) {
      return redirectWithFlash(reply, "/support", "Ticket not found.", "error");
    }
    // Records the reply only; the web app never sends Telegram messages.
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
    return redirectWithFlash(
      reply,
      `/support/${ticketId}`,
      "Reply saved. Note: it is recorded but not auto-delivered over Telegram.",
      "info",
    );
  });

  app.post("/support/:ticketId/close", { preHandler: csrfProtect }, async (req, reply) => {
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    const result = await closeTicket(prisma, ticketId);
    if (result === null) return redirectWithFlash(reply, "/support", "Ticket not found.", "error");
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "ticket_close",
      targetType: "ticket",
      targetId: ticketId,
    });
    return redirectWithFlash(reply, "/support", `Ticket #${ticketId} closed.`, "success");
  });
}
