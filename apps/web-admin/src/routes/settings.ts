/**
 * Settings — view runtime settings, edit a whitelist of keys, change password.
 * Port of routers/settings.py. The `settings` table is shared with the bot, so
 * only whitelisted keys may be edited and secret-bearing keys are never shown.
 */
import type { FastifyInstance } from "fastify";
import { logger } from "@app/core/logger";
import { prisma, listAllSettings, getSetting, setSetting, logAdminAction } from "@app/db";
import { hashPassword, verifyPassword, passwordHashKey } from "../auth";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

// Whitelisted runtime keys the web may edit, with human labels.
const EDITABLE: Record<string, string> = {
  binance_pay_id: "Binance Pay ID shown at checkout",
  support_contact: "Support contact handle/text",
  welcome: "Welcome message",
  qr: "Payment QR image (Telegram file_id)",
};

const SECRET_PREFIXES = ["web_admin_password_hash:", "web_session_jti:"];
const isSecret = (key: string) => SECRET_PREFIXES.some((p) => key.startsWith(p));

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const rows = await listAllSettings(prisma);

    const displayRows = rows.map((r) => ({
      key: r.key,
      value: isSecret(r.key) ? "(hidden)" : r.value,
      editable: r.key in EDITABLE,
      updated_at: r.updatedAt,
    }));
    const currentValues: Record<string, string> = {};
    for (const r of rows) currentValues[r.key] = r.value;
    const editableFields = Object.entries(EDITABLE).map(([key, label]) => ({
      key,
      label,
      value: currentValues[key] ?? "",
    }));

    return reply.view("settings.njk", {
      admin: req.admin,
      active_nav: "/settings",
      rows: displayRows,
      editable_fields: editableFields,
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  app.post("/settings/edit", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const key = body.key ?? "";
    if (!(key in EDITABLE)) {
      return redirectWithFlash(reply, "/settings", "That setting is not editable here.", "error");
    }
    const value = (body.value ?? "").trim();
    const displayValue = value.slice(0, 80) + (value.length > 80 ? "…" : "");
    await setSetting(prisma, key, value);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "setting_set",
      targetType: "setting",
      details: `${key}=${displayValue}`,
    });
    return redirectWithFlash(reply, "/settings", `Setting '${key}' updated.`, "success");
  });

  app.post("/settings/password", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const currentPassword = body.current_password ?? "";
    const newPassword = body.new_password ?? "";
    const confirmPassword = body.confirm_password ?? "";

    if (newPassword.length < 8) {
      return redirectWithFlash(reply, "/settings", "New password must be at least 8 characters.", "error");
    }
    if (newPassword !== confirmPassword) {
      return redirectWithFlash(reply, "/settings", "New passwords do not match.", "error");
    }

    const key = passwordHashKey(req.admin!.telegramId);
    const stored = await getSetting(prisma, key);
    if (!stored || !verifyPassword(currentPassword, stored)) {
      return redirectWithFlash(reply, "/settings", "Current password is incorrect.", "error");
    }
    await setSetting(prisma, key, hashPassword(newPassword));
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_password_change",
      targetType: "setting", // never log the password itself
    });
    logger.info(`Web admin password changed for telegram_id=${req.admin!.telegramId}`);
    return redirectWithFlash(reply, "/settings", "Password changed.", "success");
  });
}
