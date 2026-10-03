import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { applyCustomEmoji, resetCustomEmojiMap } from "@app/core/customEmoji";
import { verifySmtp } from "@app/core/mailer";

vi.mock("@app/core/mailer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/mailer")>()),
  verifySmtp: vi.fn(),
}));
import { prisma, initDb, upsertUser, setSetting, getSetting, getDecryptedSetting, setFxRateFetcher, getShopMinOrderAmountIdr } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import {
  makeSession,
  sessionJtiKey,
  newJti,
  passwordHashKey,
  hashPassword,
  twoFaSecretKey,
  twoFaPendingKey,
  generateTotpSecret,
  currentTotp,
} from "../src/auth";
import { buildApp } from "../src/server";
import { isSecretSettingKey } from "../src/routes/api/settings";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb(prisma);
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
  resetCustomEmojiMap(); // module-level state a settings save stamps live
});

function postJson(url: string, c: string | null, csrfToken: string, body: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
    payload: JSON.stringify(body),
  });
}

function getJson(url: string, c: string | null) {
  return app.inject({
    method: "GET",
    url,
    cookies: c ? { [COOKIE]: c } : {},
  });
}

describe("POST /api/settings/edit", () => {
  it("exposes independent per-channel service switches by default", async () => {
    const res = await getJson("/api/settings", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().serviceStates).toEqual([
      { id: "game_topup", label: "Top Up Game", enabledBot: true, enabledWeb: true },
      { id: "premium_apps", label: "Premium Apps", enabledBot: true, enabledWeb: true },
    ]);
  });

  it("persists one channel of one service, leaves the other channel and the legacy key alone, and audits in plain words", async () => {
    const botOff = await postJson("/api/settings/services/toggle", cookie, csrf, { service: "game_topup", channel: "bot", enabled: false });
    expect(botOff.statusCode).toBe(200);
    expect(await getSetting(prisma, "service_game_topup_enabled_bot")).toBe("false");
    expect(await getSetting(prisma, "service_game_topup_enabled_web")).toBeNull();
    expect(await getSetting(prisma, "service_game_topup_enabled")).toBeNull();
    expect((await getJson("/api/settings", cookie)).json().serviceStates).toEqual([
      { id: "game_topup", label: "Top Up Game", enabledBot: false, enabledWeb: true },
      { id: "premium_apps", label: "Premium Apps", enabledBot: true, enabledWeb: true },
    ]);
    expect(await prisma.auditLog.findFirst({ where: { action: "setting_set", details: "Disabled Top Up Game for the Telegram bot." } })).toBeTruthy();

    const webOff = await postJson("/api/settings/services/toggle", cookie, csrf, { service: "game_topup", channel: "web", enabled: false });
    expect(webOff.statusCode).toBe(200);
    const botOn = await postJson("/api/settings/services/toggle", cookie, csrf, { service: "game_topup", channel: "bot", enabled: true });
    expect(botOn.statusCode).toBe(200);
    expect((await getJson("/api/settings", cookie)).json().serviceStates[0]).toEqual(
      { id: "game_topup", label: "Top Up Game", enabledBot: true, enabledWeb: false },
    );
    expect(await prisma.auditLog.findFirst({ where: { action: "setting_set", details: "Disabled Top Up Game for the website." } })).toBeTruthy();
    expect(await prisma.auditLog.findFirst({ where: { action: "setting_set", details: "Enabled Top Up Game for the Telegram bot." } })).toBeTruthy();
    expect(await getSetting(prisma, "service_game_topup_enabled")).toBeNull();
  });

  it("rejects an unknown service, a missing or invalid channel, and non-boolean input without writing", async () => {
    const bad = [
      { service: "nope", channel: "bot", enabled: false },
      { service: "game_topup", enabled: false },
      { service: "game_topup", channel: "sms", enabled: false },
      { service: "game_topup", channel: "bot", enabled: "yes" },
    ];
    for (const payload of bad) {
      const res = await postJson("/api/settings/services/toggle", cookie, csrf, payload);
      expect(res.statusCode).toBe(400);
    }
    expect(await getSetting(prisma, "service_game_topup_enabled_bot")).toBeNull();
    expect(await getSetting(prisma, "service_game_topup_enabled_web")).toBeNull();
  });

  it("reports a legacy-disabled service as disabled on both channels until a channel key is set", async () => {
    await setSetting(prisma, "service_premium_apps_enabled", "false");
    expect((await getJson("/api/settings", cookie)).json().serviceStates[1]).toEqual(
      { id: "premium_apps", label: "Premium Apps", enabledBot: false, enabledWeb: false },
    );
    await postJson("/api/settings/services/toggle", cookie, csrf, { service: "premium_apps", channel: "web", enabled: true });
    expect((await getJson("/api/settings", cookie)).json().serviceStates[1]).toEqual(
      { id: "premium_apps", label: "Premium Apps", enabledBot: false, enabledWeb: true },
    );
    expect(await getSetting(prisma, "service_premium_apps_enabled")).toBe("false");
  });

  it("happy path: edits a whitelisted key and audits", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "shop_name", value: "New Shop" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await getSetting(prisma, "shop_name")).toBe("New Shop");
    const audit = await prisma.auditLog.findFirst({ where: { action: "setting_set" } });
    expect(audit).toBeTruthy();
  });

  it("stores the CoinGecko API key encrypted and returns it only as a masked secret field", async () => {
    const saved = await postJson("/api/settings/edit", cookie, csrf, {
      key: "coingecko_api_key",
      value: "admin-coingecko-key",
    });
    expect(saved.statusCode).toBe(200);
    expect(await getSetting(prisma, "coingecko_api_key")).not.toBe("admin-coingecko-key");
    expect(await getDecryptedSetting(prisma, "coingecko_api_key")).toBe("admin-coingecko-key");

    const response = await getJson("/api/settings", cookie);
    const field = (response.json() as { fields: Array<{ key: string; label: string; secret: boolean; hasValue: boolean; value: string; needsRestart: boolean }> }).fields
      .find((entry) => entry.key === "coingecko_api_key");
    expect(field).toEqual({
      key: "coingecko_api_key",
      label: "CoinGecko API key",
      secret: true,
      hasValue: true,
      value: "",
      needsRestart: false,
    });
  });

  it("rejects a non-whitelisted key with 400, writes nothing", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "not_a_real_key", value: "x" });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "not_a_real_key")).toBeNull();
  });

  it("rejects a non-numeric smtp_port with 400, writes nothing", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "smtp_port", value: "not-a-number" });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "smtp_port")).toBeNull();
  });

  it("accepts a valid smtp_port", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "smtp_port", value: "465" });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "smtp_port")).toBe("465");
  });

  it("rejects an smtp_from that isn't an email or 'Name <email>' with 400", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "smtp_from", value: "not an address" });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "smtp_from")).toBeNull();
  });

  it("accepts a plain email and a 'Name <email>' form for smtp_from", async () => {
    let res = await postJson("/api/settings/edit", cookie, csrf, { key: "smtp_from", value: "no-reply@example.com" });
    expect(res.statusCode).toBe(200);
    res = await postJson("/api/settings/edit", cookie, csrf, { key: "smtp_from", value: "Shop <no-reply@example.com>" });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "smtp_from")).toBe("Shop <no-reply@example.com>");
  });

  it("rejects an owner_email that isn't a plain address with 400", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "owner_email", value: "not-an-email" });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "owner_email")).toBeNull();
  });

  it("rejects an owner_email in 'Display Name <email>' form (unlike smtp_from, no display-name form)", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "owner_email", value: "Owner <owner@example.com>" });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "owner_email")).toBeNull();
  });

  it("accepts a plain owner_email address", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "owner_email", value: "owner@example.com" });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "owner_email")).toBe("owner@example.com");
  });

  it("owner_email is not a secret — it round-trips as a plain value in GET /api/settings, not masked", async () => {
    await postJson("/api/settings/edit", cookie, csrf, { key: "owner_email", value: "owner@example.com" });
    const res = await getJson("/api/settings", cookie);
    expect(res.statusCode).toBe(200);
    const data = res.json() as { fields: Array<{ key: string; secret: boolean; value: string }> };
    const field = data.fields.find((f) => f.key === "owner_email");
    expect(field).toBeTruthy();
    expect(field!.secret).toBe(false);
    expect(field!.value).toBe("owner@example.com");
  });

  it("accepts the owner_email_enabled and per-event toggle keys as plain true/false values", async () => {
    for (const key of [
      "owner_email_enabled",
      "owner_email_on_paid_order",
      "owner_email_on_manual_queue",
      "owner_email_on_new_ticket",
      "owner_email_on_ticket_reply",
      "owner_email_on_wallet_topup",
    ]) {
      const res = await postJson("/api/settings/edit", cookie, csrf, { key, value: "true" });
      expect(res.statusCode).toBe(200);
      expect(await getSetting(prisma, key)).toBe("true");
    }
  });

  // Whole-branch review A1: both keys had a documented default and a reader in
  // packages/db, but no field here, so the only way to change either was a
  // direct database write (FINANCE_ARCHITECTURE known gap 5).
  it("accepts fx_quote_ttl_minutes and min_order_amount_idr as plain free-text figures", async () => {
    for (const [key, value] of [
      ["fx_quote_ttl_minutes", "180"],
      ["min_order_amount_idr", "5000"],
    ] as const) {
      const res = await postJson("/api/settings/edit", cookie, csrf, { key, value });
      expect(res.statusCode).toBe(200);
      expect(await getSetting(prisma, key)).toBe(value);
    }
  });

  it("saving min_order_amount_idr blank turns the shop-wide minimum off rather than restoring its default", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "min_order_amount_idr", value: "" });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "min_order_amount_idr")).toBe("");
    expect(await getShopMinOrderAmountIdr(prisma)).toBeNull();
  });

  it("treats an empty smtp_pass submission as a no-op (never overwrites a saved secret)", async () => {
    await setSetting(prisma, "smtp_pass", "existing-secret");
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "smtp_pass", value: "" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, unchanged: true });
    expect(await getSetting(prisma, "smtp_pass")).toBe("existing-secret");
  });

  it("requires auth (anon → 401)", async () => {
    const res = await postJson("/api/settings/edit", null, csrf, { key: "shop_name", value: "x" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/edit", cookie, "bad", { key: "shop_name", value: "x" });
    expect(res.statusCode).toBe(403);
    expect(await getSetting(prisma, "shop_name")).toBeNull();
  });
});

describe("POST /api/settings/edit — custom emoji map", () => {
  const MAP = JSON.stringify({ "✅": "5368324170671202286" });

  it("happy path: saves a valid map and applies it to outgoing text", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "custom_emoji_map", value: MAP });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "custom_emoji_map")).toBe(MAP);
    // Saved live (same process) — no restart needed.
    expect(applyCustomEmoji("✅ ok")).toBe('<tg-emoji emoji-id="5368324170671202286">✅</tg-emoji> ok');
  });

  it("rejects malformed JSON and a non-numeric id, writing nothing", async () => {
    for (const value of ["{oops", JSON.stringify({ "✅": "abc" }), JSON.stringify(["✅"])]) {
      const res = await postJson("/api/settings/edit", cookie, csrf, { key: "custom_emoji_map", value });
      expect(res.statusCode).toBe(400);
      expect(await getSetting(prisma, "custom_emoji_map")).toBeNull();
    }
  });

  it("requires auth (anon → 401)", async () => {
    const res = await postJson("/api/settings/edit", null, csrf, { key: "custom_emoji_map", value: MAP });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/edit", cookie, "bad", { key: "custom_emoji_map", value: MAP });
    expect(res.statusCode).toBe(403);
    expect(await getSetting(prisma, "custom_emoji_map")).toBeNull();
  });
});

describe("POST /api/settings/edit — bulk purchase broadcast", () => {
  it("accepts a valid threshold", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "bulk_purchase_broadcast_threshold", value: "10" });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "bulk_purchase_broadcast_threshold")).toBe("10");
  });

  it("rejects a threshold below 2, writing nothing", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "bulk_purchase_broadcast_threshold", value: "1" });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "bulk_purchase_broadcast_threshold")).toBeNull();
  });

  it("rejects a non-integer threshold, writing nothing", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "bulk_purchase_broadcast_threshold", value: "abc" });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "bulk_purchase_broadcast_threshold")).toBeNull();
  });

  it("accepts a template with placeholder tokens", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, {
      key: "bulk_purchase_broadcast_template",
      value: "Someone just bought x{qty} of {product} - {denomination}!",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "bulk_purchase_broadcast_template")).toBe(
      "Someone just bought x{qty} of {product} - {denomination}!",
    );
  });

  it("rejects a template over 500 characters, writing nothing", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, {
      key: "bulk_purchase_broadcast_template",
      value: "x".repeat(501),
    });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "bulk_purchase_broadcast_template")).toBeNull();
  });
});

describe("POST /api/settings/payments/toggle", () => {
  it("happy path: turns a method off and audits", async () => {
    const res = await postJson("/api/settings/payments/toggle", cookie, csrf, { method: "bybit", enabled: "false" });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "bybit_enabled")).toBe("false");
    const audit = await prisma.auditLog.findFirst({ where: { action: "payment_method_toggle" } });
    expect(audit?.details).toBe("Turned Bybit off.");
  });

  it("rejects an unknown method with 400", async () => {
    const res = await postJson("/api/settings/payments/toggle", cookie, csrf, { method: "evil", enabled: "false" });
    expect(res.statusCode).toBe(400);
  });

  it("requires auth (anon → 401)", async () => {
    const res = await postJson("/api/settings/payments/toggle", null, csrf, { method: "bybit", enabled: "false" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/payments/toggle", cookie, "bad", { method: "bybit", enabled: "false" });
    expect(res.statusCode).toBe(403);
    expect(await getSetting(prisma, "bybit_enabled")).toBeNull();
  });
});

describe("POST /api/settings/fx/refresh", () => {
  it("happy path: refreshes the rate and audits", async () => {
    setFxRateFetcher(async () => new Decimal(15750));
    const res = await postJson("/api/settings/fx/refresh", cookie, csrf);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(["updated", "unchanged", "disabled"]).toContain(body.status);
  });

  it("requires auth (anon → 401)", async () => {
    const res = await postJson("/api/settings/fx/refresh", null, csrf);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/fx/refresh", cookie, "bad");
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/settings/password", () => {
  beforeEach(async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("oldpassword1"));
  });

  it("happy path: changes the password and audits", async () => {
    const res = await postJson("/api/settings/password", cookie, csrf, {
      current_password: "oldpassword1",
      new_password: "newpassword1",
    });
    expect(res.statusCode).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { action: "web_password_change" } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("password");
  });

  it("rejects the wrong current password with 403, leaves the hash unchanged", async () => {
    const before = await getSetting(prisma, passwordHashKey(ADMIN_TG));
    const res = await postJson("/api/settings/password", cookie, csrf, {
      current_password: "wrong",
      new_password: "newpassword1",
    });
    expect(res.statusCode).toBe(403);
    expect(await getSetting(prisma, passwordHashKey(ADMIN_TG))).toBe(before);
  });

  it("rejects a new password shorter than 8 characters with 400", async () => {
    const res = await postJson("/api/settings/password", cookie, csrf, {
      current_password: "oldpassword1",
      new_password: "short",
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires auth (anon → 401)", async () => {
    const res = await postJson("/api/settings/password", null, csrf, {
      current_password: "oldpassword1",
      new_password: "newpassword1",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/password", cookie, "bad", {
      current_password: "oldpassword1",
      new_password: "newpassword1",
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/settings/2fa/begin + /enable + /cancel", () => {
  it("begin issues a pending secret, enable with the right code turns 2FA on and audits", async () => {
    const begin = await postJson("/api/settings/2fa/begin", cookie, csrf);
    expect(begin.statusCode).toBe(200);
    const { secret } = begin.json() as { secret: string };
    expect(await getSetting(prisma, twoFaPendingKey(ADMIN_TG))).toBe(secret);

    const wrong = await postJson("/api/settings/2fa/enable", cookie, csrf, { totp_code: "000000" });
    expect(wrong.statusCode).toBe(400);
    expect(await getSetting(prisma, twoFaSecretKey(ADMIN_TG))).toBeNull();

    const ok = await postJson("/api/settings/2fa/enable", cookie, csrf, { totp_code: currentTotp(secret) });
    expect(ok.statusCode).toBe(200);
    expect(await getSetting(prisma, twoFaSecretKey(ADMIN_TG))).toBe(secret);
    expect(await getSetting(prisma, twoFaPendingKey(ADMIN_TG))).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "web_2fa_enable" } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("2FA");
  });

  it("begin refuses when 2FA is already enabled (409)", async () => {
    await setSetting(prisma, twoFaSecretKey(ADMIN_TG), generateTotpSecret());
    const res = await postJson("/api/settings/2fa/begin", cookie, csrf);
    expect(res.statusCode).toBe(409);
  });

  it("cancel clears the pending secret without enabling 2FA", async () => {
    await postJson("/api/settings/2fa/begin", cookie, csrf);
    const res = await postJson("/api/settings/2fa/cancel", cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, twoFaPendingKey(ADMIN_TG))).toBeNull();
  });

  it("begin and cancel are both audited, in plain sentences that never carry the secret (Task C3)", async () => {
    const begin = await postJson("/api/settings/2fa/begin", cookie, csrf);
    const { secret } = begin.json() as { secret: string };
    const began = await prisma.auditLog.findFirst({ where: { action: "web_2fa_begin" } });
    expect(began).toBeTruthy();
    expect(began!.details).toMatch(/^Started setting up two-factor authentication/);
    expect(began!.details).not.toContain(secret);

    await postJson("/api/settings/2fa/cancel", cookie, csrf);
    const cancelled = await prisma.auditLog.findFirst({ where: { action: "web_2fa_cancel" } });
    expect(cancelled).toBeTruthy();
    expect(cancelled!.details).toMatch(/^Cancelled setting up two-factor authentication/);
  });

  it("begin requires auth (anon → 401)", async () => {
    const res = await postJson("/api/settings/2fa/begin", null, csrf);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("begin rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/2fa/begin", cookie, "bad");
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/settings/2fa/disable", () => {
  const secret = generateTotpSecret();

  beforeEach(async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("pw12345678"));
    await setSetting(prisma, twoFaSecretKey(ADMIN_TG), secret);
  });

  it("happy path: disables 2FA with the right password + code, audits", async () => {
    const res = await postJson("/api/settings/2fa/disable", cookie, csrf, {
      current_password: "pw12345678",
      totp_code: currentTotp(secret),
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, twoFaSecretKey(ADMIN_TG))).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "web_2fa_disable" } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("2FA");
  });

  it("rejects the wrong password with 403, leaves 2FA enabled", async () => {
    const res = await postJson("/api/settings/2fa/disable", cookie, csrf, {
      current_password: "wrong",
      totp_code: currentTotp(secret),
    });
    expect(res.statusCode).toBe(403);
    expect(await getSetting(prisma, twoFaSecretKey(ADMIN_TG))).toBe(secret);
  });

  it("rejects the wrong TOTP code with 400, leaves 2FA enabled", async () => {
    const res = await postJson("/api/settings/2fa/disable", cookie, csrf, {
      current_password: "pw12345678",
      totp_code: "000000",
    });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, twoFaSecretKey(ADMIN_TG))).toBe(secret);
  });

  it("requires auth (anon → 401)", async () => {
    const res = await postJson("/api/settings/2fa/disable", null, csrf, {
      current_password: "pw12345678",
      totp_code: currentTotp(secret),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/2fa/disable", cookie, "bad", {
      current_password: "pw12345678",
      totp_code: currentTotp(secret),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("semi-secret gateway identifiers are treated as secrets (Task C4)", () => {
  const SEMI = { paydisini_userkey: "PD-USERKEY-123", tokopay_merchant_id: "M-77881", bybit_uid: "987654321" };

  it("GET /api/settings masks them but still reports that a value is set", async () => {
    for (const [k, v] of Object.entries(SEMI)) await setSetting(prisma, k, v);
    const res = await getJson("/api/settings", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { fields: Array<{ key: string; secret: boolean; hasValue: boolean; value: string }> };
    for (const [k, v] of Object.entries(SEMI)) {
      const f = body.fields.find((x) => x.key === k)!;
      expect(f.secret).toBe(true);
      expect(f.hasValue).toBe(true);
      expect(f.value).toBe("");
    }
    for (const v of Object.values(SEMI)) expect(res.body).not.toContain(v);
  });

  it("export leaves them out", async () => {
    for (const [k, v] of Object.entries(SEMI)) await setSetting(prisma, k, v);
    const res = await getJson("/api/settings/export", cookie);
    const body = res.json() as { fields: Record<string, string> };
    for (const k of Object.keys(SEMI)) expect(body.fields).not.toHaveProperty(k);
  });

  it("an edit audits '(updated)', never the value, and a blank edit keeps the stored value", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "bybit_uid", value: "112233445" });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "bybit_uid")).toBe("112233445");
    const audit = await prisma.auditLog.findFirst({ where: { action: "setting_set" }, orderBy: { id: "desc" } });
    expect(audit!.details).toBe('Changed setting "bybit_uid" to "(updated)".');

    const blank = await postJson("/api/settings/edit", cookie, csrf, { key: "bybit_uid", value: "" });
    expect(blank.statusCode).toBe(200);
    expect(await getSetting(prisma, "bybit_uid")).toBe("112233445");
  });

  it("the storefront session-jti prefix is recognized as secret (it used to name a key that never exists)", () => {
    expect(isSecretSettingKey("shop_session_jti_user:42")).toBe(true);
    expect(isSecretSettingKey("web_session_jti:999")).toBe(true);
    expect(isSecretSettingKey("shop_name")).toBe(false);
  });

  it("metrics_token is a secret key, defensively (it is not editable today)", () => {
    expect(isSecretSettingKey("metrics_token")).toBe(true);
  });
});

describe("GET /api/settings/export", () => {
  it("includes non-secret values, excludes every secret key, and audits", async () => {
    await setSetting(prisma, "shop_name", "Demo Shop");
    await setSetting(prisma, "tokopay_merchant_id", "M123");
    await setSetting(prisma, "tokopay_secret", "topsecret");
    const res = await getJson("/api/settings/export", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { exportedAt: string; fields: Record<string, string> };
    expect(body.fields.shop_name).toBe("Demo Shop");
    // Semi-secret since Task C4: a merchant id is half of a gateway credential.
    expect(body.fields).not.toHaveProperty("tokopay_merchant_id");
    expect(body.fields).not.toHaveProperty("tokopay_secret");
    expect(body.fields).not.toHaveProperty("bot_token");
    const audit = await prisma.auditLog.findFirst({ where: { action: "settings_export" } });
    expect(audit).toBeTruthy();
  });

  it("requires auth (anon → 401)", async () => {
    const res = await getJson("/api/settings/export", null);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });
});

describe("POST /api/settings/import", () => {
  it("applies whitelisted non-secret fields, skips unknown and secret keys, audits once", async () => {
    const res = await postJson("/api/settings/import", cookie, csrf, {
      fields: {
        shop_name: "Imported Shop",
        not_a_real_key: "x",
        tokopay_secret: "should-never-be-written",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      applied: 1,
      skipped: 2,
      skippedKeys: [
        { key: "not_a_real_key", reason: "Not a setting that can be edited here." },
        { key: "tokopay_secret", reason: "Secret settings are never imported from a file." },
      ],
    });
    expect(await getSetting(prisma, "shop_name")).toBe("Imported Shop");
    expect(await getSetting(prisma, "not_a_real_key")).toBeNull();
    expect(await getSetting(prisma, "tokopay_secret")).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "settings_import" } });
    expect(audit?.details).toBe(
      'Imported 1 setting from a configuration file; skipped 2: "not_a_real_key" (Not a setting that can be edited here.); ' +
        '"tokopay_secret" (Secret settings are never imported from a file.)',
    );
    expect(audit?.details).not.toContain("should-never-be-written");
  });

  it("skips a field that fails its own validation without aborting the rest", async () => {
    const res = await postJson("/api/settings/import", cookie, csrf, {
      fields: { shop_name: "Still Applied", bulk_purchase_broadcast_threshold: "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      applied: 1,
      skipped: 1,
      skippedKeys: [{ key: "bulk_purchase_broadcast_threshold", reason: "Threshold must be a whole number of 2 or more." }],
    });
    expect(await getSetting(prisma, "shop_name")).toBe("Still Applied");
    expect(await getSetting(prisma, "bulk_purchase_broadcast_threshold")).toBeNull();
  });

  // Money audit A1 fix round. Export lists keys in EDITABLE order, which puts
  // usd_idr_rate before fx_rate_min/fx_rate_max. A file from a shop with a
  // wider band (ceiling 50000, rate 45000) imported into a shop with the
  // default 40000 ceiling used to judge the rate against the TARGET's old band,
  // refuse it, and only then apply the file's ceiling — leaving the shop with
  // no rate (USDT off) and an audit line that only said "skipped 1".
  it("applies the file's own sanity band before judging its rate, whatever the key order", async () => {
    const res = await postJson("/api/settings/import", cookie, csrf, {
      fields: { usd_idr_rate: "45000", fx_rate_min: "9000", fx_rate_max: "50000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, applied: 3, skipped: 0, skippedKeys: [] });
    expect(await getSetting(prisma, "fx_rate_max")).toBe("50000");
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("45000");
  });

  it("names each skipped key and why, in the reply and the audit entry", async () => {
    const res = await postJson("/api/settings/import", cookie, csrf, {
      fields: { usd_idr_rate: "45000", shop_name: "Kept" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied: number; skipped: number; skippedKeys: { key: string; reason: string }[] };
    expect(body.applied).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.skippedKeys).toHaveLength(1);
    expect(body.skippedKeys[0]!.key).toBe("usd_idr_rate");
    expect(body.skippedKeys[0]!.reason).toContain("40000");
    expect(await getSetting(prisma, "usd_idr_rate")).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "settings_import" } });
    expect(audit?.details).toContain('"usd_idr_rate"');
    expect(audit?.details).toContain("40000");
  });

  it("requires auth (anon → 401)", async () => {
    const res = await postJson("/api/settings/import", null, csrf, { fields: { shop_name: "x" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/import", cookie, "bad", { fields: { shop_name: "x" } });
    expect(res.statusCode).toBe(403);
    expect(await getSetting(prisma, "shop_name")).toBeNull();
  });
});

describe("POST /api/settings/payments/:method/test", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an unknown method with 400", async () => {
    const res = await postJson("/api/settings/payments/evil/test", cookie, csrf);
    expect(res.statusCode).toBe(400);
  });

  it("reports missing credentials without calling the gateway", async () => {
    const res = await postJson("/api/settings/payments/tokopay/test", cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, detail: "TokoPay merchant ID and secret are not both set." });
  });

  it("reports a reachable gateway (HTTP-level rejection) as ok:true and audits", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M123");
    await setSetting(prisma, "tokopay_secret", "s3cr3t");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "error", error_msg: "ref_id not found" }),
      }),
    );
    const res = await postJson("/api/settings/payments/tokopay/test", cookie, csrf);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; detail: string };
    expect(body.ok).toBe(true);
    expect(body.detail).toContain("ref_id not found");
    const audit = await prisma.auditLog.findFirst({ where: { action: "payment_method_test" } });
    expect(audit?.details).toBe("Tested the TokoPay connection — succeeded.");
  });

  it("reports an unreachable gateway as ok:false", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M123");
    await setSetting(prisma, "tokopay_secret", "s3cr3t");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }));
    const res = await postJson("/api/settings/payments/tokopay/test", cookie, csrf);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toContain("HTTP 502");
  });

  it("requires auth (anon → 401)", async () => {
    const res = await postJson("/api/settings/payments/tokopay/test", null, csrf);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/payments/tokopay/test", cookie, "bad");
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/settings/telegram/test", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an unknown target with 400", async () => {
    const res = await postJson("/api/settings/telegram/test", cookie, csrf, { target: "not_a_field" });
    expect(res.statusCode).toBe(400);
  });

  it("reports no token set without calling Telegram", async () => {
    const res = await postJson("/api/settings/telegram/test", cookie, csrf, { target: "bot_token" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, detail: "No token is set yet." });
  });

  it("happy path: tests the currently-saved token and audits", async () => {
    await setSetting(prisma, "bot_token", "123:fake-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: async () => ({ ok: true, result: { username: "demo_bot" } }) }),
    );
    const res = await postJson("/api/settings/telegram/test", cookie, csrf, { target: "bot_token" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, detail: "Connected as @demo_bot." });
    const audit = await prisma.auditLog.findFirst({ where: { action: "telegram_test" } });
    expect(audit).toBeTruthy();
  });

  it("reports a rejected token", async () => {
    await setSetting(prisma, "bot_token", "123:fake-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: false }) }));
    const res = await postJson("/api/settings/telegram/test", cookie, csrf, { target: "bot_token" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, detail: "Telegram rejected the stored token." });
  });

  it("requires auth (anon → 401)", async () => {
    const res = await postJson("/api/settings/telegram/test", null, csrf, { target: "bot_token" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/telegram/test", cookie, "bad", { target: "bot_token" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/settings/smtp/test", () => {
  afterEach(() => {
    vi.mocked(verifySmtp).mockReset();
  });

  it("reports unconfigured SMTP without attempting a connection", async () => {
    const res = await postJson("/api/settings/smtp/test", cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, detail: "SMTP host and from-address are not both set." });
    expect(verifySmtp).not.toHaveBeenCalled();
  });

  it("happy path: verifies the currently-saved creds and audits", async () => {
    await setSetting(prisma, "smtp_host", "smtp.hostinger.com");
    await setSetting(prisma, "smtp_port", "465");
    await setSetting(prisma, "smtp_from", "Shop <no-reply@example.com>");
    vi.mocked(verifySmtp).mockResolvedValue(true);
    const res = await postJson("/api/settings/smtp/test", cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, detail: "Connected to smtp.hostinger.com:465 and authenticated." });
    const audit = await prisma.auditLog.findFirst({ where: { action: "smtp_test" } });
    expect(audit?.details).toBe("Tested the SMTP connection — succeeded.");
  });

  it("reports a rejected connection", async () => {
    await setSetting(prisma, "smtp_host", "smtp.hostinger.com");
    await setSetting(prisma, "smtp_from", "Shop <no-reply@example.com>");
    vi.mocked(verifySmtp).mockRejectedValue(new Error("Invalid login"));
    const res = await postJson("/api/settings/smtp/test", cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, detail: "SMTP connection failed: Invalid login" });
  });

  it("requires auth (anon → 401)", async () => {
    const res = await postJson("/api/settings/smtp/test", null, csrf);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/smtp/test", cookie, "bad");
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/settings/restart", () => {
  it("happy path: writes the restart trigger file and audits", async () => {
    const res = await postJson("/api/settings/restart", cookie, csrf);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; restarted: boolean };
    expect(body.ok).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { action: "bot_restart" } });
    expect(audit).toBeTruthy();
  });

  it("requires auth (anon → 401)", async () => {
    const res = await postJson("/api/settings/restart", null, csrf);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/restart", cookie, "bad");
    expect(res.statusCode).toBe(403);
  });
});
