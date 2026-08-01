/**
 * Support tickets + ticket messages — port of those sections of Python crud.py.
 */
import { Prisma } from "@prisma/client";
import { TicketStatus, TicketPriority, TicketCategory, SenderType } from "@app/core/enums";
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

/** Fields of the linked customer surfaced in ticket JSON responses (web-admin
 * list/detail/CSV export) — NEVER `include: { user: true }` on a ticket
 * query: that pulls every User column (passwordHash, email, wallet
 * balances, bannedReason, …) into the response body the admin's browser
 * receives. Keep in sync with what SupportPage.tsx/TicketDetailPage.tsx
 * actually read off `ticket.user`. */
const TICKET_USER_SELECT = {
  id: true,
  fullName: true,
  username: true,
  telegramId: true,
  loginUsername: true,
} as const;

/** Same leak guard as `TICKET_USER_SELECT`, scoped to the smaller set of
 * fields the UI reads off `ticket.admin` (the assigned admin). */
const TICKET_ADMIN_SELECT = {
  id: true,
  fullName: true,
  username: true,
} as const;

export function getTicket(db: Db, ticketId: number) {
  return db.supportTicket.findUnique({
    where: { id: ticketId },
    include: { user: { select: TICKET_USER_SELECT }, admin: { select: TICKET_ADMIN_SELECT } },
  });
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
  const now = new Date();
  const res = await db.supportTicket.updateMany({
    where: { id: ticketId, status: { not: TicketStatus.CLOSED } },
    data: { status: TicketStatus.CLOSED, closedAt: now, lastStatusChangeAt: now },
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
    data: { status: TicketStatus.OPEN, closedAt: null, lastStatusChangeAt: new Date() },
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
  const now = new Date();
  await db.supportTicket.update({
    where: { id: args.ticketId },
    data: {
      adminReply: args.reply,
      adminId: args.adminDbId,
      status: TicketStatus.REPLIED,
      repliedAt: now,
      lastStatusChangeAt: now,
      // Set once — true first-response time, unlike repliedAt (overwritten
      // on every admin reply). Mirrors addTicketMessage's ADMIN branch.
      firstResponseAt: ticket.firstResponseAt ?? now,
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

/** Set a single ticket's priority. Task 2 only added the bulk version
 * (bulkSetTicketPriority) — this is the one-ticket counterpart used by the
 * detail page's priority dropdown. */
export function setTicketPriority(db: Db, ticketId: number, priority: TicketPriority) {
  return db.supportTicket.update({
    where: { id: ticketId },
    data: { priority },
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
  category?: TicketCategory | TicketCategory[] | null;
  assigned?: "assigned" | "unassigned" | null;
  adminId?: number | null;
  overdue?: boolean | null;
  q?: string | null;
  /** Restrict to this exact set of ticket ids — the export route's "export
   * only the selected rows" path. */
  ids?: number[] | null;
}

/** How long after creation a still-OPEN, never-replied ticket counts as
 * overdue. The one knob behind the overdue rule below — change it here, not
 * at any call site. */
const OVERDUE_MINUTES = 240;

/** Cutoff `Date` for the overdue rule: a ticket created before this instant
 * (and still OPEN + never replied) is overdue. Callers pass this into
 * `ticketWhere`/`getTicketStats` rather than each computing their own
 * `addMinutes(now, -240)`, so the 4h figure lives in exactly one place. */
export function overdueCutoff(now: Date = new Date()): Date {
  return addMinutes(now, -OVERDUE_MINUTES);
}

/** Same overdue predicate as the `{ overdue: true }` branch of `ticketWhere`,
 * but for a single already-fetched row rather than a `where` clause — used by
 * the paged-list route to stamp each item with `isOverdue` without a second
 * per-row query. Takes the same `cutoff` (from `overdueCutoff`) so the list
 * route and `getTicketStats` can never disagree on the threshold. */
export function isTicketOverdue(
  ticket: { status: string; repliedAt: Date | null; createdAt: Date },
  cutoff: Date,
): boolean {
  return ticket.status === TicketStatus.OPEN && ticket.repliedAt === null && ticket.createdAt < cutoff;
}

/** Overdue rule (single source of truth for the KPI/filter/badge alike) —
 * structurally enforced: `getTicketStats`'s `overdue` count calls this same
 * function (via `f.overdue`) rather than repeating the predicate inline, so
 * there is exactly one place that defines "overdue," not two copies that
 * happen to match. OPEN, never replied, and older than `cutoff` (see
 * `overdueCutoff`). */
function ticketWhere(f: TicketFilter, cutoff: Date): Prisma.SupportTicketWhereInput {
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
  if (f.assigned === "assigned") where.adminId = { not: null };
  else if (f.assigned === "unassigned") where.adminId = null;
  if (f.adminId != null) where.adminId = f.adminId;
  if (f.ids != null) where.id = { in: f.ids };
  if (f.overdue) {
    where.status = TicketStatus.OPEN;
    where.repliedAt = null;
    where.createdAt = { lt: cutoff };
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

/** Same predicate as `ticketWhere`, translated into a parameterized raw-SQL
 * `WHERE` clause (no leading `WHERE` keyword) — used only by `sort:
 * "priority"` below, which needs a real `ORDER BY` across every matching row,
 * not just the current page (Prisma/SQLite can't express a custom enum-rank
 * `orderBy` directly, so there's no way to do this through the query builder
 * alone). Every value that can come from request input (`q`, the CSV
 * status/priority filters) is passed through Prisma's tagged-template
 * parameter binding — never string-interpolated — so this can't become a
 * SQL-injection vector. Column names are the raw `support_tickets`/`users`
 * table columns (see the `@map`s on `SupportTicket`/`User` in schema.prisma),
 * not the Prisma field names. */
function ticketWhereRaw(f: TicketFilter, cutoff: Date): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (f.status != null) {
    conditions.push(
      Array.isArray(f.status)
        ? Prisma.sql`status IN (${Prisma.join(f.status)})`
        : Prisma.sql`status = ${f.status}`,
    );
  }
  if (f.priority != null) {
    conditions.push(
      Array.isArray(f.priority)
        ? Prisma.sql`priority IN (${Prisma.join(f.priority)})`
        : Prisma.sql`priority = ${f.priority}`,
    );
  }
  if (f.category != null) {
    conditions.push(
      Array.isArray(f.category)
        ? Prisma.sql`category IN (${Prisma.join(f.category)})`
        : Prisma.sql`category = ${f.category}`,
    );
  }
  if (f.assigned === "assigned") conditions.push(Prisma.sql`admin_id IS NOT NULL`);
  else if (f.assigned === "unassigned") conditions.push(Prisma.sql`admin_id IS NULL`);
  if (f.adminId != null) conditions.push(Prisma.sql`admin_id = ${f.adminId}`);
  if (f.ids != null) conditions.push(Prisma.sql`id IN (${Prisma.join(f.ids)})`);
  if (f.overdue) {
    conditions.push(Prisma.sql`status = ${TicketStatus.OPEN}`);
    conditions.push(Prisma.sql`replied_at IS NULL`);
    conditions.push(Prisma.sql`created_at < ${cutoff}`);
  }
  if (f.q) {
    const term = `%${f.q.trim()}%`;
    conditions.push(
      Prisma.sql`(message LIKE ${term} OR user_id IN (SELECT id FROM users WHERE full_name LIKE ${term} OR username LIKE ${term}))`,
    );
  }
  return conditions.length > 0 ? Prisma.join(conditions, " AND ") : Prisma.sql`1=1`;
}

/** Ordered ticket ids for `sort: "priority"`, ranked URGENT→HIGH→MEDIUM→LOW
 * (ties broken newest-first) across ALL matching rows via a real `ORDER BY`
 * — not just the current page. Returns ids only; the caller re-fetches the
 * full rows (with the `user` relation) via a normal Prisma `findMany` and
 * re-sorts in memory to match this order, rather than hand-writing the
 * `user` join here — simpler and safer for the same result. */
async function listTicketIdsByPriorityRank(
  db: Db,
  opts: TicketFilter,
  cutoff: Date,
  limit: number,
  offset: number,
): Promise<number[]> {
  const whereSql = ticketWhereRaw(opts, cutoff);
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT id FROM support_tickets
    WHERE ${whereSql}
    ORDER BY
      CASE priority
        WHEN 'URGENT' THEN 0
        WHEN 'HIGH' THEN 1
        WHEN 'MEDIUM' THEN 2
        WHEN 'LOW' THEN 3
        ELSE 4
      END,
      created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map((r) => r.id);
}

/** Paged, filtered, sorted ticket list for the admin Support/Tickets page —
 * unlike `listOpenTickets`, this actually populates `user` (the bug fix). */
export async function listTicketsPaged(
  db: Db,
  opts: TicketFilter & { limit?: number; offset?: number; sort?: "newest" | "oldest" | "priority" } = {},
) {
  const cutoff = overdueCutoff();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  if (opts.sort === "priority") {
    // A real global ORDER BY (via raw SQL — see ticketWhereRaw), not a
    // fetch-then-sort-within-the-page shortcut: an URGENT ticket on "page 2"
    // of newest-first must still surface here.
    const ids = await listTicketIdsByPriorityRank(db, opts, cutoff, limit, offset);
    if (ids.length === 0) return [];
    const rows = await db.supportTicket.findMany({
      where: { id: { in: ids } },
      include: { user: { select: TICKET_USER_SELECT }, admin: { select: TICKET_ADMIN_SELECT } },
    });
    const rowById = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => rowById.get(id)).filter((r): r is (typeof rows)[number] => r !== undefined);
  }

  return db.supportTicket.findMany({
    where: ticketWhere(opts, cutoff),
    include: { user: { select: TICKET_USER_SELECT }, admin: { select: TICKET_ADMIN_SELECT } },
    orderBy: { createdAt: opts.sort === "oldest" ? "asc" : "desc" },
    skip: offset,
    take: limit,
  });
}

export function countTickets(db: Db, opts: TicketFilter = {}) {
  return db.supportTicket.count({ where: ticketWhere(opts, overdueCutoff()) });
}

/** Five KPI counts for the Support/Tickets page header — each a real
 * `where`-clause count (not fetch-then-filter). */
export async function getTicketStats(
  db: Db,
  now: Date = new Date(),
): Promise<{ open: number; waitingCustomer: number; overdue: number; unassigned: number; resolvedToday: number }> {
  const cutoff = overdueCutoff(now);
  const todayStart = startOfDayUtc(now);
  const todayEnd = startOfDayUtc(addDays(now, 1));

  const [open, waitingCustomer, overdue, unassigned, resolvedToday] = await Promise.all([
    db.supportTicket.count({ where: { status: TicketStatus.OPEN } }),
    db.supportTicket.count({ where: { status: TicketStatus.REPLIED } }),
    // Routed through ticketWhere (the same function the {overdue:true} filter
    // path uses) rather than repeating the predicate inline — this is what
    // makes "overdue" an actual single source of truth instead of two copies
    // that happen to agree today.
    db.supportTicket.count({ where: ticketWhere({ overdue: true }, cutoff) }),
    db.supportTicket.count({ where: { status: { not: TicketStatus.CLOSED }, adminId: null } }),
    db.supportTicket.count({
      where: { status: TicketStatus.CLOSED, closedAt: { gte: todayStart, lt: todayEnd } },
    }),
  ]);

  return { open, waitingCustomer, overdue, unassigned, resolvedToday };
}

/** Which of the requested ids actually exist, split succeeded/failed — shared
 * by bulkAssignTickets/bulkSetTicketPriority so a nonexistent id in the batch
 * (which `updateMany` would otherwise silently no-op on) is reported back
 * honestly instead of echoed as succeeded. Mirrors bulkCloseTickets' shape
 * and failure wording exactly. */
async function splitExistingTicketIds(
  db: Db,
  ids: number[],
): Promise<{ succeeded: number[]; failed: { id: number; error: string }[] }> {
  const existing = await db.supportTicket.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const existingIds = new Set(existing.map((t) => t.id));
  const succeeded = ids.filter((id) => existingIds.has(id));
  const failed = ids
    .filter((id) => !existingIds.has(id))
    .map((id) => ({ id, error: "ticket not found" }));
  return { succeeded, failed };
}

/** Bulk (re)assign — or, with `adminId: null`, unassign — a batch of tickets.
 * Returns which ids actually existed (succeeded) vs didn't (failed) rather
 * than just an affected count, so a caller that echoes this back to an admin
 * (the bulk-action route) can't misreport a nonexistent id as a success. */
export async function bulkAssignTickets(
  db: Db,
  ids: number[],
  adminId: number | null,
): Promise<{ succeeded: number[]; failed: { id: number; error: string }[] }> {
  const { succeeded, failed } = await splitExistingTicketIds(db, ids);
  if (succeeded.length > 0) {
    await db.supportTicket.updateMany({ where: { id: { in: succeeded } }, data: { adminId } });
  }
  return { succeeded, failed };
}

/** Bulk-set priority on a batch of tickets. Same succeeded/failed honesty as
 * bulkAssignTickets, for the same reason. */
export async function bulkSetTicketPriority(
  db: Db,
  ids: number[],
  priority: TicketPriority,
): Promise<{ succeeded: number[]; failed: { id: number; error: string }[] }> {
  const { succeeded, failed } = await splitExistingTicketIds(db, ids);
  if (succeeded.length > 0) {
    await db.supportTicket.updateMany({ where: { id: { in: succeeded } }, data: { priority } });
  }
  return { succeeded, failed };
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

/** Bulk resolve — unlike bulkCloseTickets, an already-RESOLVED-or-CLOSED
 * ticket in the batch is a real failure (not a silent no-op): resolving is a
 * one-way admin decision the caller should know didn't apply, not an idle
 * status refresh. Mirrors bulkAssignTickets/bulkCloseTickets' shape. */
export async function bulkResolveTickets(
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
    const ok = await resolveTicket(db, id);
    if (!ok) {
      failed.push({ id, error: "already resolved or closed" });
      continue;
    }
    succeeded.push(id);
  }
  return { succeeded, failed };
}
