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
  getTicket,
  addTicketMessage,
  closeTicket,
  logAdminAction,
} from "@app/db";
import { csrfProtect } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

export default async function supportRoutes(app: FastifyInstance): Promise<void> {
  // GET /support and GET /support/:ticketId retired — now served by React SPA.

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
