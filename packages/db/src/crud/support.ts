/**
 * Support tickets + ticket messages — port of those sections of Python crud.py.
 */
import { TicketStatus, SenderType } from "@app/core/enums";
import type { Db } from "./_types";

export function createTicket(
  db: Db,
  userId: number,
  message: string,
  photoFileIds: string | null = null,
) {
  return db.supportTicket.create({ data: { userId, message, photoFileIds } });
}

export function getTicket(db: Db, ticketId: number) {
  return db.supportTicket.findUnique({ where: { id: ticketId } });
}

/** All non-closed tickets (OPEN + REPLIED), newest first. */
export function listOpenTickets(db: Db, limit = 50) {
  return db.supportTicket.findMany({
    where: { status: { not: TicketStatus.CLOSED } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Close a ticket; return the ticket owner's telegram_id (to notify) or null. */
export async function closeTicket(db: Db, ticketId: number): Promise<bigint | null> {
  const ticket = await db.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) return null;
  await db.supportTicket.update({
    where: { id: ticketId },
    data: { status: TicketStatus.CLOSED },
  });
  const user = await db.user.findUnique({ where: { id: ticket.userId } });
  return user ? user.telegramId : null;
}

/** Save admin reply; return customer's telegram_id (to DM) or null. */
export async function replyToTicket(
  db: Db,
  args: { ticketId: number; reply: string; adminDbId: number },
): Promise<bigint | null> {
  const ticket = await db.supportTicket.findUnique({
    where: { id: args.ticketId },
  });
  if (!ticket) return null;
  await db.supportTicket.update({
    where: { id: args.ticketId },
    data: {
      adminReply: args.reply,
      adminId: args.adminDbId,
      status: TicketStatus.REPLIED,
      repliedAt: new Date(),
    },
  });
  const user = await db.user.findUnique({ where: { id: ticket.userId } });
  return user ? user.telegramId : null;
}

/** Add a thread message and update the ticket's status accordingly. */
export async function addTicketMessage(
  db: Db,
  args: {
    ticketId: number;
    senderType: SenderType;
    senderId: number;
    content: string;
    photoFileIds?: string | null;
  },
) {
  const msg = await db.ticketMessage.create({
    data: {
      ticketId: args.ticketId,
      senderType: args.senderType,
      senderId: args.senderId,
      content: args.content,
      photoFileIds: args.photoFileIds ?? null,
    },
  });
  const ticket = await db.supportTicket.findUnique({
    where: { id: args.ticketId },
  });
  if (ticket) {
    if (args.senderType === SenderType.USER) {
      await db.supportTicket.update({
        where: { id: args.ticketId },
        data: { status: TicketStatus.OPEN },
      });
    } else {
      await db.supportTicket.update({
        where: { id: args.ticketId },
        data: { status: TicketStatus.REPLIED, repliedAt: new Date() },
      });
    }
  }
  return msg;
}

/** Last N messages for a ticket, chronological order. */
export async function listTicketMessages(db: Db, ticketId: number, limit = 10) {
  const rows = await db.ticketMessage.findMany({
    where: { ticketId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.reverse();
}

export function listUserTickets(db: Db, userId: number, limit = 10) {
  return db.supportTicket.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** REPLIED tickets whose replied_at is older than cutoff (auto-close job). */
export function listStaleRepliedTickets(db: Db, cutoff: Date) {
  return db.supportTicket.findMany({
    where: {
      status: TicketStatus.REPLIED,
      repliedAt: { not: null, lt: cutoff },
    },
  });
}
