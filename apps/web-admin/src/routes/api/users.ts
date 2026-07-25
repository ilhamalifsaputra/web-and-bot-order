import type { FastifyInstance } from "fastify";
import { UserRole } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import {
  prisma,
  searchUsers,
  listRecentUsers,
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
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { displayDate, displayDateTime } from "../../dateDisplay";

const ROLES = [UserRole.CUSTOMER, UserRole.RESELLER] as string[];
const truthy = (v: string | undefined) => ["1", "true", "on", "yes"].includes((v ?? "").toLowerCase());

export default async function usersApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/users", { preHandler: currentAdmin }, async (req, reply) => {
    const q = ((req.query as Record<string, string | undefined>).q ?? "").trim();
    const results = q ? await searchUsers(prisma, q, 50) : await listRecentUsers(prisma, 20);
    const spentByUser = await totalSpentByUserIds(prisma, results.map((u) => u.id));
    const users = results.map((u) => ({
      ...u,
      createdAtDisplay: displayDate(u.createdAt),
      lastSeenAtDisplay: displayDateTime(u.lastSeenAt),
      totalSpent: spentByUser.get(u.id) ?? { idr: new Decimal(0), usdt: new Decimal(0) },
    }));
    return reply.send({ users, q });
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
      // `subject` was never a real column (SupportTicket has no such field) —
      // derive a short display excerpt from `message` instead, same root
      // cause/fix as the ticket-list route's identical bug.
      tickets: tickets.map((t) => ({
        ...t,
        subject: t.message.length > 60 ? `${t.message.slice(0, 60)}…` : t.message,
        createdAtDisplay: displayDateTime(t.createdAt),
      })),
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
