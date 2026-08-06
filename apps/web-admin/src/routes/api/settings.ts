import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";
import {
  prisma,
  listAllSettings,
  getSetting,
  setSetting,
  deleteSetting,
  logAdminAction,
  refreshUsdIdrRate,
  getBybitPollHealth,
  getBybitBscPollHealth,
  getSmtpCreds,
  OWNER_EMAIL_RE,
} from "@app/db";
import { verifySmtp } from "@app/core/mailer";
import {
  hashPassword,
  verifyPassword,
  passwordHashKey,
  sessionJtiKey,
  newJti,
  makeSession,
  twoFaSecretKey,
  twoFaPendingKey,
  generateTotpSecret,
  verifyTotp,
  otpauthUri,
} from "../../auth";
import { CUSTOM_EMOJI_MAP_SETTING, setCustomEmojiMap } from "@app/core/customEmoji";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { getTokenValidator, getChannelValidator } from "../../lib/telegramCheck";
import { CONNECTION_TESTS } from "../../lib/connectionTest";

const EDITABLE: Record<string, string> = {
  support_contact: "Support contact handle/text",
  welcome: "Welcome message",
  banner_image: "Banner image — Telegram file_id",
  shop_name: "Shop name",
  shop_tagline: "Shop tagline",
  support_whatsapp: "WhatsApp number for website",
  web_analytics_id: "Google Analytics measurement ID (G-XXXXXXXXXX)",
  usd_idr_rate: "USDT rate (IDR per 1 USDT)",
  usd_idr_rate_auto: "Auto-update USDT rate",
  usd_idr_rate_rounding: "Rate rounding",
  tokopay_merchant_id: "TokoPay merchant ID",
  tokopay_secret: "TokoPay secret key",
  tokopay_enabled: "TokoPay enabled",
  tokopay_min_amount: "TokoPay min amount (IDR)",
  paydisini_userkey: "PayDisini user key",
  paydisini_apikey: "PayDisini API key",
  paydisini_enabled: "PayDisini enabled",
  paydisini_default_channel: "PayDisini channel",
  paydisini_min_amount: "PayDisini min amount (IDR)",
  nowpayments_api_key: "NOWPayments API key",
  nowpayments_ipn_secret: "NOWPayments IPN secret",
  nowpayments_enabled: "NOWPayments enabled",
  nowpayments_pay_currency: "NOWPayments currency",
  nowpayments_min_amount: "NOWPayments min amount (USDT)",
  bybit_uid: "Bybit UID",
  bybit_api_key: "Bybit API key",
  bybit_api_secret: "Bybit API secret",
  bybit_enabled: "Bybit enabled",
  bybit_min_amount: "Bybit min amount (USDT)",
  bybit_bsc_deposit_address: "Bybit BSC deposit address",
  bybit_bsc_enabled: "Bybit BSC enabled",
  bybit_bsc_min_amount: "Bybit BSC min amount (USDT)",
  bscscan_api_key: "BscScan API key",
  bybit_bsc_required_confirmations: "Bybit BSC required confirmations",
  binance_receive_uid: "Binance UID",
  binance_api_key: "Binance API key",
  binance_api_secret: "Binance API secret",
  binance_internal_enabled: "Binance Internal Transfer enabled",
  binance_internal_min_amount: "Binance min amount (USDT)",
  bot_token: "Order Bot token",
  bot_username: "Bot username",
  notif_bot_token: "Channel Notifier Bot token",
  public_channel_id: "Public channel ID",
  smtp_host: "SMTP host",
  smtp_port: "SMTP port",
  smtp_user: "SMTP username",
  smtp_pass: "SMTP password",
  smtp_from: "From address",
  smtp_secure: "Use SSL/TLS (port 465)",
  owner_email: "Owner notification email",
  owner_email_enabled: "Owner email notifications enabled",
  owner_email_on_paid_order: "Email owner on paid orders",
  owner_email_on_manual_queue: "Email owner on manual-fulfilment orders",
  owner_email_on_new_ticket: "Email owner on new support tickets",
  owner_email_on_ticket_reply: "Email owner on ticket replies",
  [CUSTOM_EMOJI_MAP_SETTING]: "Custom emoji map (JSON)",
  bulk_purchase_broadcast_enabled: "Bulk purchase broadcast enabled",
  bulk_purchase_broadcast_threshold: "Bulk purchase broadcast threshold (qty)",
  bulk_purchase_broadcast_template: "Bulk purchase broadcast message template",
};

const SECRET_KEYS = new Set(["tokopay_secret", "paydisini_apikey", "bot_token", "notif_bot_token", "bybit_api_key", "bybit_api_secret", "binance_api_key", "binance_api_secret", "nowpayments_api_key", "nowpayments_ipn_secret", "bscscan_api_key", "smtp_pass"]);
const TOKEN_KEYS = new Set(["bot_token", "notif_bot_token"]);
const BOT_TOKEN_FIELD_KEYS = new Set(["bot_token", "bot_username", "notif_bot_token", "public_channel_id"]);
const SECRET_PREFIXES = ["web_admin_password_hash:", "web_session_jti:", "web_2fa_secret:", "web_2fa_pending:", "shop_session_jti:"];
const isSecret = (key: string) => SECRET_KEYS.has(key) || SECRET_PREFIXES.some(p => key.startsWith(p));

// Accepts a plain email, or Nodemailer's "Display Name <email>" form.
const SMTP_FROM_RE = /^([^\s@]+@[^\s@]+\.[^\s@]+|.+<[^\s@]+@[^\s@]+\.[^\s@]+>)$/;

const PAYMENT_METHODS: Record<string, { enabledKey: string; credKeys: string[]; label: string }> = {
  tokopay: { enabledKey: "tokopay_enabled", credKeys: ["tokopay_merchant_id", "tokopay_secret"], label: "TokoPay" },
  paydisini: { enabledKey: "paydisini_enabled", credKeys: ["paydisini_userkey", "paydisini_apikey"], label: "PayDisini" },
  nowpayments: { enabledKey: "nowpayments_enabled", credKeys: ["nowpayments_api_key", "nowpayments_ipn_secret"], label: "NOWPayments" },
  bybit: { enabledKey: "bybit_enabled", credKeys: ["bybit_uid", "bybit_api_key", "bybit_api_secret"], label: "Bybit" },
  bybit_bsc: { enabledKey: "bybit_bsc_enabled", credKeys: ["bybit_bsc_deposit_address", "bybit_api_key", "bybit_api_secret"], label: "Bybit BSC" },
  binance_internal: { enabledKey: "binance_internal_enabled", credKeys: ["binance_receive_uid", "binance_api_key", "binance_api_secret"], label: "Binance Internal Transfer" },
};

/**
 * Validate the custom emoji map before it is saved: `{"✅": "5368324170671202286"}`
 * — emoji as the key, the custom emoji sticker's numeric id as the value. A typo
 * here would silently drop icons from every message, so it's rejected with a
 * sentence the shop admin can act on. Returns the problem, or null when valid.
 */
function customEmojiMapProblem(value: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return 'That isn\'t valid JSON. Expected something like {"✅": "5368324170671202286"} — or leave it blank to turn custom emoji off.';
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return 'Expected a JSON object mapping each emoji to its custom emoji id, like {"✅": "5368324170671202286"}.';
  }
  for (const [emoji, id] of Object.entries(parsed as Record<string, unknown>)) {
    if (!emoji.trim()) return "One of the entries has an empty emoji. Every key must be the emoji the icon replaces.";
    if (typeof id !== "string" || !/^\d+$/.test(id)) {
      return `The id for ${emoji} must be the custom emoji's numeric id, in quotes. Send /emojiid to the bot from a Telegram Premium account to get it.`;
    }
  }
  return null;
}

/** Thrown by `applyFieldEdit` for any rejection — carries the HTTP status the
 * route should reply with, so both `/edit` and `/import` translate it the
 * same way without duplicating the status-code decisions below. */
class FieldEditError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The whitelist check, every field-specific validation rule, the write, and
 * the audit log entry for a single setting — shared by `POST /api/settings/edit`
 * (one field, interactively) and `POST /api/settings/import` (many fields, from
 * an uploaded export file) so the two paths can never drift apart. Throws
 * `FieldEditError` for anything the caller should treat as a rejected field;
 * returns the same shape `/edit` has always replied with on success.
 */
async function applyFieldEdit(
  admin: { userId: number; telegramId: number; role: string },
  key: string,
  rawValue: string,
): Promise<{ ok: true; unchanged?: boolean; cleared?: boolean; needsRestart?: boolean }> {
  if (!(key in EDITABLE)) throw new FieldEditError(400, "That setting is not editable here.");
  const value = rawValue.trim();
  if (SECRET_KEYS.has(key) && value === "") return { ok: true, unchanged: true };

  if (TOKEN_KEYS.has(key)) {
    if (admin.role !== "super") throw new FieldEditError(403, "Only the owner can change bot tokens.");
    if (value === "-") {
      await deleteSetting(prisma, key);
      await logAdminAction(prisma, { adminId: admin.userId, action: "setting_clear", targetType: "setting", details: `Cleared setting "${key}".` });
      return { ok: true, cleared: true };
    }
    const check = await getTokenValidator()(value);
    if (!check.ok) throw new FieldEditError(400, "Telegram rejected that token. Check it in BotFather and try again.");
    await setSetting(prisma, key, value);
    if (key === "bot_token" && check.username) await setSetting(prisma, "bot_username", check.username);
    await logAdminAction(prisma, { adminId: admin.userId, action: "setting_set", targetType: "setting", details: `Changed setting "${key}" (updated).` });
    return { ok: true, needsRestart: true };
  }

  if (key === "public_channel_id") {
    if (admin.role !== "super") throw new FieldEditError(403, "Only the owner can change the channel.");
    if (value === "-") {
      await deleteSetting(prisma, key);
      await logAdminAction(prisma, { adminId: admin.userId, action: "setting_clear", targetType: "setting", details: `Cleared setting "${key}".` });
      return { ok: true, cleared: true };
    }
    const botToken = (await getSetting(prisma, "notif_bot_token")) ?? (await getSetting(prisma, "bot_token"));
    if (!botToken) throw new FieldEditError(400, "Set a bot token first, then add the channel.");
    const check = await getChannelValidator()(botToken, value);
    if (!check.ok || typeof check.id !== "number") throw new FieldEditError(400, "Couldn't find that channel.");
    await setSetting(prisma, key, String(check.id));
    await logAdminAction(prisma, { adminId: admin.userId, action: "setting_set", targetType: "setting", details: `Changed setting "${key}" to ${check.id}.` });
    return { ok: true, needsRestart: true };
  }

  if (key.endsWith("_min_amount") && value !== "") {
    let valid = false;
    try { const d = new Decimal(value); valid = d.isFinite() && d.greaterThan(0); } catch { valid = false; }
    if (!valid) throw new FieldEditError(400, "Minimum amount must be a positive number, or blank to disable.");
  }

  // This value is interpolated into a <script> tag on every storefront page
  // (spaShell.ts), so it is validated strictly rather than escaped: a
  // measurement ID is only ever "G-" followed by letters and digits, and
  // anything else is a typo at best and script injection at worst.
  if (key === "web_analytics_id" && value !== "") {
    if (!/^G-[A-Z0-9]{4,20}$/i.test(value)) {
      throw new FieldEditError(
        400,
        'That doesn\'t look like a Google Analytics measurement ID. It starts with "G-" followed by letters and numbers, like G-ABC1234XYZ — find it in Google Analytics under Admin › Data streams. Leave it blank to turn analytics off.',
      );
    }
  }

  if (key === "bybit_bsc_required_confirmations" && value !== "") {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) throw new FieldEditError(400, "Required confirmations must be a positive whole number.");
  }

  if (key === "smtp_port" && value !== "") {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) throw new FieldEditError(400, "SMTP port must be a positive whole number.");
  }

  if (key === "smtp_from" && value !== "" && !SMTP_FROM_RE.test(value)) {
    throw new FieldEditError(400, 'Expected an email address, optionally with a display name, like "Shop Name <no-reply@example.com>".');
  }

  // Plain address only — unlike smtp_from this is a recipient, not a
  // Nodemailer "from" header, so no "Display Name <email>" form.
  if (key === "owner_email" && value !== "" && !OWNER_EMAIL_RE.test(value)) {
    throw new FieldEditError(400, "That doesn't look like a valid email address, e.g. owner@example.com.");
  }

  if (key === CUSTOM_EMOJI_MAP_SETTING && value !== "") {
    const problem = customEmojiMapProblem(value);
    if (problem) throw new FieldEditError(400, problem);
  }

  if (key === "bulk_purchase_broadcast_threshold" && value !== "") {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 2) {
      throw new FieldEditError(400, "Threshold must be a whole number of 2 or more.");
    }
  }

  if (key === "bulk_purchase_broadcast_template" && value.length > 500) {
    throw new FieldEditError(400, "Template is too long — keep it under 500 characters.");
  }

  const displayValue = SECRET_KEYS.has(key) ? "(updated)" : value.slice(0, 80);
  await setSetting(prisma, key, value);
  // Single process (apps/server): re-stamp so the bot's send layer picks the
  // new icons up immediately instead of at the next restart.
  if (key === CUSTOM_EMOJI_MAP_SETTING) setCustomEmojiMap(value);
  await logAdminAction(prisma, { adminId: admin.userId, action: "setting_set", targetType: "setting", details: `Changed setting "${key}" to "${displayValue}".` });
  return { ok: true };
}

export default async function settingsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", { preHandler: currentAdmin }, async (req, reply) => {
    const rows = await listAllSettings(prisma);
    const currentValues: Record<string, string> = {};
    for (const r of rows) currentValues[r.key] = r.value;

    const fields = Object.entries(EDITABLE).map(([key, label]) => ({
      key,
      label,
      secret: SECRET_KEYS.has(key),
      hasValue: Boolean(currentValues[key]),
      value: SECRET_KEYS.has(key) ? "" : (currentValues[key] ?? ""),
      needsRestart: BOT_TOKEN_FIELD_KEYS.has(key),
    }));

    const payMethodState: Record<string, { enabled: boolean; configured: boolean }> = {};
    for (const [id, m] of Object.entries(PAYMENT_METHODS)) {
      const flag = currentValues[m.enabledKey];
      payMethodState[id] = {
        enabled: (flag ?? "").trim().toLowerCase() !== "false",
        configured: m.credKeys.every(k => Boolean((currentValues[k] ?? "").trim())),
      };
    }

    const [bybitHealth, bybitBscHealth] = await Promise.all([
      getBybitPollHealth(prisma),
      getBybitBscPollHealth(prisma),
    ]);

    const tg = req.admin!.telegramId;
    const twoFaEnabled = (await getSetting(prisma, twoFaSecretKey(tg))) !== null;
    const pendingSecret = await getSetting(prisma, twoFaPendingKey(tg));

    return reply.send({
      fields,
      payMethodState,
      bybitHealth,
      bybitBscHealth,
      isOwner: req.admin!.role === "super",
      twoFaEnabled,
      twoFaPending: pendingSecret ? { secret: pendingSecret, uri: otpauthUri(pendingSecret, String(tg)) } : null,
    });
  });

  app.post("/api/settings/edit", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    try {
      const result = await applyFieldEdit(req.admin!, body.key ?? "", body.value ?? "");
      return reply.send(result);
    } catch (err) {
      if (err instanceof FieldEditError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  // Settings-scoped export/import (Settings refinement §13 "Quick Actions" —
  // "Backup Settings"/"Restore Backup" are the same mechanism under a
  // friendlier menu label, not a second parallel system). Secrets are never
  // included: export omits every SECRET_KEYS field entirely (not redacted —
  // structurally absent), and import defensively skips any secret key present
  // in an uploaded file even though a file produced by this same export could
  // never contain one.
  app.get("/api/settings/export", { preHandler: currentAdmin }, async (req, reply) => {
    const rows = await listAllSettings(prisma);
    const currentValues: Record<string, string> = {};
    for (const r of rows) currentValues[r.key] = r.value;
    const fields: Record<string, string> = {};
    for (const key of Object.keys(EDITABLE)) {
      if (SECRET_KEYS.has(key)) continue;
      const v = currentValues[key];
      if (v !== undefined) fields[key] = v;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "settings_export",
      targetType: "setting",
      details: `Exported ${Object.keys(fields).length} settings to a configuration file.`,
    });
    return reply.send({ exportedAt: new Date().toISOString(), fields });
  });

  app.post("/api/settings/import", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as { fields?: Record<string, string> };
    const incoming = body.fields ?? {};
    let applied = 0;
    let skipped = 0;
    for (const [key, value] of Object.entries(incoming)) {
      if (!(key in EDITABLE) || SECRET_KEYS.has(key)) {
        skipped++;
        continue;
      }
      try {
        await applyFieldEdit(req.admin!, key, String(value ?? ""));
        applied++;
      } catch {
        skipped++;
      }
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "settings_import",
      targetType: "setting",
      details: `Imported ${applied} setting${applied === 1 ? "" : "s"} from a configuration file; skipped ${skipped} invalid or restricted key${skipped === 1 ? "" : "s"}.`,
    });
    return reply.send({ ok: true, applied, skipped });
  });

  // Connection test — one gateway per call, reusing the currently-saved
  // credentials (never the value of an unsaved, in-progress edit). See
  // lib/connectionTest.ts for what each gateway's test actually proves.
  app.post("/api/settings/payments/:method/test", { preHandler: csrfProtect }, async (req, reply) => {
    const { method } = req.params as { method: string };
    const tester = CONNECTION_TESTS[method];
    if (!tester) return reply.code(400).send({ error: "Unknown payment method." });
    const result = await tester();
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "payment_method_test",
      targetType: "setting",
      details: `Tested the ${PAYMENT_METHODS[method]?.label ?? method} connection — ${result.ok ? "succeeded" : "failed"}.`,
    });
    return reply.send(result);
  });

  // Re-checks the currently-saved Telegram token/channel without requiring a
  // resave — the validators already run inline during /edit; this exposes
  // them as a standalone, side-effect-free check.
  app.post("/api/settings/telegram/test", { preHandler: csrfProtect }, async (req, reply) => {
    const target = (req.body as { target?: string } | undefined)?.target ?? "";
    if (!["bot_token", "notif_bot_token", "public_channel_id"].includes(target)) {
      return reply.code(400).send({ error: "Unknown Telegram field to test." });
    }

    let result: { ok: boolean; detail: string };
    if (target === "public_channel_id") {
      const channelId = await getSetting(prisma, "public_channel_id");
      const botToken = (await getSetting(prisma, "notif_bot_token")) ?? (await getSetting(prisma, "bot_token"));
      if (!channelId) result = { ok: false, detail: "No channel is set yet." };
      else if (!botToken) result = { ok: false, detail: "Set a bot token first, then test the channel." };
      else {
        const check = await getChannelValidator()(botToken, channelId);
        result = check.ok
          ? { ok: true, detail: `Connected — channel "${check.title ?? channelId}" is reachable.` }
          : { ok: false, detail: "Couldn't reach that channel with the current bot token." };
      }
    } else {
      const token = await getSetting(prisma, target);
      if (!token) result = { ok: false, detail: "No token is set yet." };
      else {
        const check = await getTokenValidator()(token);
        result = check.ok
          ? { ok: true, detail: `Connected as @${check.username ?? "unknown"}.` }
          : { ok: false, detail: "Telegram rejected the stored token." };
      }
    }

    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "telegram_test",
      targetType: "setting",
      details: `Tested the "${EDITABLE[target]}" Telegram connection — ${result.ok ? "succeeded" : "failed"}.`,
    });
    return reply.send(result);
  });

  // Re-checks the currently-saved SMTP credentials without sending a real
  // email — just opens the connection and authenticates (nodemailer's
  // transporter.verify()), same non-mutating shape as the Telegram test above.
  app.post("/api/settings/smtp/test", { preHandler: csrfProtect }, async (req, reply) => {
    const smtp = await getSmtpCreds(prisma);
    let result: { ok: boolean; detail: string };
    if (!smtp) {
      result = { ok: false, detail: "SMTP host and from-address are not both set." };
    } else {
      try {
        await verifySmtp(smtp);
        result = { ok: true, detail: `Connected to ${smtp.host}:${smtp.port} and authenticated.` };
      } catch (err) {
        result = { ok: false, detail: `SMTP connection failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "smtp_test",
      targetType: "setting",
      details: `Tested the SMTP connection — ${result.ok ? "succeeded" : "failed"}.`,
    });
    return reply.send(result);
  });

  // Owner-gated, session-authenticated restart trigger for post-setup use —
  // deliberately a SEPARATE route from /setup/restart (apps/web-admin/src/routes/setup.ts),
  // which is intentionally unauthenticated because it runs before any admin
  // session exists during the first-run wizard. Reusing that route directly
  // from this authenticated Settings button would mean either leaving it
  // permanently unauthenticated (already the case, but not something a
  // prominent in-app button should rely on) or breaking the wizard's own
  // pre-auth use of it — a new, gated route avoids both.
  app.post("/api/settings/restart", { preHandler: csrfProtect }, async (req, reply) => {
    if (req.admin!.role !== "super") return reply.code(403).send({ error: "Only the owner can restart the bot." });
    const target = process.env.RESTART_TRIGGER_FILE ?? join(process.cwd(), "tmp", "restart.txt");
    let restarted = true;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, new Date().toISOString());
      logger.info("Settings: wrote Passenger restart trigger file to reboot the app");
    } catch (err) {
      restarted = false;
      logger.warn({ err }, "Settings: failed to write Passenger restart trigger file — the app needs a manual restart from the hosting panel");
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "bot_restart",
      targetType: "setting",
      details: "Restarted the bot process to apply a pending token or channel change.",
    });
    return reply.send({ ok: true, restarted });
  });

  app.post("/api/settings/payments/toggle", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const method = PAYMENT_METHODS[body.method ?? ""];
    if (!method) return reply.code(400).send({ error: "Unknown payment method." });
    const value = (body.enabled ?? "").toString().toLowerCase() === "true" ? "true" : "false";
    await setSetting(prisma, method.enabledKey, value);
    await logAdminAction(prisma, { adminId: req.admin!.userId, action: "payment_method_toggle", targetType: "setting", details: `Turned ${method.label} ${value === "true" ? "on" : "off"}.` });
    return reply.send({ ok: true });
  });

  app.post("/api/settings/fx/refresh", { preHandler: csrfProtect }, async (req, reply) => {
    try {
      const r = await refreshUsdIdrRate(prisma, { force: true });
      if (r.status === "updated") {
        await logAdminAction(prisma, { adminId: req.admin!.userId, action: "setting_set", targetType: "setting", details: `Refreshed the USDT rate from the market to Rp${r.rate.toString()}.` });
      }
      return reply.send({
        ok: true,
        status: r.status,
        rate: r.status !== "disabled" ? r.rate.toString() : null,
        market: r.status !== "disabled" ? r.market.toString() : null,
      });
    } catch (err) {
      logger.warn({ err }, "Manual USDT exchange-rate refresh failed — keeping the previously saved rate");
      return reply.code(503).send({ error: "Couldn't reach the exchange-rate service. Try again in a bit." });
    }
  });

  app.post("/api/settings/password", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const { current_password: currentPassword = "", new_password: newPassword = "" } = body;
    if (newPassword.length < 8) return reply.code(400).send({ error: "New password must be at least 8 characters." });
    const key = passwordHashKey(req.admin!.telegramId);
    const stored = await getSetting(prisma, key);
    if (!stored || !verifyPassword(currentPassword, stored)) return reply.code(403).send({ error: "Current password is incorrect." });
    await setSetting(prisma, key, hashPassword(newPassword));
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_password_change",
      targetType: "setting",
      details: "Changed their web-admin login password.",
    });
    logger.info(`Web admin with Telegram id ${req.admin!.telegramId} changed their own password`);

    // Rotate the session jti (M-16 fix — mirrors the storefront's Storefront-2
    // guard and this app's own /reset and /login) so a stolen session cookie
    // stops authenticating the moment its owner changes their password. The
    // cookie is re-issued for THIS request only, so the admin who just changed
    // it stays logged in on their own device — every other device's cookie
    // (still carrying the old jti) is what gets invalidated.
    const jti = newJti();
    await setSetting(prisma, sessionJtiKey(req.admin!.telegramId), jti);
    const { raw } = makeSession(req.admin!.userId, req.admin!.telegramId, jti);
    reply.setCookie(config.WEB_COOKIE_NAME, raw, {
      path: "/",
      maxAge: config.WEB_SESSION_TTL_HOURS * 3600,
      httpOnly: true,
      sameSite: "lax",
      secure: config.WEB_COOKIE_SECURE,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/settings/2fa/begin", { preHandler: csrfProtect }, async (req, reply) => {
    const tg = req.admin!.telegramId;
    if ((await getSetting(prisma, twoFaSecretKey(tg))) !== null) return reply.code(409).send({ error: "2FA is already enabled." });
    const secret = generateTotpSecret();
    await setSetting(prisma, twoFaPendingKey(tg), secret);
    return reply.send({ ok: true, secret, uri: otpauthUri(secret, String(tg)) });
  });

  app.post("/api/settings/2fa/cancel", { preHandler: csrfProtect }, async (req, reply) => {
    await deleteSetting(prisma, twoFaPendingKey(req.admin!.telegramId));
    return reply.send({ ok: true });
  });

  app.post("/api/settings/2fa/enable", { preHandler: csrfProtect }, async (req, reply) => {
    const tg = req.admin!.telegramId;
    const pending = await getSetting(prisma, twoFaPendingKey(tg));
    if (!pending) return reply.code(400).send({ error: "Start 2FA setup first." });
    const code = ((req.body as Record<string, string>).totp_code ?? "").trim();
    if (!verifyTotp(pending, code)) return reply.code(400).send({ error: "That code is wrong — check your authenticator." });
    await setSetting(prisma, twoFaSecretKey(tg), pending);
    await deleteSetting(prisma, twoFaPendingKey(tg));
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_2fa_enable",
      targetType: "setting",
      details: "Enabled two-factor authentication (2FA) for their web-admin login.",
    });
    return reply.send({ ok: true });
  });

  app.post("/api/settings/2fa/disable", { preHandler: csrfProtect }, async (req, reply) => {
    const tg = req.admin!.telegramId;
    const secret = await getSetting(prisma, twoFaSecretKey(tg));
    if (!secret) return reply.code(400).send({ error: "2FA isn't enabled." });
    const body = (req.body ?? {}) as Record<string, string>;
    const stored = await getSetting(prisma, passwordHashKey(tg));
    if (!stored || !verifyPassword(body.current_password ?? "", stored)) return reply.code(403).send({ error: "Current password is incorrect." });
    if (!verifyTotp(secret, body.totp_code ?? "")) return reply.code(400).send({ error: "That 2FA code is wrong." });
    await deleteSetting(prisma, twoFaSecretKey(tg));
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_2fa_disable",
      targetType: "setting",
      details: "Disabled two-factor authentication (2FA) for their web-admin login.",
    });
    return reply.send({ ok: true });
  });
}
