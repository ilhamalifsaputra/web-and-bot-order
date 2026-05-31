/**
 * Settings — view runtime settings, edit a whitelist of keys, change password.
 * Port of routers/settings.py. The `settings` table is shared with the bot, so
 * only whitelisted keys may be edited and secret-bearing keys are never shown.
 */
import type { FastifyInstance } from "fastify";
import { logger } from "@app/core/logger";
import { prisma, listAllSettings, getSetting, setSetting, deleteSetting, logAdminAction } from "@app/db";
import {
  hashPassword,
  verifyPassword,
  passwordHashKey,
  twoFaSecretKey,
  twoFaPendingKey,
  generateTotpSecret,
  verifyTotp,
  otpauthUri,
} from "../auth";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

// Whitelisted runtime keys the web may edit, with human labels.
const EDITABLE: Record<string, string> = {
  binance_pay_id: "Binance Pay ID shown at checkout",
  support_contact: "Support contact handle/text",
  welcome: "Welcome message",
  qr: "Payment QR image (Telegram file_id)",
};

const SECRET_PREFIXES = [
  "web_admin_password_hash:",
  "web_session_jti:",
  "web_2fa_secret:",
  "web_2fa_pending:",
];
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

    const tg = req.admin!.telegramId;
    const twoFaEnabled = (await getSetting(prisma, twoFaSecretKey(tg))) !== null;
    const pendingSecret = await getSetting(prisma, twoFaPendingKey(tg));
    const twoFaPending = pendingSecret
      ? { secret: pendingSecret, uri: otpauthUri(pendingSecret, String(tg)) }
      : null;

    return reply.view("settings.njk", {
      admin: req.admin,
      active_nav: "/settings",
      rows: displayRows,
      editable_fields: editableFields,
      two_fa_enabled: twoFaEnabled,
      two_fa_pending: twoFaPending,
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  // ---- 2FA (TOTP) — self-service for every admin (see canMutate) ----
  app.post("/settings/2fa/begin", { preHandler: csrfProtect }, async (req, reply) => {
    const tg = req.admin!.telegramId;
    if ((await getSetting(prisma, twoFaSecretKey(tg))) !== null) {
      return redirectWithFlash(reply, "/settings", "2FA is already enabled.", "error");
    }
    await setSetting(prisma, twoFaPendingKey(tg), generateTotpSecret());
    return redirectWithFlash(reply, "/settings", "Add the secret to your authenticator, then enter a code to finish.", "info");
  });

  app.post("/settings/2fa/cancel", { preHandler: csrfProtect }, async (req, reply) => {
    await deleteSetting(prisma, twoFaPendingKey(req.admin!.telegramId));
    return redirectWithFlash(reply, "/settings", "2FA setup cancelled.", "info");
  });

  app.post("/settings/2fa/enable", { preHandler: csrfProtect }, async (req, reply) => {
    const tg = req.admin!.telegramId;
    const pending = await getSetting(prisma, twoFaPendingKey(tg));
    if (!pending) {
      return redirectWithFlash(reply, "/settings", "Start 2FA setup first.", "error");
    }
    const code = ((req.body as Record<string, string>).totp_code ?? "").trim();
    if (!verifyTotp(pending, code)) {
      return redirectWithFlash(reply, "/settings", "That code is wrong — check your authenticator and try again.", "error");
    }
    await setSetting(prisma, twoFaSecretKey(tg), pending);
    await deleteSetting(prisma, twoFaPendingKey(tg));
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_2fa_enable",
      targetType: "setting", // never log the secret
    });
    return redirectWithFlash(reply, "/settings", "2FA enabled. You'll need a code at every login.", "success");
  });

  app.post("/settings/2fa/disable", { preHandler: csrfProtect }, async (req, reply) => {
    const tg = req.admin!.telegramId;
    const secret = await getSetting(prisma, twoFaSecretKey(tg));
    if (!secret) {
      return redirectWithFlash(reply, "/settings", "2FA isn't enabled.", "error");
    }
    const body = (req.body ?? {}) as Record<string, string>;
    const stored = await getSetting(prisma, passwordHashKey(tg));
    if (!stored || !verifyPassword(body.current_password ?? "", stored)) {
      return redirectWithFlash(reply, "/settings", "Current password is incorrect.", "error");
    }
    if (!verifyTotp(secret, body.totp_code ?? "")) {
      return redirectWithFlash(reply, "/settings", "That 2FA code is wrong.", "error");
    }
    await deleteSetting(prisma, twoFaSecretKey(tg));
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_2fa_disable",
      targetType: "setting",
    });
    return redirectWithFlash(reply, "/settings", "2FA disabled.", "success");
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
