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
import { prisma, initDb, upsertUser, setSetting, getSetting, setFxRateFetcher } from "@app/db";
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
  it("happy path: edits a whitelisted key and audits", async () => {
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "shop_name", value: "New Shop" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await getSetting(prisma, "shop_name")).toBe("New Shop");
    const audit = await prisma.auditLog.findFirst({ where: { action: "setting_set" } });
    expect(audit).toBeTruthy();
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

  it("treats an empty smtp_pass submission as a no-op (never overwrites a saved secret)", async () => {
    await setSetting(prisma, "smtp_pass", "existing-secret");
    const res = await postJson("/api/settings/edit", cookie, csrf, { key: "smtp_pass", value: "" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, unchanged: true });
    expect(await getSetting(prisma, "smtp_pass")).toBe("existing-secret");
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/settings/edit", null, csrf, { key: "shop_name", value: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/settings/edit", null, csrf, { key: "custom_emoji_map", value: MAP });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/settings/payments/toggle", null, csrf, { method: "bybit", enabled: "false" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/settings/fx/refresh", null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/settings/password", null, csrf, {
      current_password: "oldpassword1",
      new_password: "newpassword1",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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

  it("begin requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/settings/2fa/begin", null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/settings/2fa/disable", null, csrf, {
      current_password: "pw12345678",
      totp_code: currentTotp(secret),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/2fa/disable", cookie, "bad", {
      current_password: "pw12345678",
      totp_code: currentTotp(secret),
    });
    expect(res.statusCode).toBe(403);
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
    expect(body.fields.tokopay_merchant_id).toBe("M123");
    expect(body.fields).not.toHaveProperty("tokopay_secret");
    expect(body.fields).not.toHaveProperty("bot_token");
    const audit = await prisma.auditLog.findFirst({ where: { action: "settings_export" } });
    expect(audit).toBeTruthy();
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await getJson("/api/settings/export", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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
    expect(res.json()).toEqual({ ok: true, applied: 1, skipped: 2 });
    expect(await getSetting(prisma, "shop_name")).toBe("Imported Shop");
    expect(await getSetting(prisma, "not_a_real_key")).toBeNull();
    expect(await getSetting(prisma, "tokopay_secret")).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "settings_import" } });
    expect(audit?.details).toBe("Imported 1 setting from a configuration file; skipped 2 invalid or restricted keys.");
  });

  it("skips a field that fails its own validation without aborting the rest", async () => {
    const res = await postJson("/api/settings/import", cookie, csrf, {
      fields: { shop_name: "Still Applied", bulk_purchase_broadcast_threshold: "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, applied: 1, skipped: 1 });
    expect(await getSetting(prisma, "shop_name")).toBe("Still Applied");
    expect(await getSetting(prisma, "bulk_purchase_broadcast_threshold")).toBeNull();
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/settings/import", null, csrf, { fields: { shop_name: "x" } });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/settings/payments/tokopay/test", null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/settings/telegram/test", null, csrf, { target: "bot_token" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/settings/smtp/test", null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/settings/restart", null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/settings/restart", cookie, "bad");
    expect(res.statusCode).toBe(403);
  });
});
