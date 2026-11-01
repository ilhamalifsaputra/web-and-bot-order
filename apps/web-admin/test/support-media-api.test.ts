import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createTicket } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti, webRoleKey } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
const OTHER_ADMIN_TG = 1000;
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const objects = new Map<string, { bytes: Buffer; type: string; etag: string }>();
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let adminId: number;
let otherCookie: string;
let otherCsrf: string;
let ticketId: number;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function session(telegramId: number) {
  const user = await upsertUser(prisma, { telegramId, username: `admin${telegramId}`, fullName: "Admin" });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(telegramId), jti);
  const { raw, data } = makeSession(user.id, telegramId, jti);
  return { id: user.id, cookie: raw, csrf: data.csrf };
}

beforeEach(async () => {
  await prisma.supportAttachment.deleteMany(); // resetDb does not know this table and tickets restrict deletion.
  await resetDb(prisma);
  vi.stubEnv("SUPPORT_R2_ACCOUNT_ID", "a".repeat(32));
  vi.stubEnv("SUPPORT_R2_BUCKET", "any-private-bucket");
  vi.stubEnv("SUPPORT_R2_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("SUPPORT_R2_SECRET_ACCESS_KEY", "test-secret");
  const first = await session(ADMIN_TG);
  cookie = first.cookie; csrf = first.csrf; adminId = first.id;
  const second = await session(OTHER_ADMIN_TG);
  otherCookie = second.cookie; otherCsrf = second.csrf;
  await setSetting(prisma, "setup_completed", "true");
  const customer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
  ticketId = (await createTicket(prisma, customer.id, "My order has a problem")).id;
  objects.clear();
  // R2 stub shared by HEAD / ranged GET / server-side copy, as in supportAttachments.test.ts.
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = decodeURIComponent(url.pathname);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(init?.headers);
    if (method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    if (method === "PUT") {
      const source = headers.get("x-amz-copy-source");
      const original = source ? objects.get(source) : undefined;
      if (!original || original.etag !== headers.get("x-amz-copy-source-if-match")) return new Response(null, { status: 412 });
      objects.set(key, { ...original });
      return new Response("<CopyObjectResult/>");
    }
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    if (headers.get("If-Match") && headers.get("If-Match") !== object.etag) return new Response(null, { status: 412 });
    return new Response(method === "HEAD" ? null : new Uint8Array(object.bytes), { status: method === "HEAD" ? 200 : 206, headers: { "Content-Length": String(object.bytes.length), "Content-Type": object.type, ETag: object.etag } });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function post(url: string, body: Record<string, unknown> = {}, opts: { c?: string | null; token?: string } = {}) {
  const c = opts.c === undefined ? cookie : opts.c;
  return app.inject({
    method: "POST", url,
    headers: { "content-type": "application/json", "x-csrf-token": opts.token ?? csrf },
    cookies: c ? { [COOKIE]: c } : {},
    payload: JSON.stringify(body),
  });
}
function get(url: string, c: string | null = cookie) {
  return app.inject({ method: "GET", url, cookies: c ? { [COOKIE]: c } : {} });
}
const intentBody = (over: Record<string, unknown> = {}) => ({ ticket_id: ticketId, draft_id: "0b5c1c0e-8a53-4d6e-9a31-6f1d2b7c9e11", filename: "proof.png", mime: "image/png", bytes: png.length, ...over });
async function createIntent(over: Record<string, unknown> = {}, opts: { c?: string | null; token?: string } = {}) {
  const res = await post("/api/support/uploads", intentBody(over), opts);
  const body = (res.statusCode === 200 ? res.json() : {}) as { id: string; url: string; headers: Record<string, string> };
  return { res, body };
}
/** Intent plus the browser's direct PUT, simulated by seeding the stub. */
async function uploaded(opts: { c?: string | null; token?: string } = {}) {
  const { res, body } = await createIntent({}, opts);
  expect(res.statusCode).toBe(200);
  objects.set(new URL(body.url).pathname, { bytes: png, type: "image/png", etag: '"verified-bytes"' });
  return body.id;
}
async function setRole(role: string) { await setSetting(prisma, webRoleKey(ADMIN_TG), role); }

describe("GET /api/support/media/options", () => {
  it("reports enabled with the limits when private storage is configured", async () => {
    const res = await get("/api/support/media/options");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, files: 3, imageBytes: 5 * 1024 ** 2, videoBytes: 20 * 1024 ** 2 });
  });
  it("reports disabled when the storage credentials are missing", async () => {
    vi.stubEnv("SUPPORT_R2_ACCESS_KEY_ID", "");
    const res = await get("/api/support/media/options");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false });
  });
  it("requires auth (anon 401)", async () => {
    expect((await get("/api/support/media/options", null)).statusCode).toBe(401);
  });
});

describe("POST /api/support/uploads (intent)", () => {
  it("creates a pending row and returns a presigned PUT for the signed-in admin", async () => {
    const { res, body } = await createIntent();
    expect(res.statusCode).toBe(200);
    expect(body.url).toContain("any-private-bucket");
    const row = await prisma.supportAttachment.findUniqueOrThrow({ where: { id: body.id } });
    expect(row).toMatchObject({ ownerId: adminId, ticketId, status: "PENDING", mime: "image/png", bytes: png.length });
  });
  it("requires auth (anon 401)", async () => {
    const { res } = await createIntent({}, { c: null });
    expect(res.statusCode).toBe(401);
    expect(await prisma.supportAttachment.count()).toBe(0);
  });
  it("refuses a readonly admin (403) without creating a row", async () => {
    await setRole("readonly");
    const { res } = await createIntent();
    expect(res.statusCode).toBe(403);
    expect(await prisma.supportAttachment.count()).toBe(0);
  });
  it("rejects a bad CSRF token (403) without creating a row", async () => {
    const { res } = await createIntent({}, { token: "bad" });
    expect(res.statusCode).toBe(403);
    expect(await prisma.supportAttachment.count()).toBe(0);
  });
  it("404s for a closed ticket and creates no row", async () => {
    await prisma.supportTicket.update({ where: { id: ticketId }, data: { status: "CLOSED" } });
    const { res } = await createIntent();
    expect(res.statusCode).toBe(404);
    expect(await prisma.supportAttachment.count()).toBe(0);
  });
  it("rejects an unsupported MIME type with 400 and creates no row", async () => {
    const { res } = await createIntent({ mime: "image/svg+xml", filename: "proof.svg" });
    expect(res.statusCode).toBe(400);
    expect(await prisma.supportAttachment.count()).toBe(0);
  });
  it("rejects oversize and empty files with 400 and creates no row", async () => {
    const big = await createIntent({ mime: "image/png", bytes: 5 * 1024 ** 2 + 1 });
    expect(big.res.statusCode).toBe(400);
    const bigVideo = await createIntent({ mime: "video/mp4", filename: "a.mp4", bytes: 20 * 1024 ** 2 + 1 });
    expect(bigVideo.res.statusCode).toBe(400);
    const empty = await createIntent({ bytes: 0 });
    expect(empty.res.statusCode).toBe(400);
    expect(await prisma.supportAttachment.count()).toBe(0);
  });
  it("accepts an MP4 within the limit", async () => {
    const { res } = await createIntent({ mime: "video/mp4", filename: "clip.mp4", bytes: 1024 });
    expect(res.statusCode).toBe(200);
  });
});

describe("finalize and abort", () => {
  it("verifies the uploaded bytes and marks the row READY under a ready key", async () => {
    const id = await uploaded();
    const res = await post(`/api/support/uploads/${id}/finalize`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id, status: "READY" });
    const row = await prisma.supportAttachment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("READY");
    expect(row.storageKey).toMatch(/^support-ready\//);
  });
  it("refuses another admin's upload with 400 and leaves it pending", async () => {
    const id = await uploaded();
    const res = await post(`/api/support/uploads/${id}/finalize`, {}, { c: otherCookie, token: otherCsrf });
    expect(res.statusCode).toBe(400);
    expect((await prisma.supportAttachment.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
  });
  it("rejects finalize when the file never reached storage", async () => {
    const { body } = await createIntent();
    const res = await post(`/api/support/uploads/${body.id}/finalize`);
    expect(res.statusCode).toBe(400);
    expect((await prisma.supportAttachment.findUniqueOrThrow({ where: { id: body.id } })).status).not.toBe("READY");
  });
  it("aborts an unattached upload of the same admin", async () => {
    const id = await uploaded();
    const res = await post(`/api/support/uploads/${id}/abort`);
    expect(res.statusCode).toBe(200);
    expect((await prisma.supportAttachment.findUniqueOrThrow({ where: { id } })).status).toBe("REJECTED");
  });
  it("does not let another admin abort the upload", async () => {
    const id = await uploaded();
    const res = await post(`/api/support/uploads/${id}/abort`, {}, { c: otherCookie, token: otherCsrf });
    expect(res.statusCode).toBe(200);
    expect((await prisma.supportAttachment.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
  });
});

describe("reply with attachment_ids and media download", () => {
  async function readyUpload() {
    const id = await uploaded();
    expect((await post(`/api/support/uploads/${id}/finalize`)).statusCode).toBe(200);
    return id;
  }
  it("attaches the verified file to the reply message", async () => {
    const id = await readyUpload();
    const res = await post(`/api/support/${ticketId}/reply`, { content: "See attached", internal: false, request_id: "r-1", attachment_ids: [id] });
    expect(res.statusCode).toBe(200);
    const row = await prisma.supportAttachment.findUniqueOrThrow({ where: { id } });
    expect(row.attachedAt).not.toBeNull();
    expect(row.ticketId).toBe(ticketId);
    expect(row.messageId).not.toBeNull();
    const message = await prisma.ticketMessage.findUniqueOrThrow({ where: { id: row.messageId! } });
    expect(message).toMatchObject({ ticketId, content: "See attached" });
  });
  it("redirects an attached file to a short-lived storage URL for a support admin", async () => {
    const id = await readyUpload();
    await post(`/api/support/${ticketId}/reply`, { content: "See attached", internal: false, request_id: "r-2", attachment_ids: [id] });
    const res = await get(`/api/support/media/${id}/proof.png`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("any-private-bucket");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
  it("404s for a verified file that was never attached to a message", async () => {
    const id = await readyUpload();
    expect((await get(`/api/support/media/${id}/proof.png`)).statusCode).toBe(404);
  });
  it("refuses a readonly admin (403) even for an attached file", async () => {
    const id = await readyUpload();
    await post(`/api/support/${ticketId}/reply`, { content: "See attached", internal: false, request_id: "r-3", attachment_ids: [id] });
    await setRole("readonly");
    expect((await get(`/api/support/media/${id}/proof.png`)).statusCode).toBe(403);
  });
  it("requires auth for the media download (anon 401)", async () => {
    const id = await readyUpload();
    expect((await get(`/api/support/media/${id}/proof.png`, null)).statusCode).toBe(401);
  });
});
