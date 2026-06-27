import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, createCategory, setSetting, getSetting } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let adminId: number;

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
  adminId = admin.id;
  await createCategory(prisma, "Seed");
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

function postForm(url: string, c: string | null, fields: Record<string, string>) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    cookies: c ? { [COOKIE]: c } : {},
    payload: new URLSearchParams(fields).toString(),
  });
}

describe("POST /settings/payments/toggle", () => {
  it("happy path: turns a method off — writes the flag, redirects, audits", async () => {
    const res = await postForm("/settings/payments/toggle", cookie, {
      csrf_token: csrf,
      method: "bybit",
      enabled: "false",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/settings/);

    expect(await getSetting(prisma, "bybit_enabled")).toBe("false");

    const row = await prisma.auditLog.findFirst({ where: { action: "payment_method_toggle" } });
    expect(row).toBeTruthy();
    expect(row?.targetType).toBe("setting");
    expect(row?.details).toBe("Turned Bybit off.");
    expect(row?.adminId).toBe(adminId);
  });

  it("happy path: turns a method on — normalizes enabled to the literal true", async () => {
    const res = await postForm("/settings/payments/toggle", cookie, {
      csrf_token: csrf,
      method: "binance_internal",
      enabled: "true",
    });
    expect(res.statusCode).toBe(303);
    expect(await getSetting(prisma, "binance_internal_enabled")).toBe("true");
  });

  it("htmx request: returns the flash partial in place (200, no redirect) and still writes + audits", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/settings/payments/toggle",
      headers: { "content-type": "application/x-www-form-urlencoded", "hx-request": "true" },
      cookies: { [COOKIE]: cookie },
      payload: new URLSearchParams({ csrf_token: csrf, method: "bybit", enabled: "false" }).toString(),
    });
    // No navigation — htmx swaps the toast partial in place.
    expect(res.statusCode).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toContain("turned off");
    // The save still happens and is audited, same as the redirect path.
    expect(await getSetting(prisma, "bybit_enabled")).toBe("false");
    const row = await prisma.auditLog.findFirst({ where: { action: "payment_method_toggle" } });
    expect(row?.details).toBe("Turned Bybit off.");
  });

  it("rejects an unknown method (whitelist guardrail) without writing anything", async () => {
    const res = await postForm("/settings/payments/toggle", cookie, {
      csrf_token: csrf,
      method: "evil_method",
      enabled: "false",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/kind=error/);
    expect(await getSetting(prisma, "evil_method_enabled")).toBeNull();
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const res = await postForm("/settings/payments/toggle", null, {
      csrf_token: csrf,
      method: "bybit",
      enabled: "false",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect(await getSetting(prisma, "bybit_enabled")).toBeNull();
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const res = await postForm("/settings/payments/toggle", cookie, {
      csrf_token: "bad",
      method: "bybit",
      enabled: "false",
    });
    expect(res.statusCode).toBe(403);
    expect(await getSetting(prisma, "bybit_enabled")).toBeNull();
  });

  // Bybit BSC is a second, independent method alongside Bybit (Internal
  // Transfer) — same trio coverage, its own enabled key.
  it("happy path: turns Bybit BSC off — writes the flag, redirects, audits", async () => {
    const res = await postForm("/settings/payments/toggle", cookie, {
      csrf_token: csrf,
      method: "bybit_bsc",
      enabled: "false",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/settings/);
    expect(await getSetting(prisma, "bybit_bsc_enabled")).toBe("false");

    const row = await prisma.auditLog.findFirst({ where: { action: "payment_method_toggle", details: "Turned Bybit BSC (on-chain) off." } });
    expect(row).toBeTruthy();
    expect(row?.adminId).toBe(adminId);
  });

  it("auth-fail (Bybit BSC): no admin session is redirected to /login and writes nothing", async () => {
    const res = await postForm("/settings/payments/toggle", null, {
      csrf_token: csrf,
      method: "bybit_bsc",
      enabled: "false",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect(await getSetting(prisma, "bybit_bsc_enabled")).toBeNull();
  });

  it("bad-csrf (Bybit BSC): an invalid token is rejected with 403 and writes nothing", async () => {
    const res = await postForm("/settings/payments/toggle", cookie, {
      csrf_token: "bad",
      method: "bybit_bsc",
      enabled: "false",
    });
    expect(res.statusCode).toBe(403);
    expect(await getSetting(prisma, "bybit_bsc_enabled")).toBeNull();
  });
});
