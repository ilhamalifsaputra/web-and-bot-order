import type { FastifyInstance } from "fastify";
import { UserRole } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import {
  prisma,
  getUser,
  userTotalSpent,
  totalSpentByUserIds,
  listUserOrders,
  listUserTickets,
  listWalletLedger,
  setUserRole,
  setUserBanned,
  adjustWallet,
  logAdminAction,
  listUsers,
  countUsers,
  customersKpis,
  orderStatsByUserIds,
  type UserFilter,
  type UserSort,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { displayDate, displayDateTime } from "../../dateDisplay";

const ROLES = [UserRole.CUSTOMER, UserRole.RESELLER] as string[];
const truthy = (v: string | undefined) => ["1", "true", "on", "yes"].includes((v ?? "").toLowerCase());

const PAGE_SIZE_OPTIONS = [20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;
const SORT_VALUES: UserSort[] = ["newest", "oldest", "lastSeen", "spend"];

function shapeRevenue(r: { idr: Decimal; usdt: Decimal }) {
  const idr = new Decimal(r.idr);
  const usdt = new Decimal(r.usdt);
  return {
    idr: idr.isZero() ? null : idr.toString(),
    usdt: usdt.isZero() ? null : usdt.toString(),
  };
}

/** Comma-separated numeric user ids → an array filter, or null when empty/malformed. */
function parseIdsFilter(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? ids : null;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "banned" → banned only, "active" → active only, anything else → both. */
function parseBannedFilter(status: string | undefined): boolean | null {
  if (status === "banned") return true;
  if (status === "active") return false;
  return null;
}

function parseRoleFilter(raw: string | undefined): Exclude<UserRole, "ADMIN"> | null {
  return raw && ROLES.includes(raw) ? (raw as Exclude<UserRole, "ADMIN">) : null;
}

/** Shared by the list and export routes so their filters can't silently
 * diverge (mirrors orders.ts's buildOrderFilter). */
function buildUserFilter(q: Record<string, string | undefined>): UserFilter {
  return {
    role: parseRoleFilter(q.role),
    banned: parseBannedFilter(q.status),
    q: q.q || null,
    ids: parseIdsFilter(q.ids),
    since: parseDate(q.since),
    until: parseDate(q.until),
    lastSeenSince: parseDate(q.lastSeenSince),
    lastSeenUntil: parseDate(q.lastSeenUntil),
  };
}

/** Quotes a CSV field per RFC 4180: wrap in double quotes if it contains a
 * comma, quote, or newline, doubling any embedded quotes. Also neutralizes
 * CSV formula injection: a leading `=`, `+`, `-`, or `@` is interpreted by
 * Excel/Google Sheets as the start of a formula, so this field can carry
 * attacker-controlled free text (e.g. the storefront's public, unauthenticated
 * registration `fullName`) — prefixing with a single quote forces the cell to
 * render as literal text instead of evaluating. */
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

export default async function usersApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/users", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(Number(q.page) || 1, 1);
    const requestedPageSize = Number(q.pageSize);
    const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize) ? requestedPageSize : DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;
    const sort: UserSort = SORT_VALUES.includes(q.sort as UserSort) ? (q.sort as UserSort) : "newest";

    const filter = buildUserFilter(q);
    const [users, total] = await Promise.all([
      listUsers(prisma, { ...filter, sort, limit: pageSize, offset }),
      countUsers(prisma, filter),
    ]);

    const userIds = users.map((u) => u.id);
    const [spentByUser, statsByUser] = await Promise.all([
      totalSpentByUserIds(prisma, userIds),
      orderStatsByUserIds(prisma, userIds),
    ]);

    const usersWithDisplay = users.map((u) => {
      const spent = spentByUser.get(u.id) ?? { idr: new Decimal(0), usdt: new Decimal(0) };
      const stats = statsByUser.get(u.id) ?? { totalOrders: 0, lastOrderAt: null, deliveredOrders: 0 };
      return {
        ...u,
        createdAtDisplay: displayDate(u.createdAt),
        lastSeenAtDisplay: displayDateTime(u.lastSeenAt),
        totalSpent: spent,
        totalOrders: stats.totalOrders,
        deliveredOrders: stats.deliveredOrders,
        lastOrderAt: stats.lastOrderAt,
        lastOrderAtDisplay: displayDateTime(stats.lastOrderAt),
      };
    });

    return reply.send({
      users: usersWithDisplay,
      total,
      page,
      pageSize,
      hasNext: offset + users.length < total,
      roles: ROLES,
    });
  });

  // Exports the full filtered result set (not just the current page) as a CSV
  // download — listUsers defaults to take: 20, so this must pass an explicit
  // override or the export would silently truncate.
  app.get("/api/users/export", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const filter = buildUserFilter(q);
    const users = await listUsers(prisma, { ...filter, sort: "newest", limit: 100000 });

    const userIds = users.map((u) => u.id);
    const [spentByUser, statsByUser] = await Promise.all([
      totalSpentByUserIds(prisma, userIds),
      orderStatsByUserIds(prisma, userIds),
    ]);

    const header = [
      "Telegram ID",
      "Full Name",
      "Username",
      "Role",
      "Status",
      "Joined",
      "Last Seen",
      "Total Spent (IDR)",
      "Total Spent (USDT)",
      "Orders",
      "Last Order",
    ];
    let csv = csvRow(header);
    for (const u of users) {
      const spent = spentByUser.get(u.id) ?? { idr: new Decimal(0), usdt: new Decimal(0) };
      const stats = statsByUser.get(u.id) ?? { totalOrders: 0, lastOrderAt: null, deliveredOrders: 0 };
      // Raw ISO timestamps, not the localized display strings — a CSV
      // consumer should get the unambiguous form.
      csv += csvRow([
        u.telegramId != null ? u.telegramId.toString() : "",
        u.fullName ?? "",
        u.username ?? "",
        u.role,
        u.banned ? "Banned" : "Active",
        u.createdAt.toISOString(),
        u.lastSeenAt ? u.lastSeenAt.toISOString() : "",
        spent.idr.toString(),
        spent.usdt.toString(),
        stats.totalOrders.toString(),
        stats.lastOrderAt ? stats.lastOrderAt.toISOString() : "",
      ]);
    }

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="customers.csv"');
    return reply.send(csv);
  });

  // Global snapshot for the Customers page's KPI row — all-time, non-admin
  // only (packages/db/src/crud/users.ts's customersKpis).
  app.get("/api/users/kpis", { preHandler: currentAdmin }, async (_req, reply) => {
    const kpis = await customersKpis(prisma);
    return reply.send({
      totalCustomers: kpis.totalCustomers,
      newToday: kpis.newToday,
      activeToday: kpis.activeToday,
      returningCustomers: kpis.returningCustomers,
      totalRevenue: shapeRevenue(kpis.totalRevenue),
    });
  });

  app.get("/api/users/:userId", { preHandler: currentAdmin }, async (req, reply) => {
    const userId = Number((req.params as { userId: string }).userId);
    const user = await getUser(prisma, userId);
    if (!user) return reply.code(404).send({ error: "User not found." });
    const [totalSpent, orders, tickets, ledger] = await Promise.all([
      userTotalSpent(prisma, userId),
      listUserOrders(prisma, userId, 20),
      listUserTickets(prisma, userId, 20),
      listWalletLedger(prisma, userId, 50),
    ]);
    return reply.send({
      user: {
        ...user,
        createdAtDisplay: displayDate(user.createdAt),
        lastSeenAtDisplay: displayDateTime(user.lastSeenAt),
      },
      totalSpent,
      orders: orders.map((o) => ({ ...o, createdAtDisplay: displayDate(o.createdAt) })),
      tickets: tickets.map((t) => ({ ...t, createdAtDisplay: displayDateTime(t.createdAt) })),
      ledger: ledger.map((l) => ({ ...l, createdAtDisplay: displayDate(l.createdAt) })),
      roles: ROLES,
    });
  });

  app.post("/api/users/:userId/role", { preHandler: csrfProtect }, async (req, reply) => {
    const userId = Number((req.params as { userId: string }).userId);
    const roleUpper = ((req.body as Record<string, string>).role ?? "").toUpperCase();
    if (roleUpper === UserRole.ADMIN) {
      return reply.code(403).send({ error: "Admin status is managed from the Admins page, not here." });
    }
    if (!ROLES.includes(roleUpper)) return reply.code(400).send({ error: "Invalid role." });
    if (!(await getUser(prisma, userId))) return reply.code(404).send({ error: "User not found." });
    await setUserRole(prisma, userId, roleUpper as UserRole);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "user_set_role",
      targetType: "user",
      targetId: userId,
      details: `Changed role to "${roleUpper}".`,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/users/:userId/ban", { preHandler: csrfProtect }, async (req, reply) => {
    const userId = Number((req.params as { userId: string }).userId);
    const body = (req.body ?? {}) as Record<string, string>;
    const doBan = truthy(body.banned);
    if (!(await getUser(prisma, userId))) return reply.code(404).send({ error: "User not found." });
    await setUserBanned(prisma, userId, doBan, doBan ? (body.reason ?? "").trim() || null : null);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: doBan ? "user_ban" : "user_unban",
      targetType: "user",
      targetId: userId,
      details: `${doBan ? "Banned" : "Unbanned"} the user. Reason: "${(body.reason ?? "").trim().slice(0, 200)}".`,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/users/:userId/wallet", { preHandler: csrfProtect }, async (req, reply) => {
    const userId = Number((req.params as { userId: string }).userId);
    const body = (req.body ?? {}) as Record<string, string>;
    const note = (body.note ?? "").trim();
    if (!note) return reply.code(400).send({ error: "A reason is required for every wallet move." });
    let deltaDec: Decimal;
    try {
      deltaDec = new Decimal((body.delta ?? "").trim());
    } catch {
      return reply.code(400).send({ error: "Amount must be a number." });
    }
    if (deltaDec.isZero()) return reply.code(400).send({ error: "Amount cannot be zero." });
    const currencyRaw = (body.currency ?? "IDR").toUpperCase();
    if (currencyRaw !== "IDR" && currencyRaw !== "USDT") {
      return reply.code(400).send({ error: "Currency must be IDR or USDT." });
    }
    const currency = currencyRaw as "IDR" | "USDT";
    if (!(await getUser(prisma, userId))) return reply.code(404).send({ error: "User not found." });
    let newBalance: Decimal;
    try {
      newBalance = await adjustWallet(prisma, userId, deltaDec, {
        reason: "admin_adjust",
        note: note || null,
        adminId: req.admin!.userId,
        currency,
      });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(422).send({ error: e.message });
      throw e;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "wallet_adjust",
      targetType: "user",
      targetId: userId,
      details: `Adjusted ${currency} wallet by ${deltaDec.toString()}. Note: "${note.slice(0, 160)}".`,
    });
    return reply.send({ ok: true, newBalance: newBalance.toString() });
  });
}
