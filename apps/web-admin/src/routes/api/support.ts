import type { FastifyInstance } from "fastify";
import { SenderType, TicketStatus, TicketPriority, TicketCategory } from "@app/core/enums";
import { logger } from "@app/core/logger";
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
  bulkResolveTickets,
  resolveTicket,
  reopenTicketAdmin,
  classifyTicket,
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
const CATEGORY_VALUES = Object.values(TicketCategory) as string[];
const PAGE_SIZE_OPTIONS = [20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;
const SORT_VALUES = ["newest", "oldest", "priority"] as const;
const BULK_ACTIONS = ["assign", "close", "priority", "resolve"] as const;
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

/** Resolve an assignee id to its display name, shared by the single-ticket
 * `/assign` route and the bulk-action `assign` branch so the "look up the
 * admin, build a display name, 400 if it doesn't exist" logic can't drift
 * between the two copies. `adminId: null` (unassign) always resolves ok with
 * a null name. */
async function resolveAssigneeName(
  adminId: number | null,
): Promise<{ ok: true; name: string | null } | { ok: false }> {
  if (adminId === null) return { ok: true, name: null };
  const assignee = await getUser(prisma, adminId);
  if (!assignee) return { ok: false };
  return { ok: true, name: assignee.fullName ?? assignee.username ?? `Telegram ID ${assignee.telegramId}` };
}

/** "ticket" for a count of 1, else "tickets" — the bulk-action audit
 * summaries read as natural sentences (docs/LOGGING.md's convention), so
 * "Assigned 1 tickets" isn't acceptable. */
function pluralTicket(count: number): string {
  return count === 1 ? "ticket" : "tickets";
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

/** Shared by the list route and the export route so the filter can't
 * silently diverge — mirrors `orders.ts`'s `buildOrderFilter`. */
function buildTicketFilter(q: Record<string, string | undefined>): TicketFilter {
  return {
    status: parseCsvFilter(q.status, STATUS_VALUES) as TicketStatus[] | null,
    priority: parseCsvFilter(q.priority, PRIORITY_VALUES) as TicketPriority[] | null,
    category: parseCsvFilter(q.category, CATEGORY_VALUES) as TicketCategory[] | null,
    assigned: q.assigned === "assigned" || q.assigned === "unassigned" ? q.assigned : null,
    overdue: q.overdue === "true" ? true : null,
    q: q.q?.trim() || null,
    ids: parseIdsFilter(q.ids),
  };
}

/** Derives a short subject line from the raw ticket message so the export
 * CSV has something scannable — trims, takes ~60 chars, and backs off to the
 * last full word so it never cuts mid-word; appends "…" only when the
 * message was actually truncated. */
function deriveSubject(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= 60) return trimmed;
  const slice = trimmed.slice(0, 60);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
  return `${cut}…`;
}

/** Quotes a CSV field per RFC 4180: wrap in double quotes if it contains a
 * comma, quote, or newline, doubling any embedded quotes. Also neutralizes
 * CSV formula injection (see users.ts's csvField): a leading `=`, `+`, `-`,
 * or `@` is interpreted by Excel/Google Sheets as the start of a formula,
 * and a ticket's `message` is attacker-controlled free text from the public,
 * unauthenticated storefront/bot — prefixing with a single quote forces the
 * cell to render as literal text instead of evaluating. */
function csvField(value: string): string {
  const escaped = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(escaped)) {
    return `"${escaped.replace(/"/g, '""')}"`;
  }
  return escaped;
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
      subject: deriveSubject(t.message),
      createdAtDisplay: displayDate(t.createdAt),
      repliedAtDisplay: displayDateTime(t.repliedAt),
      waitingSince: displayDateTime(t.lastStatusChangeAt),
      isOverdue: isTicketOverdue(t, cutoff),
    }));

    return reply.send({ items, total, page, pageSize, stats });
  });

  // Exports the full filtered result set (not just the current page) as a CSV
  // download — listTicketsPaged defaults to take: 50, so this must pass an
  // explicit override or the export would silently truncate.
  app.get("/api/support/export", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const filter = buildTicketFilter(q);
    const tickets = await listTicketsPaged(prisma, { ...filter, limit: 100000 });

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
    if (!Number.isInteger(ticketId)) return reply.code(400).send({ error: "Invalid ticket id." });
    const ticket = await getTicketWithOrder(prisma, ticketId);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found." });
    const cutoff = overdueCutoff();

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

    // Every date field the detail page renders gets its own server-computed
    // `*Display` string here — same "UTC in DB, TIMEZONE on display" rule the
    // rest of this route already follows for `messages`/`recentOrders`. The
    // page must never call `new Date(x).toLocaleString()` itself (that
    // renders in the *browser's* timezone, so two admins in different
    // timezones would see different times for the same event).
    return reply.send({
      ticket: {
        ...ticket,
        subject: deriveSubject(ticket.message),
        createdAtDisplay: displayDateTime(ticket.createdAt),
        waitingSince: displayDateTime(ticket.lastStatusChangeAt),
        isOverdue: isTicketOverdue(ticket, cutoff),
        firstResponseAtDisplay: displayDateTime(ticket.firstResponseAt),
        resolvedAtDisplay: displayDateTime(ticket.resolvedAt),
        order: ticket.order ? { ...ticket.order, createdAtDisplay: displayDate(ticket.order.createdAt) } : null,
      },
      messages: messages.map((m) => ({ ...m, createdAtDisplay: displayDateTime(m.createdAt) })),
      user: ticketPartyUser(ticketUser),
      customer: {
        totalSpent,
        orderCount,
        recentOrders: recentOrders.map((o) => ({ ...o, createdAtDisplay: displayDate(o.createdAt) })),
        openTicketCount,
      },
      timeline: {
        ticket: ticketTimeline.map((row) => ({ ...row, createdAtDisplay: displayDateTime(row.createdAt) })),
        order: orderTimeline.map((row) => ({ ...row, createdAtDisplay: displayDateTime(row.createdAt) })),
      },
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
      details: `Replied to ticket #${ticketId}.`,
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
      details: `Closed ticket #${ticketId}.`,
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

    const resolved = await resolveAssigneeName(adminId);
    if (!resolved.ok) return reply.code(400).send({ error: "Admin not found." });
    const adminName = resolved.name;

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
    if (!Number.isInteger(ticketId)) return reply.code(400).send({ error: "Invalid ticket id." });
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
    const reopened = await reopenTicketAdmin(prisma, ticketId);
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
      const resolved = await resolveAssigneeName(adminId);
      if (!resolved.ok) return reply.code(400).send({ error: "Admin not found." });
      const adminName = resolved.name;
      const result = await bulkAssignTickets(prisma, ids, adminId);
      const summary =
        adminId !== null
          ? `Assigned ${result.succeeded.length} ${pluralTicket(result.succeeded.length)} to "${adminName}"`
          : `Unassigned ${result.succeeded.length} ${pluralTicket(result.succeeded.length)}`;
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "ticket_bulk_assign",
        targetType: "ticket",
        details: summary + (result.failed.length > 0 ? `; skipped ${result.failed.length} not found.` : "."),
      });
      // One per-ticket row too (in addition to the summary above) — so a
      // bulk-assigned ticket's OWN timeline (GET /:ticketId reads
      // listAuditLogs({ targetType: "ticket", targetId })) isn't empty, the
      // same as if it had been assigned one at a time via POST /:ticketId/assign.
      await Promise.all(
        result.succeeded.map((id) =>
          logAdminAction(prisma, {
            adminId: req.admin!.userId,
            action: "ticket_bulk_assign",
            targetType: "ticket",
            targetId: id,
            details:
              adminId !== null ? `Assigned ticket #${id} to "${adminName}".` : `Unassigned ticket #${id}.`,
          }),
        ),
      );
      return reply.send(result);
    }

    if (action === "priority") {
      const priority = typeof body.priority === "string" ? body.priority.toUpperCase() : "";
      if (!PRIORITY_VALUES.includes(priority)) {
        return reply.code(400).send({ error: "Invalid priority." });
      }
      const result = await bulkSetTicketPriority(prisma, ids, priority as TicketPriority);
      // Possessive: "1 ticket's" vs "2 tickets'" — the plural noun already
      // ends in "s", so only the singular form needs the extra "s" before
      // the apostrophe.
      const possessive = result.succeeded.length === 1 ? "ticket's" : "tickets'";
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "ticket_bulk_priority",
        targetType: "ticket",
        details:
          `Set ${result.succeeded.length} ${possessive} priority to ${priority}` +
          (result.failed.length > 0 ? `; skipped ${result.failed.length} not found.` : "."),
      });
      // Per-ticket rows — same reasoning as the assign branch above.
      await Promise.all(
        result.succeeded.map((id) =>
          logAdminAction(prisma, {
            adminId: req.admin!.userId,
            action: "ticket_bulk_priority",
            targetType: "ticket",
            targetId: id,
            details: `Set ticket #${id}'s priority to ${priority}.`,
          }),
        ),
      );
      return reply.send(result);
    }

    if (action === "resolve") {
      const result = await bulkResolveTickets(prisma, ids);
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "ticket_bulk_resolve",
        targetType: "ticket",
        details:
          `Resolved ${result.succeeded.length} ${pluralTicket(result.succeeded.length)}` +
          (result.failed.length > 0 ? `; skipped ${result.failed.length} not eligible.` : "."),
      });
      // Per-ticket rows — same reasoning as the other branches above.
      await Promise.all(
        result.succeeded.map((id) =>
          logAdminAction(prisma, {
            adminId: req.admin!.userId,
            action: "ticket_bulk_resolve",
            targetType: "ticket",
            targetId: id,
            details: `Resolved ticket #${id}.`,
          }),
        ),
      );
      return reply.send(result);
    }

    // "close"
    const result = await bulkCloseTickets(prisma, ids);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "ticket_bulk_close",
      targetType: "ticket",
      details:
        `Closed ${result.succeeded.length} ${pluralTicket(result.succeeded.length)}` +
        (result.failed.length > 0 ? `; skipped ${result.failed.length} not found.` : "."),
    });
    // Per-ticket rows — same reasoning as the other two branches above.
    await Promise.all(
      result.succeeded.map((id) =>
        logAdminAction(prisma, {
          adminId: req.admin!.userId,
          action: "ticket_bulk_close",
          targetType: "ticket",
          targetId: id,
          details: `Closed ticket #${id}.`,
        }),
      ),
    );
    return reply.send(result);
  });

  // Photo preview for a ticket's attached screenshot: proxies Telegram's
  // getFile → file *bytes* (not a redirect) so the admin panel — and the
  // admin's own browser network log / HTTP cache — never sees the bot token.
  // A redirect to the Telegram file URL would put the token straight into the
  // `Location` header sent to the browser; `bot_token` is a super-admin-only
  // SECRET_KEY everywhere else in this app (settings.ts), so this route must
  // not leak it to any admin who can merely view a ticket. Admin-gated (GET,
  // no CSRF needed) since a ticket's photoFileIds could otherwise be used to
  // fish for Telegram file_ids.
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
    let upstream: Response;
    try {
      upstream = await fetch(`https://api.telegram.org/file/bot${creds.botToken}/${result.filePath}`);
    } catch {
      // Never interpolate the token into a log/error — even on a network failure.
      return reply.code(502).send({ error: "Could not retrieve the photo from Telegram." });
    }
    if (!upstream.ok) {
      return reply.code(502).send({ error: "Could not retrieve the photo from Telegram." });
    }
    reply.header("content-type", upstream.headers.get("content-type") ?? "image/jpeg");
    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  });
}
