import type { FastifyInstance } from "fastify";
import { SenderType, TicketStatus, TicketPriority } from "@app/core/enums";
import {
  prisma,
  listTicketsPaged,
  countTickets,
  getTicketStats,
  overdueCutoff,
  isTicketOverdue,
  getTicket,
  getTicketWithOrder,
  listTicketMessages,
  getUser,
  addTicketMessage,
  closeTicket,
  assignTicket,
  setTicketPriority,
  bulkAssignTickets,
  bulkSetTicketPriority,
  bulkCloseTickets,
  userTotalSpent,
  countUserOrders,
  listUserOrders,
  listAuditLogs,
  resolveBotCredentials,
  logAdminAction,
  type TicketFilter,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { getFileResolver } from "../../lib/telegramCheck";
import { displayDate, displayDateTime } from "../../dateDisplay";

const STATUS_VALUES = Object.values(TicketStatus) as string[];
const PRIORITY_VALUES = Object.values(TicketPriority) as string[];
const PAGE_SIZE_OPTIONS = [20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;
const SORT_VALUES = ["newest", "oldest", "priority"] as const;
const BULK_ACTIONS = ["assign", "close", "priority"] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

/** Comma-separated raw values (filtered to known enum members) → an array
 * filter, or null when nothing valid was passed (matches every value) —
 * mirrors `orders.ts`'s `parseStatusFilter`. */
function parseCsvFilter(raw: string | undefined, allowed: string[]): string[] | null {
  if (!raw) return null;
  const values = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => allowed.includes(s));
  return values.length ? values : null;
}

/** Shared by the list route (and, once it needs it, an export route) so the
 * filter can't drift between call sites — mirrors `orders.ts`'s
 * `buildOrderFilter`. */
function buildTicketFilter(q: Record<string, string | undefined>): TicketFilter {
  return {
    status: parseCsvFilter(q.status, STATUS_VALUES) as TicketStatus[] | null,
    priority: parseCsvFilter(q.priority, PRIORITY_VALUES) as TicketPriority[] | null,
    assigned: q.assigned === "assigned" || q.assigned === "unassigned" ? q.assigned : null,
    q: q.q?.trim() || null,
  };
}

export default async function supportApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/support", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(Number(q.page) || 1, 1);
    const requestedPageSize = Number(q.pageSize);
    const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize) ? requestedPageSize : DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;
    const sort = (SORT_VALUES as readonly string[]).includes(q.sort ?? "")
      ? (q.sort as (typeof SORT_VALUES)[number])
      : undefined;

    const filter = buildTicketFilter(q);
    const cutoff = overdueCutoff();
    const [tickets, total, stats] = await Promise.all([
      listTicketsPaged(prisma, { ...filter, limit: pageSize, offset, sort }),
      countTickets(prisma, filter),
      getTicketStats(prisma),
    ]);

    const items = tickets.map((t) => ({
      ...t,
      createdAtDisplay: displayDate(t.createdAt),
      repliedAtDisplay: displayDateTime(t.repliedAt),
      isOverdue: isTicketOverdue(t, cutoff),
    }));

    return reply.send({ items, total, page, pageSize, stats });
  });

  app.get("/api/support/:ticketId", { preHandler: currentAdmin }, async (req, reply) => {
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    const ticket = await getTicketWithOrder(prisma, ticketId);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found." });

    const [messages, ticketUser, totalSpent, orderCount, recentOrders, openTicketCount] = await Promise.all([
      listTicketMessages(prisma, ticketId, 100),
      getUser(prisma, ticket.userId),
      userTotalSpent(prisma, ticket.userId),
      countUserOrders(prisma, ticket.userId),
      listUserOrders(prisma, ticket.userId, 5),
      prisma.supportTicket.count({ where: { userId: ticket.userId, status: { not: TicketStatus.CLOSED } } }),
    ]);

    // Two arrays, not merged — keeps this route a thin data source and lets
    // the frontend (a later task) decide how to render/interleave them.
    const [ticketTimeline, orderTimeline] = await Promise.all([
      listAuditLogs(prisma, { targetType: "ticket", targetId: ticketId, limit: 20 }),
      ticket.orderId
        ? listAuditLogs(prisma, { targetType: "order", targetId: ticket.orderId, limit: 5 })
        : Promise.resolve([]),
    ]);

    return reply.send({
      ticket,
      messages: messages.map((m) => ({ ...m, createdAtDisplay: displayDateTime(m.createdAt) })),
      user: ticketUser,
      customer: {
        totalSpent,
        orderCount,
        recentOrders: recentOrders.map((o) => ({ ...o, createdAtDisplay: displayDate(o.createdAt) })),
        openTicketCount,
      },
      timeline: { ticket: ticketTimeline, order: orderTimeline },
    });
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

  app.post("/api/support/:ticketId/priority", { preHandler: csrfProtect }, async (req, reply) => {
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    const priority = ((req.body as Record<string, string>).priority ?? "").toUpperCase();
    if (!PRIORITY_VALUES.includes(priority)) return reply.code(400).send({ error: "Invalid priority." });
    if (!(await getTicket(prisma, ticketId))) return reply.code(404).send({ error: "Ticket not found." });
    await setTicketPriority(prisma, ticketId, priority as TicketPriority);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "ticket_set_priority",
      targetType: "ticket",
      targetId: ticketId,
      details: `Set ticket #${ticketId}'s priority to ${priority}.`,
    });
    return reply.send({ ok: true });
  });

  // Bulk row-selection actions from the Support/Tickets page toolbar. One
  // endpoint with an action discriminator (mirrors POST /api/orders/bulk-action
  // and /api/vouchers/bulk-action) — same 50-id cap and ids-validation shape.
  // No delete/merge action — a ticket is either assigned, closed, or
  // re-prioritized in bulk; anything more destructive stays single-ticket-only.
  app.post("/api/support/bulk-action", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown; action?: unknown; adminId?: unknown; priority?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    if (ids.length === 0) {
      return reply.code(400).send({ error: "Select at least one ticket." });
    }
    if (ids.length > 50) {
      return reply.code(400).send({ error: "Select 50 tickets or fewer per bulk action." });
    }
    const action = body.action as BulkAction;
    if (!BULK_ACTIONS.includes(action)) {
      return reply.code(400).send({ error: "Unknown bulk action." });
    }

    if (action === "assign") {
      if (body.adminId !== null && typeof body.adminId !== "number") {
        return reply.code(400).send({ error: "adminId must be a number or null." });
      }
      const adminId = body.adminId as number | null;
      let adminName: string | null = null;
      if (adminId !== null) {
        const assignee = await getUser(prisma, adminId);
        if (!assignee) return reply.code(400).send({ error: "Admin not found." });
        adminName = assignee.fullName ?? assignee.username ?? `Telegram ID ${assignee.telegramId}`;
      }
      const count = await bulkAssignTickets(prisma, ids, adminId);
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "ticket_bulk_assign",
        targetType: "ticket",
        details: adminId !== null
          ? `Assigned ${count} tickets to "${adminName}".`
          : `Unassigned ${count} tickets.`,
      });
      return reply.send({ succeeded: ids, failed: [] });
    }

    if (action === "priority") {
      const priority = typeof body.priority === "string" ? body.priority.toUpperCase() : "";
      if (!PRIORITY_VALUES.includes(priority)) {
        return reply.code(400).send({ error: "Invalid priority." });
      }
      const count = await bulkSetTicketPriority(prisma, ids, priority as TicketPriority);
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "ticket_bulk_priority",
        targetType: "ticket",
        details: `Set ${count} tickets' priority to ${priority}.`,
      });
      return reply.send({ succeeded: ids, failed: [] });
    }

    // "close"
    const result = await bulkCloseTickets(prisma, ids);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "ticket_bulk_close",
      targetType: "ticket",
      details:
        result.failed.length > 0
          ? `Closed ${result.succeeded.length} tickets; skipped ${result.failed.length} not found.`
          : `Closed ${result.succeeded.length} tickets.`,
    });
    return reply.send(result);
  });

  // Photo preview for a ticket's attached screenshot: proxies Telegram's
  // getFile → file redirect so the admin panel never needs the bot token
  // client-side. Admin-gated (GET, no CSRF needed) since a ticket's
  // photoFileIds could otherwise be used to fish for Telegram file_ids.
  app.get("/api/support/photo/:fileId", { preHandler: currentAdmin }, async (req, reply) => {
    const fileId = (req.params as { fileId: string }).fileId;
    const creds = await resolveBotCredentials(prisma);
    if (!creds.botToken) {
      return reply.code(503).send({ error: "The bot token is not configured." });
    }
    const result = await getFileResolver()(creds.botToken, fileId);
    if (!result.ok) {
      return reply.code(502).send({ error: "Could not retrieve the photo from Telegram." });
    }
    return reply.redirect(`https://api.telegram.org/file/bot${creds.botToken}/${result.filePath}`);
  });
}
