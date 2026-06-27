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
import { WEB_ROLES, isWebRole, webRoleKey, passwordHashKey, twoFaSecretKey, sessionJtiKey, newJti } from "../../auth";
import { currentAdmin, csrfProtect, requireSuper, loadWebRole } from "../../plugins/auth";
import { adminIds, addAdminId, setAdminIds } from "@app/core/runtime";

export default async function adminsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admins", { preHandler: requireSuper }, async (req, reply) => {
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
        fromEnv: config.ADMIN_IDS.includes(tgId),
      });
    }
    return reply.send({ admins, roles: WEB_ROLES });
  });

  app.post("/api/admins/:tgId/role", { preHandler: csrfProtect }, async (req, reply) => {
    const tgId = Number((req.params as { tgId: string }).tgId);
    const role = ((req.body as Record<string, string>).role ?? "").toLowerCase();
    if (!adminIds().includes(tgId)) return reply.code(404).send({ error: "Not a registered admin." });
    if (!isWebRole(role)) return reply.code(400).send({ error: "Invalid role." });
    if (tgId === req.admin!.telegramId && role !== "super") {
      return reply.code(403).send({ error: "You can't change your own role — ask another super-admin." });
    }
    await setSetting(prisma, webRoleKey(tgId), role);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_admin_set_role",
      targetType: "web_admin",
      targetId: null,
      details: `Set admin (Telegram ID ${tgId}) role to "${role}".`,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/admins/add", { preHandler: csrfProtect }, async (req, reply) => {
    const tgId = Number((req.body as Record<string, string>).telegram_id);
    if (!Number.isInteger(tgId)) return reply.code(400).send({ error: "Telegram ID must be a number." });
    await addAdminIdToDb(prisma, tgId);
    addAdminId(tgId);
    await setSetting(prisma, webRoleKey(tgId), "readonly");
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_admin_add",
      targetType: "web_admin",
      targetId: null,
      details: `Added admin (Telegram ID ${tgId}).`,
    });
    return reply.code(201).send({ ok: true });
  });

  app.post("/api/admins/remove", { preHandler: csrfProtect }, async (req, reply) => {
    const tgId = Number((req.body as Record<string, string>).telegram_id);
    if (tgId === req.admin!.telegramId) return reply.code(403).send({ error: "You can't remove yourself." });
    if (config.ADMIN_IDS.includes(tgId)) return reply.code(403).send({ error: "Env-based admins can't be removed here." });
    const next = await removeAdminIdFromDb(prisma, tgId);
    setAdminIds(Array.from(new Set([...config.ADMIN_IDS, ...next])));
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_admin_remove",
      targetType: "web_admin",
      targetId: null,
      details: `Removed admin (Telegram ID ${tgId}).`,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/admins/:tgId/logout", { preHandler: csrfProtect }, async (req, reply) => {
    const tgId = Number((req.params as { tgId: string }).tgId);
    if (!adminIds().includes(tgId)) return reply.code(404).send({ error: "Not a registered admin." });
    if (tgId === req.admin!.telegramId) return reply.code(403).send({ error: "Use the Logout button to end your own session." });
    await setSetting(prisma, sessionJtiKey(tgId), newJti());
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_admin_force_logout",
      targetType: "web_admin",
      targetId: null,
      details: `Forced logout of admin (Telegram ID ${tgId}).`,
    });
    return reply.send({ ok: true });
  });
}
