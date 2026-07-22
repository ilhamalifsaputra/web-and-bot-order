import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";
import { UPLOADS_DIR } from "../src/paths";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 998;
let app: import("fastify").FastifyInstance;
let cookie: string;
let csrf: string;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
  for (const sub of ["broadcasts", "tickets"]) mkdirSync(join(UPLOADS_DIR, sub), { recursive: true });
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  rmSync(join(UPLOADS_DIR, "broadcasts", "storage-api-test.png"), { force: true });
  rmSync(join(UPLOADS_DIR, "tickets", "storage-api-test.png"), { force: true });
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

function getJson(url: string, c: string | null) {
  return app.inject({ method: "GET", url, cookies: c ? { [COOKIE]: c } : {} });
}
function postJson(url: string, c: string | null, csrfToken: string) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
    payload: "{}",
  });
}

describe("GET /api/storage/summary", () => {
  it("happy path: reports folder byte totals and DB file size", async () => {
    writeFileSync(join(UPLOADS_DIR, "broadcasts", "storage-api-test.png"), "hello-world");
    const res = await getJson("/api/storage/summary", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const broadcasts = body.folders.find((f: { name: string }) => f.name === "broadcasts");
    expect(broadcasts.fileCount).toBeGreaterThanOrEqual(1);
    expect(broadcasts.totalBytes).toBeGreaterThanOrEqual("hello-world".length);
    expect(body.dbBytes).toBeGreaterThan(0);
  });

  it("auth-fail: no admin session is redirected to /login", async () => {
    const res = await getJson("/api/storage/summary", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});

describe("POST /api/storage/cleanup", () => {
  it("happy path: runs the cleanup, returns a summary, and audits", async () => {
    const oldBroadcast = await prisma.broadcast.create({
      data: {
        message: "old",
        segment: "ALL",
        status: "SENT",
        sentAt: new Date(Date.now() - 40 * 24 * 3_600_000),
        webImageUrl: "/uploads/broadcasts/storage-api-test.png",
      },
    });
    writeFileSync(join(UPLOADS_DIR, "broadcasts", "storage-api-test.png"), "old-image");

    const res = await postJson("/api/storage/cleanup", cookie, csrf);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.broadcastFilesDeleted).toBe(1);
    expect(existsSync(join(UPLOADS_DIR, "broadcasts", "storage-api-test.png"))).toBe(false);
    const fresh = await prisma.broadcast.findUnique({ where: { id: oldBroadcast.id } });
    expect(fresh!.webImageUrl).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "storage_cleanup" } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("broadcast image");
  });

  it("auth-fail: no admin session is redirected to /login and runs no cleanup", async () => {
    const res = await postJson("/api/storage/cleanup", null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect(await prisma.auditLog.findFirst({ where: { action: "storage_cleanup" } })).toBeNull();
  });

  it("bad-csrf: an invalid token is rejected with 403 and runs no cleanup", async () => {
    const res = await postJson("/api/storage/cleanup", cookie, "bad");
    expect(res.statusCode).toBe(403);
    expect(await prisma.auditLog.findFirst({ where: { action: "storage_cleanup" } })).toBeNull();
  });
});
