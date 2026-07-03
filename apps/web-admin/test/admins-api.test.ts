import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, getSetting } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti, webRoleKey } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
const NEW_ADMIN_TG = 555;
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

describe("POST /api/admins/add", () => {
  it("happy path: adds an admin and audits", async () => {
    const res = await postJson("/api/admins/add", cookie, csrf, { telegram_id: NEW_ADMIN_TG });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
    const audit = await prisma.auditLog.findFirst({ where: { action: "web_admin_add" } });
    expect(audit).toBeTruthy();
    expect(await getSetting(prisma, webRoleKey(NEW_ADMIN_TG))).toBe("readonly");
  });

  it("rejects a non-integer telegram_id with 400", async () => {
    const res = await postJson("/api/admins/add", cookie, csrf, { telegram_id: "not-a-number" });
    expect(res.statusCode).toBe(400);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/admins/add", null, csrf, { telegram_id: NEW_ADMIN_TG });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/admins/add", cookie, "bad", { telegram_id: NEW_ADMIN_TG });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/admins/remove", () => {
  it("happy path: removes a DB-added admin and audits", async () => {
    await postJson("/api/admins/add", cookie, csrf, { telegram_id: NEW_ADMIN_TG });
    const res = await postJson("/api/admins/remove", cookie, csrf, { telegram_id: NEW_ADMIN_TG });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const audit = await prisma.auditLog.findFirst({ where: { action: "web_admin_remove" } });
    expect(audit).toBeTruthy();
  });

  it("cannot remove self (403)", async () => {
    const res = await postJson("/api/admins/remove", cookie, csrf, { telegram_id: ADMIN_TG });
    expect(res.statusCode).toBe(403);
  });

  it("cannot remove an env-based admin (403)", async () => {
    const envAdmin = config.ADMIN_IDS[0]!;
    const res = await postJson("/api/admins/remove", cookie, csrf, { telegram_id: envAdmin });
    expect(res.statusCode).toBe(403);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/admins/remove", null, csrf, { telegram_id: NEW_ADMIN_TG });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    await postJson("/api/admins/add", cookie, csrf, { telegram_id: NEW_ADMIN_TG });
    const res = await postJson("/api/admins/remove", cookie, "bad", { telegram_id: NEW_ADMIN_TG });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/admins/:tgId/role", () => {
  it("happy path: sets a DB-added admin's role and audits", async () => {
    await postJson("/api/admins/add", cookie, csrf, { telegram_id: NEW_ADMIN_TG });
    const res = await postJson(`/api/admins/${NEW_ADMIN_TG}/role`, cookie, csrf, { role: "support" });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, webRoleKey(NEW_ADMIN_TG))).toBe("support");
    const audit = await prisma.auditLog.findFirst({ where: { action: "web_admin_set_role" } });
    expect(audit).toBeTruthy();
  });

  it("refuses to demote yourself away from super (403)", async () => {
    const res = await postJson(`/api/admins/${ADMIN_TG}/role`, cookie, csrf, { role: "readonly" });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an invalid role with 400", async () => {
    await postJson("/api/admins/add", cookie, csrf, { telegram_id: NEW_ADMIN_TG });
    const res = await postJson(`/api/admins/${NEW_ADMIN_TG}/role`, cookie, csrf, { role: "hacker" });
    expect(res.statusCode).toBe(400);
  });

  it("404s for a telegram id that isn't a registered admin", async () => {
    const res = await postJson(`/api/admins/424242/role`, cookie, csrf, { role: "support" });
    expect(res.statusCode).toBe(404);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson(`/api/admins/${NEW_ADMIN_TG}/role`, null, csrf, { role: "support" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    await postJson("/api/admins/add", cookie, csrf, { telegram_id: NEW_ADMIN_TG });
    const res = await postJson(`/api/admins/${NEW_ADMIN_TG}/role`, cookie, "bad", { role: "support" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/admins/:tgId/logout", () => {
  it("happy path: force-logs-out a DB-added admin (rotates their session jti) and audits", async () => {
    await postJson("/api/admins/add", cookie, csrf, { telegram_id: NEW_ADMIN_TG });
    const oldJti = newJti();
    await setSetting(prisma, sessionJtiKey(NEW_ADMIN_TG), oldJti);

    const res = await postJson(`/api/admins/${NEW_ADMIN_TG}/logout`, cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, sessionJtiKey(NEW_ADMIN_TG))).not.toBe(oldJti);
    const audit = await prisma.auditLog.findFirst({ where: { action: "web_admin_force_logout" } });
    expect(audit).toBeTruthy();
  });

  it("refuses to force-logout yourself (403) — use the Logout button instead", async () => {
    const res = await postJson(`/api/admins/${ADMIN_TG}/logout`, cookie, csrf);
    expect(res.statusCode).toBe(403);
  });

  it("404s for a telegram id that isn't a registered admin", async () => {
    const res = await postJson(`/api/admins/424242/logout`, cookie, csrf);
    expect(res.statusCode).toBe(404);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson(`/api/admins/${NEW_ADMIN_TG}/logout`, null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    await postJson("/api/admins/add", cookie, csrf, { telegram_id: NEW_ADMIN_TG });
    const res = await postJson(`/api/admins/${NEW_ADMIN_TG}/logout`, cookie, "bad");
    expect(res.statusCode).toBe(403);
  });
});
