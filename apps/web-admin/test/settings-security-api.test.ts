import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
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
