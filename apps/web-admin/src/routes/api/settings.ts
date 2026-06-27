import type { FastifyInstance } from "fastify";
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
} from "@app/db";
import {
  hashPassword,
  verifyPassword,
  passwordHashKey,
  twoFaSecretKey,
  twoFaPendingKey,
  generateTotpSecret,
  verifyTotp,
  otpauthUri,
} from "../../auth";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { getTokenValidator, getChannelValidator } from "../../lib/telegramCheck";

const EDITABLE: Record<string, string> = {
  support_contact: "Support contact handle/text",
  welcome: "Welcome message",
  banner_image: "Banner image — Telegram file_id",
  shop_name: "Shop name",
  shop_tagline: "Shop tagline",
  support_whatsapp: "WhatsApp number for website",
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
};

const SECRET_KEYS = new Set(["tokopay_secret", "paydisini_apikey", "bot_token", "notif_bot_token", "bybit_api_key", "bybit_api_secret", "binance_api_key", "binance_api_secret", "nowpayments_api_key", "nowpayments_ipn_secret", "bscscan_api_key"]);
const TOKEN_KEYS = new Set(["bot_token", "notif_bot_token"]);
const BOT_TOKEN_FIELD_KEYS = new Set(["bot_token", "bot_username", "notif_bot_token", "public_channel_id"]);
const SECRET_PREFIXES = ["web_admin_password_hash:", "web_session_jti:", "web_2fa_secret:", "web_2fa_pending:", "shop_session_jti:"];
const isSecret = (key: string) => SECRET_KEYS.has(key) || SECRET_PREFIXES.some(p => key.startsWith(p));

const PAYMENT_METHODS: Record<string, { enabledKey: string; credKeys: string[]; label: string }> = {
  tokopay: { enabledKey: "tokopay_enabled", credKeys: ["tokopay_merchant_id", "tokopay_secret"], label: "TokoPay" },
  paydisini: { enabledKey: "paydisini_enabled", credKeys: ["paydisini_userkey", "paydisini_apikey"], label: "PayDisini" },
  nowpayments: { enabledKey: "nowpayments_enabled", credKeys: ["nowpayments_api_key", "nowpayments_ipn_secret"], label: "NOWPayments" },
  bybit: { enabledKey: "bybit_enabled", credKeys: ["bybit_uid", "bybit_api_key", "bybit_api_secret"], label: "Bybit" },
  bybit_bsc: { enabledKey: "bybit_bsc_enabled", credKeys: ["bybit_bsc_deposit_address", "bybit_api_key", "bybit_api_secret"], label: "Bybit BSC" },
  binance_internal: { enabledKey: "binance_internal_enabled", credKeys: ["binance_receive_uid", "binance_api_key", "binance_api_secret"], label: "Binance Internal Transfer" },
};

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
    const key = body.key ?? "";
    if (!(key in EDITABLE)) return reply.code(400).send({ error: "That setting is not editable here." });
    const value = (body.value ?? "").trim();
    if (SECRET_KEYS.has(key) && value === "") return reply.send({ ok: true, unchanged: true });

    if (TOKEN_KEYS.has(key)) {
      if (req.admin!.role !== "super") return reply.code(403).send({ error: "Only the owner can change bot tokens." });
      if (value === "-") {
        await deleteSetting(prisma, key);
        await logAdminAction(prisma, { adminId: req.admin!.userId, action: "setting_clear", targetType: "setting", details: `Cleared setting "${key}".` });
        return reply.send({ ok: true, cleared: true });
      }
      const check = await getTokenValidator()(value);
      if (!check.ok) return reply.code(400).send({ error: "Telegram rejected that token. Check it in BotFather and try again." });
      await setSetting(prisma, key, value);
      if (key === "bot_token" && check.username) await setSetting(prisma, "bot_username", check.username);
      await logAdminAction(prisma, { adminId: req.admin!.userId, action: "setting_set", targetType: "setting", details: `Changed setting "${key}" (updated).` });
      return reply.send({ ok: true, needsRestart: true });
    }

    if (key === "public_channel_id") {
      if (req.admin!.role !== "super") return reply.code(403).send({ error: "Only the owner can change the channel." });
      if (value === "-") {
        await deleteSetting(prisma, key);
        await logAdminAction(prisma, { adminId: req.admin!.userId, action: "setting_clear", targetType: "setting", details: `Cleared setting "${key}".` });
        return reply.send({ ok: true, cleared: true });
      }
      const botToken = (await getSetting(prisma, "notif_bot_token")) ?? (await getSetting(prisma, "bot_token"));
      if (!botToken) return reply.code(400).send({ error: "Set a bot token first, then add the channel." });
      const check = await getChannelValidator()(botToken, value);
      if (!check.ok || typeof check.id !== "number") return reply.code(400).send({ error: "Couldn't find that channel." });
      await setSetting(prisma, key, String(check.id));
      await logAdminAction(prisma, { adminId: req.admin!.userId, action: "setting_set", targetType: "setting", details: `Changed setting "${key}" to ${check.id}.` });
      return reply.send({ ok: true, needsRestart: true });
    }

    if (key.endsWith("_min_amount") && value !== "") {
      let valid = false;
      try { const d = new Decimal(value); valid = d.isFinite() && d.greaterThan(0); } catch { valid = false; }
      if (!valid) return reply.code(400).send({ error: "Minimum amount must be a positive number, or blank to disable." });
    }

    if (key === "bybit_bsc_required_confirmations" && value !== "") {
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return reply.code(400).send({ error: "Required confirmations must be a positive whole number." });
    }

    const displayValue = SECRET_KEYS.has(key) ? "(updated)" : value.slice(0, 80);
    await setSetting(prisma, key, value);
    await logAdminAction(prisma, { adminId: req.admin!.userId, action: "setting_set", targetType: "setting", details: `Changed setting "${key}" to "${displayValue}".` });
    return reply.send({ ok: true });
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
    await logAdminAction(prisma, { adminId: req.admin!.userId, action: "web_password_change", targetType: "setting" });
    logger.info(`Web admin with Telegram id ${req.admin!.telegramId} changed their own password`);
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
    await logAdminAction(prisma, { adminId: req.admin!.userId, action: "web_2fa_enable", targetType: "setting" });
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
    await logAdminAction(prisma, { adminId: req.admin!.userId, action: "web_2fa_disable", targetType: "setting" });
    return reply.send({ ok: true });
  });
}
