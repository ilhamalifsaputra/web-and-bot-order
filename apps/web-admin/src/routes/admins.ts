/**
 * Web-admin accounts & RBAC — WEB.md roadmap Tier 3 §9. Super-admins assign a
 * web role (super / support / readonly) to each Telegram admin in the bot's
 * ADMIN_IDS allow-list. Roles live in settings (`web_admin_role:<tg>`) — no
 * schema change — and gate mutations in `csrfProtect` (see plugins/auth.ts).
 *
 * Self-lockout guard: a super cannot demote their OWN account (another super
 * must do it), so the dashboard can never be left without a super-admin.
 */
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import {
  prisma,
  setSetting,
  logAdminAction,
  addAdminIdToDb,
  removeAdminIdFromDb,
} from "@app/db";
import { isWebRole, webRoleKey, sessionJtiKey, newJti } from "../auth";
import { csrfProtect } from "../plugins/auth";
import { redirectWithFlash } from "../flash";
import { adminIds, addAdminId, setAdminIds } from "@app/core/runtime";

export default async function adminsRoutes(app: FastifyInstance): Promise<void> {
  // GET /admins retired — now served by React SPA via GET /api/admins.

  app.post("/admins/:tgId/role", { preHandler: csrfProtect }, async (req, reply) => {
    const tgId = Number((req.params as { tgId: string }).tgId);
    const role = ((req.body as Record<string, string>).role ?? "").toLowerCase();

    // adminIds() (env ∪ DB), not config.ADMIN_IDS alone — otherwise a
    // DB-added admin (who defaults to "super" until a role is set explicitly)
    // could never be assigned/demoted through this route.
    if (!adminIds().includes(tgId)) {
      return redirectWithFlash(reply, "/admins", "That Telegram ID is not a registered admin.", "error");
    }
    if (!isWebRole(role)) {
      return redirectWithFlash(reply, "/admins", "Invalid role.", "error");
    }
    // Self-lockout guard: never let a super strip their own super role.
    if (tgId === req.admin!.telegramId && role !== "super") {
      return redirectWithFlash(reply, "/admins", "You can't change your own role — ask another super-admin.", "error");
    }

    await setSetting(prisma, webRoleKey(tgId), role);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_admin_set_role",
      targetType: "web_admin",
      targetId: null,
      details: `Set admin (Telegram ID ${tgId}) role to "${role}".`,
    });
    return redirectWithFlash(reply, "/admins", `Role for ${tgId} set to ${role}.`, "success");
  });

  app.post("/admins/add", { preHandler: csrfProtect }, async (req, reply) => {
    const tgId = Number((req.body as Record<string, string>).telegram_id);
    if (!Number.isInteger(tgId)) {
      return redirectWithFlash(reply, "/admins", "Telegram ID harus angka.", "error");
    }
    await addAdminIdToDb(prisma, tgId);
    addAdminId(tgId); // live, no restart
    // Persist an explicit least-privilege role immediately — an unset role
    // resolves to DEFAULT_WEB_ROLE ("super", kept for legacy/bootstrap admins
    // that pre-date RBAC), which would silently hand every newly added admin
    // full access until someone remembers to demote them.
    await setSetting(prisma, webRoleKey(tgId), "readonly");
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_admin_add",
      targetType: "web_admin",
      targetId: null,
      details: `Added admin (Telegram ID ${tgId}).`,
    });
    return redirectWithFlash(reply, "/admins", `Admin ${tgId} added.`, "success");
  });

  app.post("/admins/remove", { preHandler: csrfProtect }, async (req, reply) => {
    const tgId = Number((req.body as Record<string, string>).telegram_id);
    if (tgId === req.admin!.telegramId) {
      return redirectWithFlash(reply, "/admins", "You can't remove yourself.", "error");
    }
    if (config.ADMIN_IDS.includes(tgId)) {
      return redirectWithFlash(reply, "/admins", "Env-based admins can't be removed here.", "error");
    }
    const next = await removeAdminIdFromDb(prisma, tgId);
    setAdminIds(Array.from(new Set([...config.ADMIN_IDS, ...next])));
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_admin_remove",
      targetType: "web_admin",
      targetId: null,
      details: `Removed admin (Telegram ID ${tgId}).`,
    });
    return redirectWithFlash(reply, "/admins", `Admin ${tgId} removed.`, "success");
  });

  // Force-logout another admin by rotating their session jti (invalidates any
  // cookie in the wild). Use your own Logout button for yourself.
  app.post("/admins/:tgId/logout", { preHandler: csrfProtect }, async (req, reply) => {
    const tgId = Number((req.params as { tgId: string }).tgId);
    if (!adminIds().includes(tgId)) {
      return redirectWithFlash(reply, "/admins", "That Telegram ID is not a registered admin.", "error");
    }
    if (tgId === req.admin!.telegramId) {
      return redirectWithFlash(reply, "/admins", "Use the Logout button to end your own session.", "error");
    }
    await setSetting(prisma, sessionJtiKey(tgId), newJti());
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_admin_force_logout",
      targetType: "web_admin",
      targetId: null,
      details: `Forced logout of admin (Telegram ID ${tgId}).`,
    });
    return redirectWithFlash(reply, "/admins", `Forced logout of ${tgId}.`, "success");
  });
}
