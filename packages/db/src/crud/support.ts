/**
 * Support tickets + ticket messages — port of those sections of Python crud.py.
 */
import type { Prisma } from "@prisma/client";
import { TicketStatus, TicketPriority, SenderType } from "@app/core/enums";
import { addDays, addMinutes, startOfDayUtc } from "@app/core/datetime";
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
  return db.supportTicket.findUnique({ where: { id: ticketId } });
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

/** All non-closed tickets (OPEN + REPLIED), newest first. */
export function listOpenTickets(db: Db, limit = 50) {
  return db.supportTicket.findMany({
    where: { status: { not: TicketStatus.CLOSED } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
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
    data: { status: TicketStatus.CLOSED, closedAt: new Date() },
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

// ---- Admin Support/Tickets page: filtering, stats, bulk operations ----
// Additions only — listOpenTickets above is untouched (still used by the
// bot's own admin panel, apps/order-bot/src/handlers/admin.ts).

export interface TicketFilter {
  status?: TicketStatus | TicketStatus[] | null;
  priority?: TicketPriority | TicketPriority[] | null;
  assigned?: "assigned" | "unassigned" | null;
  adminId?: number | null;
  overdue?: boolean | null;
  q?: string | null;
}

/** Overdue rule (single source of truth for the KPI/filter/badge alike):
 * OPEN, never replied, and older than the cutoff (now - 4h, computed by the
 * caller via `addMinutes(now, -240)` and passed in as `overdueCutoff`). */
function ticketWhere(f: TicketFilter, overdueCutoff: Date): Prisma.SupportTicketWhereInput {
  const where: Prisma.SupportTicketWhereInput = {};
  if (f.status != null) {
    where.status = Array.isArray(f.status) ? { in: f.status } : f.status;
  }
  if (f.priority != null) {
    where.priority = Array.isArray(f.priority) ? { in: f.priority } : f.priority;
  }
  if (f.assigned === "assigned") where.adminId = { not: null };
  else if (f.assigned === "unassigned") where.adminId = null;
  if (f.adminId != null) where.adminId = f.adminId;
  if (f.overdue) {
    where.status = TicketStatus.OPEN;
    where.repliedAt = null;
    where.createdAt = { lt: overdueCutoff };
  }
  if (f.q) {
    const term = f.q.trim();
    where.OR = [
      { message: { contains: term } },
      { user: { fullName: { contains: term } } },
      { user: { username: { contains: term } } },
    ];
  }
  return where;
}

/** Paged, filtered, sorted ticket list for the admin Support/Tickets page —
 * unlike `listOpenTickets`, this actually populates `user` (the bug fix). */
export async function listTicketsPaged(
  db: Db,
  opts: TicketFilter & { limit?: number; offset?: number; sort?: "newest" | "oldest" | "priority" } = {},
) {
  const overdueCutoff = addMinutes(new Date(), -240);
  const where = ticketWhere(opts, overdueCutoff);
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  if (opts.sort === "priority") {
    // Prisma/SQLite can't express "custom enum order" in `orderBy` directly.
    // Fetch newest-first, then stable-sort the page by priority rank —
    // callers never see the difference from a "real" ORDER BY.
    const rank: Record<string, number> = {
      [TicketPriority.URGENT]: 0,
      [TicketPriority.HIGH]: 1,
      [TicketPriority.MEDIUM]: 2,
      [TicketPriority.LOW]: 3,
    };
    const rows = await db.supportTicket.findMany({
      where,
      include: { user: true },
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
    });
    return [...rows].sort((a, b) => (rank[a.priority] ?? 99) - (rank[b.priority] ?? 99));
  }

  return db.supportTicket.findMany({
    where,
    include: { user: true },
    orderBy: { createdAt: opts.sort === "oldest" ? "asc" : "desc" },
    skip: offset,
    take: limit,
  });
}

export function countTickets(db: Db, opts: TicketFilter = {}) {
  const overdueCutoff = addMinutes(new Date(), -240);
  return db.supportTicket.count({ where: ticketWhere(opts, overdueCutoff) });
}

/** Five KPI counts for the Support/Tickets page header — each a real
 * `where`-clause count (not fetch-then-filter). */
export async function getTicketStats(
  db: Db,
  now: Date = new Date(),
): Promise<{ open: number; waitingCustomer: number; overdue: number; unassigned: number; resolvedToday: number }> {
  const overdueCutoff = addMinutes(now, -240);
  const todayStart = startOfDayUtc(now);
  const todayEnd = startOfDayUtc(addDays(now, 1));

  const [open, waitingCustomer, overdue, unassigned, resolvedToday] = await Promise.all([
    db.supportTicket.count({ where: { status: TicketStatus.OPEN } }),
    db.supportTicket.count({ where: { status: TicketStatus.REPLIED } }),
    db.supportTicket.count({
      where: { status: TicketStatus.OPEN, repliedAt: null, createdAt: { lt: overdueCutoff } },
    }),
    db.supportTicket.count({ where: { status: { not: TicketStatus.CLOSED }, adminId: null } }),
    db.supportTicket.count({
      where: { status: TicketStatus.CLOSED, closedAt: { gte: todayStart, lt: todayEnd } },
    }),
  ]);

  return { open, waitingCustomer, overdue, unassigned, resolvedToday };
}

/** Bulk (re)assign — or, with `adminId: null`, unassign — a batch of tickets. */
export async function bulkAssignTickets(db: Db, ids: number[], adminId: number | null): Promise<number> {
  const res = await db.supportTicket.updateMany({
    where: { id: { in: ids } },
    data: { adminId },
  });
  return res.count;
}

/** Bulk-set priority on a batch of tickets. */
export async function bulkSetTicketPriority(db: Db, ids: number[], priority: TicketPriority): Promise<number> {
  const res = await db.supportTicket.updateMany({
    where: { id: { in: ids } },
    data: { priority },
  });
  return res.count;
}

/** Bulk-close a batch of tickets, reusing `closeTicket`'s atomic
 * conditional-update guard per id (mirrors `bulkDeleteVouchers`'s
 * loop-and-collect shape: check existence, then attempt, then collect). A
 * ticket already CLOSED is already-done — counted as succeeded, not
 * re-processed (closeTicket's own guard makes the re-attempt a safe no-op,
 * so this can never double-fire the buyer notification). */
export async function bulkCloseTickets(
  db: Db,
  ids: number[],
): Promise<{ succeeded: number[]; failed: { id: number; error: string }[] }> {
  const succeeded: number[] = [];
  const failed: { id: number; error: string }[] = [];
  for (const id of ids) {
    const ticket = await db.supportTicket.findUnique({ where: { id } });
    if (!ticket) {
      failed.push({ id, error: "ticket not found" });
      continue;
    }
    await closeTicket(db, id); // no-op via the atomic guard if already CLOSED
    succeeded.push(id);
  }
  return { succeeded, failed };
}
