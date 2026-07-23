import type { FastifyInstance } from "fastify";
import { SenderType, TicketStatus, TicketPriority, TicketCategory } from "@app/core/enums";
import { logger } from "@app/core/logger";
import {
  prisma,
  listTickets,
  countTickets,
  ticketKpis,
  getTicket,
  listTicketMessages,
  getUser,
  addTicketMessage,
  closeTicket,
  assignTicket,
  resolveTicket,
  reopenTicket,
  classifyTicket,
  isTicketOverdue,
  logAdminAction,
  type TicketFilter,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { displayDate, displayDateTime } from "../../dateDisplay";

const STATUS_VALUES = Object.values(TicketStatus) as string[];
const PRIORITY_VALUES = Object.values(TicketPriority) as string[];
const CATEGORY_VALUES = Object.values(TicketCategory) as string[];
const PAGE_SIZE_OPTIONS = [20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;
const BULK_TICKET_ACTIONS = ["assign", "resolve", "close"] as const;
type BulkTicketAction = (typeof BULK_TICKET_ACTIONS)[number];

/** Derives a short subject line from the raw ticket message so the list/export
 * views have something scannable — the client used to expect a `subject`
 * field that never actually existed. Trims, takes ~60 chars, and backs off to
 * the last full word so it never cuts mid-word; appends "…" only when the
 * message was actually truncated. */
function deriveSubject(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= 60) return trimmed;
  const slice = trimmed.slice(0, 60);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
  return `${cut}…`;
}

function parseTicketStatus(raw: string | undefined): string | null {
  return raw && STATUS_VALUES.includes(raw) ? raw : null;
}

function parseTicketPriority(raw: string | undefined): string | null {
  return raw && PRIORITY_VALUES.includes(raw) ? raw : null;
}

function parseTicketCategory(raw: string | undefined): string | null {
  return raw && CATEGORY_VALUES.includes(raw) ? raw : null;
}

/** A numeric admin id, the literal "unassigned", or null (no filter). */
function parseAssignedAdminId(raw: string | undefined): number | "unassigned" | null {
  if (!raw) return null;
  if (raw === "unassigned") return "unassigned";
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Comma-separated numeric ticket ids → an array filter, or null when
 * empty/malformed (mirrors orders.ts's parseIdsFilter). */
function parseIdsFilter(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? ids : null;
}

/** Shared by the list and export routes so their filters can't silently
 * diverge (orders.ts's buildOrderFilter comment applies here too). */
function buildTicketFilter(q: Record<string, string | undefined>): TicketFilter {
  return {
    status: parseTicketStatus(q.status),
    priority: parseTicketPriority(q.priority),
    category: parseTicketCategory(q.category),
    assignedAdminId: parseAssignedAdminId(q.assignedAdminId),
    q: q.q || null,
    ids: parseIdsFilter(q.ids),
    since: parseDate(q.since),
    until: parseDate(q.until),
  };
}

/** Quotes a CSV field per RFC 4180: wrap in double quotes if it contains a
 * comma, quote, or newline, doubling any embedded quotes. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(",") + "\r\n";
}

/** "HIGH" -> "High", "PAYMENT" -> "Payment" — for natural-language audit details. */
function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

/** Only the fields the ticket-detail JSON needs off a linked user — mirrors
 * `TICKET_USER_SELECT` in packages/db/src/crud/support.ts. `getUser` returns
 * the full User row (password hash, email, wallet balances, banned reason,
 * …), so this route must always project it down before it reaches the
 * admin's browser; never spread a raw `getUser(...)` result into a response. */
function ticketPartyUser(user: Awaited<ReturnType<typeof getUser>>) {
  if (!user) return null;
  return {
    id: user.id,
    fullName: user.fullName,
    username: user.username,
    telegramId: user.telegramId,
    loginUsername: user.loginUsername,
  };
}

function classifyDetails(args: { priority?: string; category?: string | null }): string {
  const clauses: string[] = [];
  if (args.priority !== undefined) clauses.push(`priority to ${titleCase(args.priority)}`);
  if (args.category !== undefined) {
    clauses.push(args.category === null ? "category to none" : `category to ${titleCase(args.category)}`);
  }
  return clauses.length ? `Set ${clauses.join(" and ")}.` : "Updated ticket classification (no fields changed).";
}

export default async function supportApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/support", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(Number(q.page) || 1, 1);
    const requestedPageSize = Number(q.pageSize);
    const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize) ? requestedPageSize : DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const filter = buildTicketFilter(q);
    const [tickets, total] = await Promise.all([
      listTickets(prisma, { ...filter, limit: pageSize, offset }),
      countTickets(prisma, filter),
    ]);

    const ticketsWithDisplay = tickets.map((t) => ({
      ...t,
      subject: deriveSubject(t.message),
      createdAtDisplay: displayDate(t.createdAt),
      waitingSince: displayDateTime(t.lastStatusChangeAt),
      isOverdue: isTicketOverdue(t),
    }));
    return reply.send({
      tickets: ticketsWithDisplay,
      total,
      page,
      pageSize,
      hasNext: offset + tickets.length < total,
      statuses: STATUS_VALUES,
      priorities: PRIORITY_VALUES,
      categories: CATEGORY_VALUES,
    });
  });

  // Exports the full filtered result set (not just the current page) as a CSV
  // download — `listTickets` defaults to `take: 50`, so this must pass an
  // explicit override or the export would silently truncate.
  app.get("/api/support/export", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const filter = buildTicketFilter(q);
    const tickets = await listTickets(prisma, { ...filter, limit: 100000 });

    const header = ["Ticket ID", "Subject", "Customer", "Status", "Priority", "Category", "Assigned To", "Created At"];
    let csv = csvRow(header);
    for (const ticket of tickets) {
      const customer = ticket.user?.fullName ?? ticket.user?.username ?? ticket.user?.loginUsername ?? "";
      const assignedTo =
        ticket.admin?.fullName ?? ticket.admin?.username ?? (ticket.adminId != null ? `Admin #${ticket.adminId}` : "");
      csv += csvRow([
        String(ticket.id),
        deriveSubject(ticket.message),
        customer,
        ticket.status,
        ticket.priority,
        ticket.category ?? "",
        assignedTo,
        ticket.createdAt.toISOString(),
      ]);
    }

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="support-tickets.csv"');
    return reply.send(csv);
  });

  app.get("/api/support/:ticketId", { preHandler: currentAdmin }, async (req, reply) => {
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    const ticket = await getTicket(prisma, ticketId);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found." });
    const [messages, ticketUser] = await Promise.all([
      listTicketMessages(prisma, ticketId, 100),
      getUser(prisma, ticket.userId),
    ]);
    return reply.send({
      ticket: {
        ...ticket,
        subject: deriveSubject(ticket.message),
        waitingSince: displayDateTime(ticket.lastStatusChangeAt),
        isOverdue: isTicketOverdue(ticket),
        firstResponseAtDisplay: displayDateTime(ticket.firstResponseAt),
        resolvedAtDisplay: displayDateTime(ticket.resolvedAt),
      },
      messages: messages.map((m) => ({ ...m, createdAtDisplay: displayDateTime(m.createdAt) })),
      user: ticketPartyUser(ticketUser),
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

  app.post("/api/support/:ticketId/resolve", { preHandler: csrfProtect }, async (req, reply) => {
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    if (!(await getTicket(prisma, ticketId))) return reply.code(404).send({ error: "Ticket not found." });
    const resolved = await resolveTicket(prisma, ticketId);
    if (!resolved) return reply.code(422).send({ error: "Ticket is already resolved or closed." });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "ticket_resolve",
      targetType: "ticket",
      targetId: ticketId,
      details: `Marked ticket #${ticketId} resolved.`,
    });
    logger.info(`Admin ${req.admin!.userId} marked ticket ${ticketId} resolved via the web panel`);
    return reply.send({ ok: true });
  });

  // Admin-only transition back to OPEN — the bot only ever reopens implicitly
  // via a new customer message; there's no bot-side equivalent to this route.
  app.post("/api/support/:ticketId/reopen", { preHandler: csrfProtect }, async (req, reply) => {
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    if (!(await getTicket(prisma, ticketId))) return reply.code(404).send({ error: "Ticket not found." });
    const reopened = await reopenTicket(prisma, ticketId);
    if (!reopened) return reply.code(422).send({ error: "Only a closed ticket can be reopened." });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "ticket_reopen",
      targetType: "ticket",
      targetId: ticketId,
      details: `Reopened ticket #${ticketId}.`,
    });
    logger.info(`Admin ${req.admin!.userId} reopened ticket ${ticketId} via the web panel`);
    return reply.send({ ok: true });
  });

  // Admin triage: priority and/or category, independent of status. Fields
  // are optional and independently applied — omitting one leaves it as-is.
  app.post("/api/support/:ticketId/classify", { preHandler: csrfProtect }, async (req, reply) => {
    const ticketId = Number((req.params as { ticketId: string }).ticketId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.priority !== undefined && !PRIORITY_VALUES.includes(body.priority as string)) {
      return reply.code(400).send({ error: "Invalid priority." });
    }
    if (body.category !== undefined && body.category !== null && !CATEGORY_VALUES.includes(body.category as string)) {
      return reply.code(400).send({ error: "Invalid category." });
    }
    if (!(await getTicket(prisma, ticketId))) return reply.code(404).send({ error: "Ticket not found." });

    const args: { priority?: string; category?: string | null } = {};
    if (body.priority !== undefined) args.priority = body.priority as string;
    if (body.category !== undefined) args.category = body.category as string | null;
    await classifyTicket(prisma, ticketId, args);

    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "ticket_classify",
      targetType: "ticket",
      targetId: ticketId,
      details: classifyDetails(args),
    });
    return reply.send({ ok: true });
  });

  // Global snapshot for the Tickets page's KPI row — deliberately ignores
  // whatever list filters are active, same "whole-queue snapshot" convention
  // as /api/orders/kpis.
  app.get("/api/support/kpis", { preHandler: currentAdmin }, async (_req, reply) => {
    const kpis = await ticketKpis(prisma);
    return reply.send(kpis);
  });

  // Bulk row-selection actions from the Tickets page toolbar. Runs one
  // operation per ticket SEQUENTIALLY (never Promise.all) — SQLite is
  // single-writer (CLAUDE.md), and an unbounded concurrent batch would stall
  // other writers (bot, storefront checkout) for the request's duration; the
  // 50-id cap below bounds how long that serialization can run. Mirrors
  // orders.ts's /api/orders/bulk-action route.
  app.post("/api/support/bulk-action", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown; action?: unknown; adminId?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    if (ids.length === 0) {
      return reply.code(400).send({ error: "Select at least one ticket." });
    }
    if (ids.length > 50) {
      return reply.code(400).send({ error: "Select 50 tickets or fewer per bulk action." });
    }
    const action = body.action as BulkTicketAction;
    if (!BULK_TICKET_ACTIONS.includes(action)) {
      return reply.code(400).send({ error: "Unknown bulk action." });
    }

    let adminId: number | null = null;
    if (action === "assign") {
      if (body.adminId !== null && typeof body.adminId !== "number") {
        return reply.code(400).send({ error: "adminId is required for the assign action." });
      }
      adminId = body.adminId as number | null;
      if (adminId !== null && !(await getUser(prisma, adminId))) {
        return reply.code(400).send({ error: "Admin not found." });
      }
    }

    const succeeded: number[] = [];
    const failed: { id: number; error: string }[] = [];

    for (const ticketId of ids) {
      const ticket = await getTicket(prisma, ticketId);
      if (!ticket) {
        failed.push({ id: ticketId, error: "error.ticket_not_found" });
        continue;
      }
      try {
        if (action === "assign") {
          await assignTicket(prisma, ticketId, adminId);
        } else if (action === "resolve") {
          const ok = await resolveTicket(prisma, ticketId);
          if (!ok) {
            failed.push({ id: ticketId, error: "error.not_eligible" });
            continue;
          }
        } else {
          // "close" — closeTicket returns null both when the ticket was
          // already CLOSED (no transition) and when it DID close but the
          // owner has no telegramId (web-only buyer, nothing to notify).
          // Disambiguate with the prior status already fetched above: only
          // "already CLOSED" is a real failure.
          if (ticket.status === TicketStatus.CLOSED) {
            failed.push({ id: ticketId, error: "error.not_eligible" });
            continue;
          }
          await closeTicket(prisma, ticketId);
        }
        succeeded.push(ticketId);
      } catch {
        failed.push({ id: ticketId, error: "error.unexpected" });
      }
    }

    // One summary audit row per bulk call, not one per ticket (would flood
    // the audit log the shop admins actually read — CLAUDE.md logging convention).
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: `ticket_bulk_${action}`,
      targetType: "ticket",
      targetId: null,
      details: `Bulk ${action}: ${succeeded.length} succeeded, ${failed.length} failed (of ${ids.length} selected).`,
    });
    logger.info(
      `Admin ${req.admin!.userId} ran a bulk ${action} action on ${ids.length} tickets via the web panel: ${succeeded.length} succeeded, ${failed.length} failed`,
    );
    return reply.send({ succeeded, failed });
  });
}
