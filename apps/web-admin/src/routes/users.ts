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
  getUser,
  setUserRole,
  setUserBanned,
  adjustWallet,
  logAdminAction,
} from "@app/db";
import { csrfProtect } from "../plugins/auth";
import { redirectWithFlash, humanizeValidationError } from "../flash";

const truthy = (v: string | undefined) => ["1", "true", "on", "yes"].includes((v ?? "").toLowerCase());
// ADMIN is excluded — it's a derived field (auto-set when a Telegram id joins
// admin_ids, see packages/db/src/crud/users.ts) and must stay in sync with
// that allow-list. Letting this route set it manually creates two
// independently-mutable sources of truth for "is this user an admin" (Admin-5
// fix, security audit 2026-06-23); admin promotion goes through /admins only.
const ROLES = [UserRole.CUSTOMER, UserRole.RESELLER] as string[];

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  // GET /users and GET /users/:userId retired — now served by React SPA via /api/users.

  app.post("/users/:userId/role", { preHandler: csrfProtect }, async (req, reply) => {
    const userId = Number((req.params as { userId: string }).userId);
    const roleUpper = ((req.body as Record<string, string>).role ?? "").toUpperCase();
    // Whitelist-only (CUSTOMER/RESELLER); ADMIN is rejected explicitly even
    // though it's also absent from ROLES, so a crafted request gets a clear
    // message instead of the generic "Invalid role." (Admin-5 fix, security
    // audit 2026-06-23).
    if (roleUpper === UserRole.ADMIN) {
      return redirectWithFlash(reply, `/users/${userId}`, "Admin status is managed from the Admins page, not here.", "error");
    }
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
      details: `Changed role to "${roleUpper}".`,
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
      details: `${doBan ? "Banned" : "Unbanned"} the user. Reason: "${(body.reason ?? "").trim().slice(0, 200)}".`,
    });
    return redirectWithFlash(reply, `/users/${userId}`, doBan ? "User banned." : "User unbanned.", "success");
  });

  app.post("/users/:userId/wallet", { preHandler: csrfProtect }, async (req, reply) => {
    const userId = Number((req.params as { userId: string }).userId);
    const body = (req.body ?? {}) as Record<string, string>;
    const note = (body.note ?? "").trim();
    if (!note) {
      return redirectWithFlash(reply, `/users/${userId}`, "A reason is required for every wallet move.", "error");
    }
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
      newBalance = await adjustWallet(prisma, userId, deltaDec, {
        reason: "admin_adjust",
        note: note || null,
        adminId: req.admin!.userId,
      });
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
      details: `Adjusted wallet by ${deltaDec.toString()}. Note: "${note.slice(0, 160)}".`,
    });
    return redirectWithFlash(reply, `/users/${userId}`, `Wallet adjusted. New balance: ${newBalance.toString()}.`, "success");
  });
}
