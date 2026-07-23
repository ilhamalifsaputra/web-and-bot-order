/**
 * Support tickets + ticket messages — port of those sections of Python crud.py.
 */
import type { Prisma } from "@prisma/client";
import { TicketStatus, SenderType } from "@app/core/enums";
import { addDays } from "@app/core/datetime";
import type { Db } from "./_types";

export function createTicket(
  db: Db,
  userId: number,
  message: string,
  photoFileIds: string | null = null,
  attachmentUrls: string | null = null,
  orderId: number | null = null,
) {
  return db.supportTicket.create({ data: { userId, message, photoFileIds, attachmentUrls, orderId } });
}

export function getTicket(db: Db, ticketId: number) {
  return db.supportTicket.findUnique({ where: { id: ticketId }, include: { user: true, admin: true } });
}

/** Ticket + its linked order (items with denomination, voucher) when one is
 * set — a single query, `order: null` when the ticket isn't linked. Used by
 * the storefront ticket detail page's Order/Product Summary sidebar; the
 * admin route and the reply/close/reopen ownership checks keep using the
 * lighter `getTicket` since they don't need the join. */
export function getTicketWithOrder(db: Db, ticketId: number) {
  return db.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      order: {
        include: { items: { include: { product: true } }, voucher: true },
      },
    },
  });
}

/** All non-closed tickets (OPEN + REPLIED), newest first. Used by
 * apps/order-bot's admin ticket list — do not change its shape/behavior,
 * the web-admin queue uses `listTickets` instead. */
export function listOpenTickets(db: Db, limit = 50) {
  return db.supportTicket.findMany({
    where: { status: { not: TicketStatus.CLOSED } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// ---- Operational queue (web-admin) ----------------------------------------

/** A ticket is "overdue" once it's sat unresolved (OPEN/REPLIED) this long
 * since its last status change — the web-admin queue's SLA signal. Not
 * configurable today; a hardcoded, documented business rule rather than a
 * fabricated one. */
export const OVERDUE_THRESHOLD_HOURS = 24;

export function overdueCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - OVERDUE_THRESHOLD_HOURS * 60 * 60 * 1000);
}

/** True if this ticket is currently active (not resolved/closed) and has sat
 * past the overdue threshold since its last status change. */
export function isTicketOverdue(
  ticket: { status: string; lastStatusChangeAt: Date },
  now: Date = new Date(),
): boolean {
  if (ticket.status !== TicketStatus.OPEN && ticket.status !== TicketStatus.REPLIED) return false;
  return ticket.lastStatusChangeAt.getTime() < overdueCutoff(now).getTime();
}

export interface TicketFilter {
  status?: string | string[] | null;
  priority?: string | string[] | null;
  category?: string | string[] | null;
  /** number = assigned to that admin id; "unassigned" = adminId is null. */
  assignedAdminId?: number | "unassigned" | null;
  since?: Date | null;
  until?: Date | null;
  /** Free-text search across the ticket message + customer identity fields. */
  q?: string | null;
}

function ticketWhere(f: TicketFilter): Prisma.SupportTicketWhereInput {
  const where: Prisma.SupportTicketWhereInput = {};
  if (f.status != null) {
    where.status = Array.isArray(f.status) ? { in: f.status } : f.status;
  }
  if (f.priority != null) {
    where.priority = Array.isArray(f.priority) ? { in: f.priority } : f.priority;
  }
  if (f.category != null) {
    where.category = Array.isArray(f.category) ? { in: f.category } : f.category;
  }
  if (f.assignedAdminId === "unassigned") {
    where.adminId = null;
  } else if (typeof f.assignedAdminId === "number") {
    where.adminId = f.assignedAdminId;
  }
  if (f.since != null || f.until != null) {
    where.createdAt = {};
    if (f.since != null) where.createdAt.gte = f.since;
    if (f.until != null) where.createdAt.lte = f.until;
  }
  if (f.q) {
    const term = f.q.trim();
    const or: Prisma.SupportTicketWhereInput[] = [
      { message: { contains: term } },
      { user: { username: { contains: term } } },
      { user: { fullName: { contains: term } } },
      { user: { loginUsername: { contains: term } } },
    ];
    where.OR = or;
  }
  return where;
}

export function listTickets(db: Db, opts: TicketFilter & { limit?: number; offset?: number } = {}) {
  return db.supportTicket.findMany({
    where: ticketWhere(opts),
    include: { user: true, admin: true },
    orderBy: { createdAt: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 50,
  });
}

export function countTickets(db: Db, opts: TicketFilter = {}) {
  return db.supportTicket.count({ where: ticketWhere(opts) });
}

/** Aggregate counts for the Tickets page's KPI row — always reads the whole
 * queue, ignoring whatever list filters are active (same "store-wide
 * snapshot" convention as /api/orders/kpis). */
export async function ticketKpis(db: Db) {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  const [open, waitingCustomer, resolved, unassigned, closedToday, overdue] = await Promise.all([
    db.supportTicket.count({ where: { status: TicketStatus.OPEN } }),
    db.supportTicket.count({ where: { status: TicketStatus.REPLIED } }),
    db.supportTicket.count({ where: { status: TicketStatus.RESOLVED } }),
    db.supportTicket.count({
      where: { adminId: null, status: { in: [TicketStatus.OPEN, TicketStatus.REPLIED] } },
    }),
    db.supportTicket.count({ where: { closedAt: { gte: startOfToday } } }),
    db.supportTicket.count({
      where: {
        status: { in: [TicketStatus.OPEN, TicketStatus.REPLIED] },
        lastStatusChangeAt: { lt: overdueCutoff() },
      },
    }),
  ]);

  return { open, waitingCustomer, resolved, unassigned, closedToday, overdue };
}

/**
 * Close a ticket; return the ticket owner's telegram_id (to notify) or null.
 * Atomic conditional claim — `count===1` means THIS call is the one that
 * actually flipped it, so a double-tap "Close" can never fire two DMs to the
 * buyer (Bot-3 fix, security audit 2026-06-23).
 */
export async function closeTicket(db: Db, ticketId: number): Promise<bigint | null> {
  const res = await db.supportTicket.updateMany({
    where: { id: ticketId, status: { not: TicketStatus.CLOSED } },
    data: { status: TicketStatus.CLOSED, closedAt: new Date(), lastStatusChangeAt: new Date() },
  });
  if (res.count === 0) return null;
  const ticket = await db.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) return null;
  const user = await db.user.findUnique({ where: { id: ticket.userId } });
  return user ? user.telegramId : null;
}

/** Customer self-close ("Issue Solved"). Same atomic conditional guard as
 * closeTicket, but the caller (the route) already verified ownership via
 * getTicket before calling this — this function only guards against a
 * double-tap / race with an admin closing the same ticket concurrently.
 * Returns false when there was nothing to close. */
export async function closeTicketByUser(db: Db, ticketId: number): Promise<boolean> {
  const res = await db.supportTicket.updateMany({
    where: { id: ticketId, status: { not: TicketStatus.CLOSED } },
    data: { status: TicketStatus.CLOSED, closedAt: new Date() },
  });
  return res.count === 1;
}

/** Mark a ticket RESOLVED — distinct from CLOSED (still visible/reopenable,
 * just no longer needing staff attention). Same double-tap-safe conditional
 * claim shape as closeTicket. Returns true iff this call performed the
 * transition. */
export async function resolveTicket(db: Db, ticketId: number): Promise<boolean> {
  const now = new Date();
  const res = await db.supportTicket.updateMany({
    where: { id: ticketId, status: { notIn: [TicketStatus.RESOLVED, TicketStatus.CLOSED] } },
    data: { status: TicketStatus.RESOLVED, resolvedAt: now, lastStatusChangeAt: now },
  });
  return res.count === 1;
}

/** How long after closedAt a customer can still self-reopen a ticket before
 * being told to open a new one instead. */
export const TICKET_REOPEN_WINDOW_DAYS = 7;

export type ReopenFailureReason = "not_closed" | "window_expired";

/** Reopen a CLOSED ticket back to OPEN, only within TICKET_REOPEN_WINDOW_DAYS
 * of closedAt. The caller (the route) already verified ownership via
 * getTicket before calling this. */
export async function reopenTicket(
  db: Db,
  ticketId: number,
): Promise<{ ok: true } | { ok: false; reason: ReopenFailureReason }> {
  const ticket = await db.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket || ticket.status !== TicketStatus.CLOSED || !ticket.closedAt) {
    return { ok: false, reason: "not_closed" };
  }
  if (addDays(ticket.closedAt, TICKET_REOPEN_WINDOW_DAYS).getTime() < Date.now()) {
    return { ok: false, reason: "window_expired" };
  }
  await db.supportTicket.update({
    where: { id: ticketId },
    data: { status: TicketStatus.OPEN, closedAt: null },
  });
  return { ok: true };
}

/** Reopen a CLOSED ticket back to OPEN (admin action — no bot equivalent, no
 * time window; distinct from the customer-facing `reopenTicket` above).
 * Returns true iff this call performed the transition. */
export async function reopenTicketAdmin(db: Db, ticketId: number): Promise<boolean> {
  const res = await db.supportTicket.updateMany({
    where: { id: ticketId, status: TicketStatus.CLOSED },
    data: { status: TicketStatus.OPEN, closedAt: null, lastStatusChangeAt: new Date() },
  });
  return res.count === 1;
}

/** Admin triage: set priority and/or category. No status/timestamp side effects. */
export function classifyTicket(
  db: Db,
  ticketId: number,
  args: { priority?: string; category?: string | null },
) {
  const data: Prisma.SupportTicketUpdateInput = {};
  if (args.priority !== undefined) data.priority = args.priority;
  if (args.category !== undefined) data.category = args.category;
  return db.supportTicket.update({ where: { id: ticketId }, data });
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
    attachmentUrls?: string | null;
  },
) {
  const msg = await db.ticketMessage.create({
    data: {
      ticketId: args.ticketId,
      senderType: args.senderType,
      senderId: args.senderId,
      content: args.content,
      photoFileIds: args.photoFileIds ?? null,
      attachmentUrls: args.attachmentUrls ?? null,
    },
  });
  const ticket = await db.supportTicket.findUnique({
    where: { id: args.ticketId },
  });
  if (ticket) {
    const now = new Date();
    if (args.senderType === SenderType.USER) {
      await db.supportTicket.update({
        where: { id: args.ticketId },
        data: { status: TicketStatus.OPEN, lastStatusChangeAt: now },
      });
    } else {
      await db.supportTicket.update({
        where: { id: args.ticketId },
        data: {
          status: TicketStatus.REPLIED,
          repliedAt: now,
          lastStatusChangeAt: now,
          // Set once — true first-response time, unlike repliedAt (overwritten
          // on every admin reply).
          firstResponseAt: ticket.firstResponseAt ?? now,
        },
      });
    }
  }
  return msg;
}

/** Assign (or, with `adminId: null`, unassign) a ticket to an admin. Does
 * not touch `status` — assignment and reply/close are independent actions. */
export function assignTicket(db: Db, ticketId: number, adminId: number | null) {
  return db.supportTicket.update({
    where: { id: ticketId },
    data: { adminId },
  });
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
