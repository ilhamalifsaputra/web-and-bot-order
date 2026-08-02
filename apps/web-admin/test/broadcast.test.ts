import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
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

function getJson(url: string, c: string | null) {
  return app.inject({ method: "GET", url, cookies: c ? { [COOKIE]: c } : {} });
}

describe("GET /api/broadcast", () => {
  it("history rows expose total/sent (not the raw Prisma totalCount/sentCount), so the client's Sent column can't silently regress to undefined", async () => {
    const draftRes = await postJson("/api/broadcast", cookie, csrf, {
      message: "hi", segment: "ALL", scheduled_at: "", image_url: "", draft: true,
    });
    const { broadcast } = draftRes.json() as { broadcast: { id: number } };
    // Simulate a broadcast the drainer has partially delivered — there's no
    // route for this, so update the counters directly, same as the drainer would.
    await prisma.broadcast.update({
      where: { id: broadcast.id },
      data: { totalCount: 200, sentCount: 12 },
    });

    const res = await getJson("/api/broadcast", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { history: Array<Record<string, unknown>> };
    const row = body.history.find((h) => h.id === broadcast.id);
    expect(row).toBeTruthy();
    expect(row!.total).toBe(200);
    expect(row!.sent).toBe(12);
    expect(row!.totalCount).toBeUndefined();
    expect(row!.sentCount).toBeUndefined();
  });
});

describe("POST /api/broadcast", () => {
  it("draft:true creates a DRAFT row, not PENDING", async () => {
    const res = await postJson("/api/broadcast", cookie, csrf, {
      message: "hi", segment: "ALL", scheduled_at: "", image_url: "", draft: true,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { broadcast: { id: number; status: string } };
    expect(body.broadcast.status).toBe("DRAFT");
  });

  it("omitting draft still creates PENDING (regression guard)", async () => {
    const res = await postJson("/api/broadcast", cookie, csrf, {
      message: "hi", segment: "ALL", scheduled_at: "", image_url: "",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { broadcast: { status: string } };
    expect(body.broadcast.status).toBe("PENDING");
  });
});

describe("POST /api/broadcast/:id/queue", () => {
  it("happy path: queues a real draft to PENDING and audits", async () => {
    const draftRes = await postJson("/api/broadcast", cookie, csrf, {
      message: "hi", segment: "ALL", scheduled_at: "", image_url: "", draft: true,
    });
    const { broadcast } = draftRes.json() as { broadcast: { id: number } };
    const res = await postJson(`/api/broadcast/${broadcast.id}/queue`, cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const row = await prisma.broadcast.findUnique({ where: { id: broadcast.id } });
    expect(row!.status).toBe("PENDING");
    const audit = await prisma.auditLog.findFirst({ where: { action: "broadcast_queue_draft", targetId: broadcast.id } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("ALL");
  });

  it("409 on a non-draft (e.g. already PENDING)", async () => {
    const pendingRes = await postJson("/api/broadcast", cookie, csrf, {
      message: "hi", segment: "ALL", scheduled_at: "", image_url: "",
    });
    const { broadcast } = pendingRes.json() as { broadcast: { id: number } };
    const res = await postJson(`/api/broadcast/${broadcast.id}/queue`, cookie, csrf);
    expect(res.statusCode).toBe(409);
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const draftRes = await postJson("/api/broadcast", cookie, csrf, {
      message: "hi", segment: "ALL", scheduled_at: "", image_url: "", draft: true,
    });
    const { broadcast } = draftRes.json() as { broadcast: { id: number } };
    const res = await postJson(`/api/broadcast/${broadcast.id}/queue`, null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.broadcast.findUnique({ where: { id: broadcast.id } }))!.status).toBe("DRAFT");
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const draftRes = await postJson("/api/broadcast", cookie, csrf, {
      message: "hi", segment: "ALL", scheduled_at: "", image_url: "", draft: true,
    });
    const { broadcast } = draftRes.json() as { broadcast: { id: number } };
    const res = await postJson(`/api/broadcast/${broadcast.id}/queue`, cookie, "bad");
    expect(res.statusCode).toBe(403);
    expect((await prisma.broadcast.findUnique({ where: { id: broadcast.id } }))!.status).toBe("DRAFT");
  });
});

describe("POST /api/broadcast/:id/delete", () => {
  it("happy path: deletes a real draft and audits", async () => {
    const draftRes = await postJson("/api/broadcast", cookie, csrf, {
      message: "hi", segment: "ALL", scheduled_at: "", image_url: "", draft: true,
    });
    const { broadcast } = draftRes.json() as { broadcast: { id: number } };
    const res = await postJson(`/api/broadcast/${broadcast.id}/delete`, cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await prisma.broadcast.findUnique({ where: { id: broadcast.id } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "broadcast_delete_draft", targetId: broadcast.id } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("ALL");
  });

  it("409 on a non-draft, row untouched", async () => {
    const pendingRes = await postJson("/api/broadcast", cookie, csrf, {
      message: "hi", segment: "ALL", scheduled_at: "", image_url: "",
    });
    const { broadcast } = pendingRes.json() as { broadcast: { id: number } };
    const res = await postJson(`/api/broadcast/${broadcast.id}/delete`, cookie, csrf);
    expect(res.statusCode).toBe(409);
    expect(await prisma.broadcast.findUnique({ where: { id: broadcast.id } })).not.toBeNull();
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const draftRes = await postJson("/api/broadcast", cookie, csrf, {
      message: "hi", segment: "ALL", scheduled_at: "", image_url: "", draft: true,
    });
    const { broadcast } = draftRes.json() as { broadcast: { id: number } };
    const res = await postJson(`/api/broadcast/${broadcast.id}/delete`, null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect(await prisma.broadcast.findUnique({ where: { id: broadcast.id } })).not.toBeNull();
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const draftRes = await postJson("/api/broadcast", cookie, csrf, {
      message: "hi", segment: "ALL", scheduled_at: "", image_url: "", draft: true,
    });
    const { broadcast } = draftRes.json() as { broadcast: { id: number } };
    const res = await postJson(`/api/broadcast/${broadcast.id}/delete`, cookie, "bad");
    expect(res.statusCode).toBe(403);
    expect(await prisma.broadcast.findUnique({ where: { id: broadcast.id } })).not.toBeNull();
  });
});
