/**
 * Settings — view runtime settings, edit a whitelist of keys, change password.
 * Port of routers/settings.py. The `settings` table is shared with the bot, so
 * only whitelisted keys may be edited and secret-bearing keys are never shown.
 */
import type { FastifyInstance } from "fastify";
import { logger } from "@app/core/logger";
import {
  prisma,
  listAllSettings,
  getSetting,
  setSetting,
  deleteSetting,
  logAdminAction,
  refreshUsdIdrRate,
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
} from "../auth";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { flashOrRedirect } from "../flash";
import { setTokenValidator, getTokenValidator, setChannelValidator, getChannelValidator } from "../lib/telegramCheck";

// Re-exported for tests that import setTokenValidator from this module.
export { setTokenValidator, setChannelValidator };

// Whitelisted runtime keys the web may edit, with human labels.
const EDITABLE: Record<string, string> = {
  support_contact: "Support contact handle/text",
  welcome: "Welcome message",
  // Banner shown on top of the bot's main menu + product list. Placeholder for
  // now: paste a Telegram file_id, or (easier) set the image from the bot's
  // Settings → Banner image. Clear this field to turn the banner off.
  banner_image: "Banner image — Telegram file_id (set it from the bot for now; placeholder)",
  // Shop identity shown in the storefront header/footer.
  shop_name: "Shop name (shown on the website)",
  shop_tagline: "Shop tagline (shown on the website)",
  // WhatsApp contact button on the website's home page; empty hides the button.
  support_whatsapp: "WhatsApp number for the website — international format without + (e.g. 62812…); leave empty to hide the button",
  // ---- Payments (plan.md §15.9 / §16.1) ----
  usd_idr_rate: "USDT rate — Rupiah per 1 USDT; updated from the market automatically (edit by hand only if auto-update is off)",
  usd_idr_rate_auto: "Auto-update the USDT rate from the market — on unless set to false",
  usd_idr_rate_rounding: "Round the market rate to the nearest … rupiah (e.g. 100)",
  tokopay_merchant_id: "TokoPay merchant ID",
  tokopay_secret: "TokoPay secret key",
  tokopay_enabled: "Rupiah payments on the website — true / false",
  paydisini_userkey: "PayDisini user key",
  paydisini_apikey: "PayDisini API key",
  paydisini_enabled: "Rupiah payments via PayDisini on the website — true / false",
  paydisini_default_channel: "PayDisini channel/service code — default QRIS",
  nowpayments_api_key: "NOWPayments API key",
  nowpayments_ipn_secret: "NOWPayments IPN secret (verifies payment callbacks)",
  nowpayments_enabled: "USDT payments via NOWPayments on the website — true / false",
  nowpayments_pay_currency: "Underlying crypto network for NOWPayments — e.g. usdttrc20 (USDT on TRON), usdtbsc, usdterc20",
  // ---- Bybit USDT-BSC deposit (auto-confirmed; leave blank to disable) ----
  bybit_deposit_address: "Bybit BEP20 (BSC) USDT deposit address shown to buyers",
  bybit_api_key: "Bybit API key — Wallet READ-ONLY (no Withdraw)",
  bybit_api_secret: "Bybit API secret",
  bybit_enabled: "Bybit USDT deposits on the website — true / false",
  // ---- Binance Internal Transfer (UID-based auto-confirm; leave blank to disable) ----
  binance_receive_uid: "Binance UID buyers transfer to (Internal Transfer)",
  binance_api_key: "Binance API key — READ-ONLY (no trading/withdraw)",
  binance_api_secret: "Binance API secret",
  binance_internal_enabled: "Binance Internal Transfer on the website — true / false",
  // ---- Bot & notifications (plan.md §16.1) ----
  bot_token: "Order Bot token — the main @YourBot that receives customer orders (get from BotFather → /mybots → API Token); restart the app after saving",
  bot_username: "Bot username without the @ — filled in automatically when you save the Order Bot token above",
  notif_bot_token: "Channel Notifier Bot token — a SEPARATE bot used only to post announcements to your public channel (optional; leave blank and the Order Bot will post to the channel instead)",
  public_channel_id: "Public channel for announcements — paste the channel link (t.me/…), @username, or numeric -100… ID; saved as the numeric ID. Restart the app after saving.",
};

// UI grouping (settings.njk tabs): every EDITABLE key belongs to exactly one
// group; anything left over falls back into the Website tab so a new key can
// never silently disappear from the page.
// shop_name / shop_tagline / welcome / banner_image now live on the Branding
// page; only support_whatsapp (contact) stays here. They remain in EDITABLE so
// the read-only "all options" table and the generic /settings/edit fallback
// still work, but BRANDING_KEYS keeps them out of the editable Settings form.
const WEBSITE_KEYS = new Set(["support_whatsapp"]);
const BOT_MESSAGE_KEYS = new Set(["support_contact"]);
const BRANDING_KEYS = new Set(["shop_name", "shop_tagline", "welcome", "banner_image"]);
const BOT_TOKEN_FIELD_KEYS = new Set(["bot_token", "bot_username", "notif_bot_token", "public_channel_id"]);
const PAY_RATE_KEYS = new Set(["usd_idr_rate", "usd_idr_rate_auto", "usd_idr_rate_rounding"]);
const PAY_QRIS_KEYS = new Set(["tokopay_merchant_id", "tokopay_secret", "tokopay_enabled"]);
const PAY_PAYDISINI_KEYS = new Set(["paydisini_userkey", "paydisini_apikey", "paydisini_enabled", "paydisini_default_channel"]);
const PAY_NOWPAYMENTS_KEYS = new Set(["nowpayments_api_key", "nowpayments_ipn_secret", "nowpayments_enabled", "nowpayments_pay_currency"]);
const PAY_BYBIT_KEYS = new Set(["bybit_deposit_address", "bybit_api_key", "bybit_api_secret", "bybit_enabled"]);
const PAY_BINANCE_INTERNAL_KEYS = new Set(["binance_receive_uid", "binance_api_key", "binance_api_secret", "binance_internal_enabled"]);

// Per-method on/off toggle — the whitelist guardrail for POST /settings/payments/toggle.
// `enabledKey` is the *_enabled settings key; `credKeys` are the credential keys whose
// presence means the method is "configured". `label` is for the audit/flash copy.
// The toggle is rendered as a button per method (mirroring 2FA), so these *_enabled
// keys are filtered out of the raw text-field lists below — they stay in EDITABLE only
// so the read-only "all options" table + the generic /settings/edit fallback still work.
const PAYMENT_METHODS: Record<string, { enabledKey: string; credKeys: string[]; label: string }> = {
  tokopay: { enabledKey: "tokopay_enabled", credKeys: ["tokopay_merchant_id", "tokopay_secret"], label: "TokoPay" },
  paydisini: { enabledKey: "paydisini_enabled", credKeys: ["paydisini_userkey", "paydisini_apikey"], label: "PayDisini" },
  nowpayments: { enabledKey: "nowpayments_enabled", credKeys: ["nowpayments_api_key", "nowpayments_ipn_secret"], label: "NOWPayments" },
  bybit: { enabledKey: "bybit_enabled", credKeys: ["bybit_deposit_address", "bybit_api_key", "bybit_api_secret"], label: "Bybit" },
  binance_internal: { enabledKey: "binance_internal_enabled", credKeys: ["binance_receive_uid", "binance_api_key", "binance_api_secret"], label: "Binance Internal Transfer" },
};

// The *_enabled keys are surfaced as toggles, not raw text fields.
const ENABLED_KEYS = new Set(Object.values(PAYMENT_METHODS).map((m) => m.enabledKey));

// Default ON: only the literal "false" (trimmed, lowercased) disables — matches
// the crud getters byte-for-byte. `configured` = all credential keys present.
function paymentMethodState(method: { enabledKey: string; credKeys: string[] }, currentValues: Record<string, string>) {
  const flag = currentValues[method.enabledKey];
  const enabled = (flag ?? "").trim().toLowerCase() !== "false";
  const configured = method.credKeys.every((k) => Boolean((currentValues[k] ?? "").trim()));
  return { enabled, configured };
}

// Write-only editable secrets: never echoed back into the form, hidden in the
// "All saved options" table, audited as "(updated)" without the value.
const SECRET_KEYS = new Set(["tokopay_secret", "paydisini_apikey", "bot_token", "notif_bot_token", "bybit_api_key", "bybit_api_secret", "binance_api_key", "binance_api_secret", "nowpayments_api_key", "nowpayments_ipn_secret"]);

// Bot tokens get the §16.4 "don't brick the bot" treatment: owner-only, and
// Telegram must accept the token (getMe) before anything is saved.
const TOKEN_KEYS = new Set(["bot_token", "notif_bot_token"]);

const SECRET_PREFIXES = [
  "web_admin_password_hash:",
  "web_session_jti:",
  "web_2fa_secret:",
  "web_2fa_pending:",
  "shop_session_jti:", // storefront customer sessions
];
const isSecret = (key: string) =>
  SECRET_KEYS.has(key) || SECRET_PREFIXES.some((p) => key.startsWith(p));

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
    // Secrets are write-only: the form never carries the stored value, only a
    // "saved" hint; leaving the field blank keeps the existing value.
    const allFields = Object.entries(EDITABLE).map(([key, label]) => ({
      key,
      label,
      secret: SECRET_KEYS.has(key),
      has_value: Boolean(currentValues[key]),
      value: SECRET_KEYS.has(key) ? "" : currentValues[key] ?? "",
      // Bot identity (token/username/notifier/channel) is resolved ONCE at boot
      // and stamped into the runtime (resolveBotCredentials → @app/core/runtime),
      // so a change only takes effect after a restart. Every other editable key
      // is read live via getSetting, so it applies immediately.
      needs_restart: BOT_TOKEN_FIELD_KEYS.has(key),
    }));
    // The *_enabled keys render as on/off toggles (below), never as raw text fields.
    const pick = (keys: Set<string>) => allFields.filter((f) => keys.has(f.key) && !ENABLED_KEYS.has(f.key));
    const grouped = new Set([
      ...WEBSITE_KEYS, ...BOT_MESSAGE_KEYS, ...BOT_TOKEN_FIELD_KEYS,
      ...PAY_RATE_KEYS, ...PAY_QRIS_KEYS, ...PAY_PAYDISINI_KEYS, ...PAY_NOWPAYMENTS_KEYS, ...PAY_BYBIT_KEYS,
      ...PAY_BINANCE_INTERNAL_KEYS, ...BRANDING_KEYS,
    ]);
    // Leftover guard: an EDITABLE key missing from every group still shows up.
    const websiteFields = [
      ...pick(WEBSITE_KEYS),
      ...allFields.filter((f) => !grouped.has(f.key)),
    ];

    // Per-method on/off state for the toggle pill + "add keys to go live" hint.
    // Read flag + creds-present straight off currentValues (no extra queries).
    const payMethodState: Record<string, { enabled: boolean; configured: boolean }> = {};
    for (const [id, m] of Object.entries(PAYMENT_METHODS)) {
      payMethodState[id] = paymentMethodState(m, currentValues);
    }

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
      website_fields: websiteFields,
      bot_message_fields: pick(BOT_MESSAGE_KEYS),
      bot_token_fields: pick(BOT_TOKEN_FIELD_KEYS),
      pay_rate_fields: pick(PAY_RATE_KEYS),
      pay_qris_fields: pick(PAY_QRIS_KEYS),
      pay_paydisini_fields: pick(PAY_PAYDISINI_KEYS),
      pay_nowpayments_fields: pick(PAY_NOWPAYMENTS_KEYS),
      pay_bybit_fields: pick(PAY_BYBIT_KEYS),
      pay_binance_internal_fields: pick(PAY_BINANCE_INTERNAL_KEYS),
      pay_method_state: payMethodState,
      is_owner: req.admin!.role === "super",
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
      return flashOrRedirect(req, reply, "/settings", "2FA is already enabled.", "error");
    }
    await setSetting(prisma, twoFaPendingKey(tg), generateTotpSecret());
    return flashOrRedirect(req, reply, "/settings", "Add the secret to your authenticator, then enter a code to finish.", "info");
  });

  app.post("/settings/2fa/cancel", { preHandler: csrfProtect }, async (req, reply) => {
    await deleteSetting(prisma, twoFaPendingKey(req.admin!.telegramId));
    return flashOrRedirect(req, reply, "/settings", "2FA setup cancelled.", "info");
  });

  app.post("/settings/2fa/enable", { preHandler: csrfProtect }, async (req, reply) => {
    const tg = req.admin!.telegramId;
    const pending = await getSetting(prisma, twoFaPendingKey(tg));
    if (!pending) {
      return flashOrRedirect(req, reply, "/settings", "Start 2FA setup first.", "error");
    }
    const code = ((req.body as Record<string, string>).totp_code ?? "").trim();
    if (!verifyTotp(pending, code)) {
      return flashOrRedirect(req, reply, "/settings", "That code is wrong — check your authenticator and try again.", "error");
    }
    await setSetting(prisma, twoFaSecretKey(tg), pending);
    await deleteSetting(prisma, twoFaPendingKey(tg));
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_2fa_enable",
      targetType: "setting", // never log the secret
    });
    return flashOrRedirect(req, reply, "/settings", "2FA enabled. You'll need a code at every login.", "success");
  });

  app.post("/settings/2fa/disable", { preHandler: csrfProtect }, async (req, reply) => {
    const tg = req.admin!.telegramId;
    const secret = await getSetting(prisma, twoFaSecretKey(tg));
    if (!secret) {
      return flashOrRedirect(req, reply, "/settings", "2FA isn't enabled.", "error");
    }
    const body = (req.body ?? {}) as Record<string, string>;
    const stored = await getSetting(prisma, passwordHashKey(tg));
    if (!stored || !verifyPassword(body.current_password ?? "", stored)) {
      return flashOrRedirect(req, reply, "/settings", "Current password is incorrect.", "error");
    }
    if (!verifyTotp(secret, body.totp_code ?? "")) {
      return flashOrRedirect(req, reply, "/settings", "That 2FA code is wrong.", "error");
    }
    await deleteSetting(prisma, twoFaSecretKey(tg));
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_2fa_disable",
      targetType: "setting",
    });
    return flashOrRedirect(req, reply, "/settings", "2FA disabled.", "success");
  });

  // "Update the USDT rate now": pull the live market rate, round it, save it.
  // Force-bypasses the auto switch — pressing the button is explicit intent.
  app.post("/settings/fx/refresh", { preHandler: csrfProtect }, async (req, reply) => {
    try {
      const r = await refreshUsdIdrRate(prisma, { force: true });
      if (r.status === "unchanged") {
        return flashOrRedirect(
          req,
          reply,
          "/settings",
          `Already up to date: Rp${r.rate.toString()} per 1 USDT (market ${r.market.toString()}).`,
          "info",
        );
      }
      if (r.status === "updated") {
        await logAdminAction(prisma, {
          adminId: req.admin!.userId,
          action: "setting_set",
          targetType: "setting",
          details: `usd_idr_rate=${r.rate.toString()} (market refresh)`,
        });
        return flashOrRedirect(
          req,
          reply,
          "/settings",
          `USDT rate updated to Rp${r.rate.toString()} per 1 USDT (market ${r.market.toString()}).`,
          "success",
        );
      }
    } catch (err) {
      logger.warn({ err }, "Manual FX refresh failed");
    }
    return flashOrRedirect(
      req,
      reply,
      "/settings",
      "Couldn't reach the exchange-rate service — the saved rate is unchanged. Try again in a bit.",
      "error",
    );
  });

  // Per-method on/off toggle for the 5 active payment methods. The switch is
  // independent of credentials (it never exposes a method with missing keys —
  // the crud getters AND the checkout still require creds). Whitelist-guarded:
  // an unknown `method` is rejected so an arbitrary settings key is never written.
  app.post("/settings/payments/toggle", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const method = PAYMENT_METHODS[body.method ?? ""];
    if (!method) {
      return flashOrRedirect(req, reply, "/settings", "Unknown payment method.", "error");
    }
    // Anything other than the literal "true" turns the method off (default-ON
    // semantics: we still write the explicit flag so the state is unambiguous).
    const value = (body.enabled ?? "").trim().toLowerCase() === "true" ? "true" : "false";
    await setSetting(prisma, method.enabledKey, value);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "payment_method_toggle",
      targetType: "setting",
      details: `${method.enabledKey}=${value}`,
    });
    const verb = value === "true" ? "on" : "off";
    return flashOrRedirect(req, reply, "/settings", `${method.label} turned ${verb}.`, "success");
  });

  app.post("/settings/edit", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const key = body.key ?? "";
    if (!(key in EDITABLE)) {
      return flashOrRedirect(req, reply, "/settings", "That setting is not editable here.", "error");
    }
    const value = (body.value ?? "").trim();
    // Write-only secrets: an empty submit means "keep what's saved", and the
    // audit trail never records the value (CLAUDE.md: never log secrets).
    if (SECRET_KEYS.has(key) && value === "") {
      return flashOrRedirect(req, reply, "/settings", `'${key}' left unchanged.`, "info");
    }

    // §16.4 "don't brick the bot": tokens are owner-only and must pass a live
    // getMe check before anything is stored. A bad token is rejected outright.
    if (TOKEN_KEYS.has(key)) {
      if (req.admin!.role !== "super") {
        return flashOrRedirect(req, reply, "/settings", "Only the owner can change bot tokens.", "error");
      }
      // Escape hatch: a single "-" removes the saved token so the server's own
      // config (env) is used again after a restart — the §16.4 recovery path.
      if (value === "-") {
        await deleteSetting(prisma, key);
        await logAdminAction(prisma, {
          adminId: req.admin!.userId,
          action: "setting_clear",
          targetType: "setting",
          details: key,
        });
        return flashOrRedirect(
          req,
          reply,
          "/settings",
          "Saved token removed. After a restart the server's own configuration is used again.",
          "success",
        );
      }
      const check = await getTokenValidator()(value);
      if (!check.ok) {
        return flashOrRedirect(
          req,
          reply,
          "/settings",
          "Telegram rejected that token, so nothing was saved. Check it in BotFather and try again.",
          "error",
        );
      }
      await setSetting(prisma, key, value);
      // The main token also refreshes the stored username (referral links and
      // the website's Telegram login button use it).
      if (key === "bot_token" && check.username) {
        await setSetting(prisma, "bot_username", check.username);
      }
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "setting_set",
        targetType: "setting",
        details: `${key}=(updated)`, // never the value
      });
      return flashOrRedirect(
        req,
        reply,
        "/settings",
        "Token saved and checked with Telegram. Restart the app to start using it.",
        "success",
      );
    }

    // Channel id: owner-only, resolved via getChat before storing (numeric id).
    // Not a secret — the value is public and shown back in the form.
    if (key === "public_channel_id") {
      if (req.admin!.role !== "super") {
        return flashOrRedirect(req, reply, "/settings", "Only the owner can change the channel.", "error");
      }
      // Escape hatch: "-" removes the Setting so env config is used after restart.
      if (value === "-") {
        await deleteSetting(prisma, key);
        await logAdminAction(prisma, {
          adminId: req.admin!.userId, action: "setting_clear", targetType: "setting", details: key,
        });
        return flashOrRedirect(req, reply, "/settings", "Channel cleared. After a restart the server's own configuration is used again.", "success");
      }
      // getChat needs a bot token — notifier token if set, else the main token.
      // Read the raw Settings (not resolveBotCredentials' env fallback): this is
      // a live, owner-triggered check, so it must use a token the owner actually
      // saved here, not a possibly-stale bootstrap value from the environment.
      const botToken = (await getSetting(prisma, "notif_bot_token")) ?? (await getSetting(prisma, "bot_token"));
      if (!botToken) {
        return flashOrRedirect(req, reply, "/settings", "Set a bot token first, then add the channel.", "error");
      }
      const check = await getChannelValidator()(botToken, value);
      if (!check.ok || typeof check.id !== "number") {
        return flashOrRedirect(req, reply, "/settings", "Couldn't find that channel. Check the link and that the bot is a member/admin of it.", "error");
      }
      await setSetting(prisma, key, String(check.id));
      await logAdminAction(prisma, {
        adminId: req.admin!.userId, action: "setting_set", targetType: "setting",
        details: `${key}=${check.id}`, // channel id is public, fine to log
      });
      return flashOrRedirect(req, reply, "/settings", `Channel saved (resolved to ${check.id}). Restart the app to apply.`, "success");
    }

    const displayValue = SECRET_KEYS.has(key)
      ? "(updated)"
      : value.slice(0, 80) + (value.length > 80 ? "…" : "");
    await setSetting(prisma, key, value);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "setting_set",
      targetType: "setting",
      details: `${key}=${displayValue}`,
    });
    return flashOrRedirect(req, reply, "/settings", `Setting '${key}' updated.`, "success");
  });

  app.post("/settings/password", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const currentPassword = body.current_password ?? "";
    const newPassword = body.new_password ?? "";
    const confirmPassword = body.confirm_password ?? "";

    if (newPassword.length < 8) {
      return flashOrRedirect(req, reply, "/settings", "New password must be at least 8 characters.", "error");
    }
    if (newPassword !== confirmPassword) {
      return flashOrRedirect(req, reply, "/settings", "New passwords do not match.", "error");
    }

    const key = passwordHashKey(req.admin!.telegramId);
    const stored = await getSetting(prisma, key);
    if (!stored || !verifyPassword(currentPassword, stored)) {
      return flashOrRedirect(req, reply, "/settings", "Current password is incorrect.", "error");
    }
    await setSetting(prisma, key, hashPassword(newPassword));
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "web_password_change",
      targetType: "setting", // never log the password itself
    });
    logger.info(`Web admin password changed for telegram_id=${req.admin!.telegramId}`);
    return flashOrRedirect(req, reply, "/settings", "Password changed.", "success");
  });
}
