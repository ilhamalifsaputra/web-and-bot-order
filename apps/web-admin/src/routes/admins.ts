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
  getSetting,
  setSetting,
  getUserByTelegramId,
  logAdminAction,
  addAdminIdToDb,
  removeAdminIdFromDb,
} from "@app/db";
import { WEB_ROLES, isWebRole, webRoleKey, passwordHashKey, twoFaSecretKey, sessionJtiKey, newJti } from "../auth";
import { currentAdmin, csrfProtect, requireSuper, loadWebRole } from "../plugins/auth";
import { redirectWithFlash } from "../flash";
import { adminIds, addAdminId, setAdminIds } from "@app/core/runtime";

export default async function adminsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admins", { preHandler: requireSuper }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const admins = [];
    for (const tgId of adminIds()) {
      const user = await getUserByTelegramId(prisma, tgId);
      admins.push({
        telegramId: tgId,
        role: await loadWebRole(tgId),
        passwordSet: (await getSetting(prisma, passwordHashKey(tgId))) !== null,
        twoFa: (await getSetting(prisma, twoFaSecretKey(tgId))) !== null,
        hasSession: (await getSetting(prisma, sessionJtiKey(tgId))) !== null,
        name: user?.fullName ?? user?.username ?? null,
        isSelf: tgId === req.admin!.telegramId,
        from_env: config.ADMIN_IDS.includes(tgId),
      });
    }
    return reply.view("admins.njk", {
      admin: req.admin,
      active_nav: "/admins",
      admins,
      roles: WEB_ROLES,
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  app.post("/admins/:tgId/role", { preHandler: csrfProtect }, async (req, reply) => {
    const tgId = Number((req.params as { tgId: string }).tgId);
    const role = ((req.body as Record<string, string>).role ?? "").toLowerCase();

    if (!config.ADMIN_IDS.includes(tgId)) {
      return redirectWithFlash(reply, "/admins", "That Telegram ID is not in ADMIN_IDS.", "error");
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
      details: `telegram_id=${tgId} role=${role}`,
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
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_admin_add",
      targetType: "web_admin",
      targetId: null,
      details: `telegram_id=${tgId}`,
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
      details: `telegram_id=${tgId}`,
    });
    return redirectWithFlash(reply, "/admins", `Admin ${tgId} removed.`, "success");
  });

  // Force-logout another admin by rotating their session jti (invalidates any
  // cookie in the wild). Use your own Logout button for yourself.
  app.post("/admins/:tgId/logout", { preHandler: csrfProtect }, async (req, reply) => {
    const tgId = Number((req.params as { tgId: string }).tgId);
    if (!config.ADMIN_IDS.includes(tgId)) {
      return redirectWithFlash(reply, "/admins", "That Telegram ID is not in ADMIN_IDS.", "error");
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
      details: `telegram_id=${tgId}`,
    });
    return redirectWithFlash(reply, "/admins", `Forced logout of ${tgId}.`, "success");
  });
}
