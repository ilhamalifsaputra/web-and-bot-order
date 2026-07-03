import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createTicket } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let customerId: number;

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
  const customer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
  customerId = customer.id;
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

function get(url: string, c: string | null) {
  return app.inject({ method: "GET", url, cookies: c ? { [COOKIE]: c } : {} });
}

describe("POST /api/users/:userId/role", () => {
  it("happy path: sets a customer's role and audits", async () => {
    const res = await postJson(`/api/users/${customerId}/role`, cookie, csrf, { role: "reseller" });
    expect(res.statusCode).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    expect(user.role).toBe("RESELLER");
    const audit = await prisma.auditLog.findFirst({ where: { action: "user_set_role" } });
    expect(audit).toBeTruthy();
  });

  it("refuses ADMIN — managed via /admins, not here (403)", async () => {
    const res = await postJson(`/api/users/${customerId}/role`, cookie, csrf, { role: "admin" });
    expect(res.statusCode).toBe(403);
  });

  it("404s for a non-existent user", async () => {
    const res = await postJson(`/api/users/999999/role`, cookie, csrf, { role: "reseller" });
    expect(res.statusCode).toBe(404);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson(`/api/users/${customerId}/role`, null, csrf, { role: "reseller" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson(`/api/users/${customerId}/role`, cookie, "bad", { role: "reseller" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/users/:userId/ban", () => {
  it("happy path: bans a customer with a reason and audits", async () => {
    const res = await postJson(`/api/users/${customerId}/ban`, cookie, csrf, { banned: "1", reason: "abuse" });
    expect(res.statusCode).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    expect(user.banned).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { action: "user_ban" } });
    expect(audit).toBeTruthy();
  });

  it("happy path: unbans a customer and audits", async () => {
    await postJson(`/api/users/${customerId}/ban`, cookie, csrf, { banned: "1", reason: "abuse" });
    const res = await postJson(`/api/users/${customerId}/ban`, cookie, csrf, { banned: "0" });
    expect(res.statusCode).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    expect(user.banned).toBe(false);
    const audit = await prisma.auditLog.findFirst({ where: { action: "user_unban" } });
    expect(audit).toBeTruthy();
  });

  it("404s for a non-existent user", async () => {
    const res = await postJson(`/api/users/999999/ban`, cookie, csrf, { banned: "1" });
    expect(res.statusCode).toBe(404);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson(`/api/users/${customerId}/ban`, null, csrf, { banned: "1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson(`/api/users/${customerId}/ban`, cookie, "bad", { banned: "1" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/vouchers", () => {
  it("happy path: creates a voucher (lowercase code+type normalized) and audits", async () => {
    const res = await postJson("/api/vouchers", cookie, csrf, {
      code: "save10",
      type: "percent",
      value: "10",
      min_purchase: "3",
    });
    expect(res.statusCode).toBe(201);
    const voucher = await prisma.voucher.findUnique({ where: { code: "SAVE10" } });
    expect(voucher).toBeTruthy();
    expect(voucher!.type).toBe("PERCENT");
    const audit = await prisma.auditLog.findFirst({ where: { action: "voucher_create" } });
    expect(audit).toBeTruthy();
  });

  it("rejects a duplicate code with 409", async () => {
    await postJson("/api/vouchers", cookie, csrf, { code: "SAVE10", type: "percent", value: "10" });
    const res = await postJson("/api/vouchers", cookie, csrf, { code: "SAVE10", type: "percent", value: "5" });
    expect(res.statusCode).toBe(409);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/vouchers", null, csrf, { code: "SAVE10", type: "percent", value: "10" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/vouchers", cookie, "bad", { code: "SAVE10", type: "percent", value: "10" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/vouchers/:voucherId/toggle + /delete", () => {
  it("toggle happy path: deactivates then reactivates, audits", async () => {
    const create = await postJson("/api/vouchers", cookie, csrf, { code: "SAVE10", type: "percent", value: "10" });
    const { voucher } = create.json() as { voucher: { id: number } };

    const off = await postJson(`/api/vouchers/${voucher.id}/toggle`, cookie, csrf, { is_active: "0" });
    expect(off.statusCode).toBe(200);
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).isActive).toBe(false);

    const audit = await prisma.auditLog.findFirst({ where: { action: "voucher_toggle" } });
    expect(audit).toBeTruthy();
  });

  it("delete succeeds when never used, refuses once used", async () => {
    const create = await postJson("/api/vouchers", cookie, csrf, { code: "SAVE10", type: "percent", value: "10" });
    const { voucher } = create.json() as { voucher: { id: number } };

    const res = await postJson(`/api/vouchers/${voucher.id}/delete`, cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(await prisma.voucher.findUnique({ where: { id: voucher.id } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "voucher_delete" } });
    expect(audit).toBeTruthy();
  });

  it("delete 404s for a non-existent voucher", async () => {
    const res = await postJson("/api/vouchers/999999/delete", cookie, csrf);
    expect(res.statusCode).toBe(404);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson("/api/vouchers/1/toggle", null, csrf, { is_active: "0" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson("/api/vouchers/1/toggle", cookie, "bad", { is_active: "0" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/support/:ticketId/reply + /close", () => {
  it("reply happy path: records a message (never sent to Telegram) and audits", async () => {
    const ticket = await createTicket(prisma, customerId, "Help please");
    const res = await postJson(`/api/support/${ticket.id}/reply`, cookie, csrf, { content: "On it!" });
    expect(res.statusCode).toBe(200);
    const messages = await prisma.ticketMessage.findMany({ where: { ticketId: ticket.id } });
    expect(messages.some((m) => m.content === "On it!")).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { action: "ticket_reply" } });
    expect(audit).toBeTruthy();
  });

  it("reply rejects an empty message with 400", async () => {
    const ticket = await createTicket(prisma, customerId, "Help please");
    const res = await postJson(`/api/support/${ticket.id}/reply`, cookie, csrf, { content: "  " });
    expect(res.statusCode).toBe(400);
  });

  it("close happy path: closes the ticket and audits", async () => {
    const ticket = await createTicket(prisma, customerId, "Help please");
    const res = await postJson(`/api/support/${ticket.id}/close`, cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("CLOSED");
    const audit = await prisma.auditLog.findFirst({ where: { action: "ticket_close" } });
    expect(audit).toBeTruthy();
  });

  it("close 404s for a non-existent ticket", async () => {
    const res = await postJson("/api/support/999999/close", cookie, csrf);
    expect(res.statusCode).toBe(404);
  });

  it("reply requires auth (anon → 303 /login)", async () => {
    const ticket = await createTicket(prisma, customerId, "Help please");
    const res = await postJson(`/api/support/${ticket.id}/reply`, null, csrf, { content: "hi" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("reply rejects bad CSRF (403)", async () => {
    const ticket = await createTicket(prisma, customerId, "Help please");
    const res = await postJson(`/api/support/${ticket.id}/reply`, cookie, "bad", { content: "hi" });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/audit", () => {
  it("happy path: returns recorded audit rows", async () => {
    await postJson(`/api/users/${customerId}/ban`, cookie, csrf, { banned: "1", reason: "test" });
    const res = await get("/api/audit", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: unknown[]; total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await get("/api/audit", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});
