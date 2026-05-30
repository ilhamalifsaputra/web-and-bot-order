/**
 * Users — search, detail, role change, ban/unban, wallet adjustment. Port of
 * routers/users.py.
 */
import type { FastifyInstance } from "fastify";
import { UserRole } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import {
  prisma,
  searchUsers,
  getUser,
  userTotalSpent,
  listUserOrders,
  listUserTickets,
  setUserRole,
  setUserBanned,
  adjustWallet,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash, humanizeValidationError, renderError } from "../flash";

const truthy = (v: string | undefined) => ["1", "true", "on", "yes"].includes((v ?? "").toLowerCase());
const ROLES = Object.values(UserRole) as string[];

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users", { preHandler: currentAdmin }, async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const q = (query.q ?? "").trim();
    const results = q ? await searchUsers(prisma, q, 50) : [];
    return reply.view("users.njk", {
      admin: req.admin,
      active_nav: "/users",
      q: query.q ?? "",
      results,
      msg: query.msg ?? null,
      kind: query.kind ?? "info",
    });
  });

  app.get("/users/:userId", { preHandler: currentAdmin }, async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const userId = Number((req.params as { userId: string }).userId);
    const user = await getUser(prisma, userId);
    if (!user) {
      return renderError(reply, { statusCode: 404, title: "Not found", message: "User not found." });
    }
    const totalSpent = await userTotalSpent(prisma, userId);
    const orders = await listUserOrders(prisma, userId, 20);
    const tickets = await listUserTickets(prisma, userId, 20);

    return reply.view("user_detail.njk", {
      admin: req.admin,
      active_nav: "/users",
      user,
      total_spent: totalSpent,
      orders,
      tickets,
      roles: ROLES,
      msg: query.msg ?? null,
      kind: query.kind ?? "info",
    });
  });

  app.post("/users/:userId/role", { preHandler: csrfProtect }, async (req, reply) => {
    const userId = Number((req.params as { userId: string }).userId);
    const roleUpper = ((req.body as Record<string, string>).role ?? "").toUpperCase();
    if (!ROLES.includes(roleUpper)) {
      return redirectWithFlash(reply, `/users/${userId}`, "Invalid role.", "error");
    }
    if (!(await getUser(prisma, userId))) {
      return redirectWithFlash(reply, "/users", "User not found.", "error");
    }
    await setUserRole(prisma, userId, roleUpper as UserRole);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "user_set_role",
      targetType: "user",
      targetId: userId,
      details: `role=${roleUpper}`,
    });
    return redirectWithFlash(reply, `/users/${userId}`, `Role set to ${roleUpper}.`, "success");
  });

  app.post("/users/:userId/ban", { preHandler: csrfProtect }, async (req, reply) => {
    const userId = Number((req.params as { userId: string }).userId);
    const body = (req.body ?? {}) as Record<string, string>;
    const doBan = truthy(body.banned);
    if (!(await getUser(prisma, userId))) {
      return redirectWithFlash(reply, "/users", "User not found.", "error");
    }
    await setUserBanned(prisma, userId, doBan, doBan ? (body.reason ?? "").trim() || null : null);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: doBan ? "user_ban" : "user_unban",
      targetType: "user",
      targetId: userId,
      details: `reason=${(body.reason ?? "").trim().slice(0, 200)}`,
    });
    return redirectWithFlash(reply, `/users/${userId}`, doBan ? "User banned." : "User unbanned.", "success");
  });

  app.post("/users/:userId/wallet", { preHandler: csrfProtect }, async (req, reply) => {
    const userId = Number((req.params as { userId: string }).userId);
    const body = (req.body ?? {}) as Record<string, string>;
    let deltaDec: Decimal;
    try {
      deltaDec = new Decimal((body.delta ?? "").trim());
    } catch {
      return redirectWithFlash(reply, `/users/${userId}`, "Amount must be a number.", "error");
    }
    if (deltaDec.isZero()) {
      return redirectWithFlash(reply, `/users/${userId}`, "Amount cannot be zero.", "error");
    }
    if (!(await getUser(prisma, userId))) {
      return redirectWithFlash(reply, "/users", "User not found.", "error");
    }
    let newBalance: Decimal;
    try {
      newBalance = await adjustWallet(prisma, userId, deltaDec);
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, `/users/${userId}`, humanizeValidationError(e), "error");
      }
      throw e;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "wallet_adjust",
      targetType: "user",
      targetId: userId,
      details: `delta=${deltaDec.toString()} note=${(body.note ?? "").trim().slice(0, 160)}`,
    });
    return redirectWithFlash(reply, `/users/${userId}`, `Wallet adjusted. New balance: ${newBalance.toString()}.`, "success");
  });
}
