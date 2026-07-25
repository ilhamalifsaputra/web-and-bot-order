import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createTicket, assignTicket } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";
import { setFileResolver, getFileResolver } from "../src/lib/telegramCheck";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let customerId: number;
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
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  adminId = admin.id;
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

describe("GET /api/support", () => {
  it("happy path: paginates, includes the user relation, and the stats block", async () => {
    for (let i = 0; i < 3; i++) {
      await createTicket(prisma, customerId, `Ticket ${i}`);
    }
    const res = await get("/api/support?page=1&pageSize=20", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { id: number; user?: { id: number } | null; createdAtDisplay: string | null; isOverdue: boolean }[];
      total: number;
      page: number;
      pageSize: number;
      stats: { open: number; waitingCustomer: number; overdue: number; unassigned: number; resolvedToday: number };
    };
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    expect(body.items).toHaveLength(3);
    // The list-vs-detail bug this rewrite fixes: `user` must be populated.
    expect(body.items[0]!.user).toBeTruthy();
    expect(typeof body.items[0]!.isOverdue).toBe("boolean");
    expect(body.stats).toMatchObject({ open: 3, unassigned: 3 });
  });

  it("filters by status (csv)", async () => {
    const t1 = await createTicket(prisma, customerId, "Open one");
    const t2 = await createTicket(prisma, customerId, "Closed one");
    await prisma.supportTicket.update({ where: { id: t2.id }, data: { status: "CLOSED" } });

    const res = await get("/api/support?status=CLOSED", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: number }[] };
    expect(body.items.map((t) => t.id)).toEqual([t2.id]);
    expect(body.items.map((t) => t.id)).not.toContain(t1.id);
  });

  it("filters by priority (csv)", async () => {
    const low = await createTicket(prisma, customerId, "Low prio");
    await prisma.supportTicket.update({ where: { id: low.id }, data: { priority: "LOW" } });
    await createTicket(prisma, customerId, "Default (medium) prio");

    const res = await get("/api/support?priority=LOW", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: number }[] };
    expect(body.items.map((t) => t.id)).toEqual([low.id]);
  });

  it("filters by assigned/unassigned", async () => {
    const assigned = await createTicket(prisma, customerId, "Assigned one");
    await assignTicket(prisma, assigned.id, adminId);
    await createTicket(prisma, customerId, "Unassigned one");

    const res = await get("/api/support?assigned=assigned", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: number }[] };
    expect(body.items.map((t) => t.id)).toEqual([assigned.id]);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await get("/api/support", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});

describe("GET /api/support/:ticketId", () => {
  it("happy path: includes customer context and timeline blocks", async () => {
    const ticket = await createTicket(prisma, customerId, "Need help");
    await postJson(`/api/support/${ticket.id}/reply`, cookie, csrf, { content: "On it" });

    const res = await get(`/api/support/${ticket.id}`, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ticket: { id: number };
      messages: unknown[];
      customer: { totalSpent: unknown; orderCount: number; recentOrders: unknown[]; openTicketCount: number };
      timeline: { ticket: unknown[]; order: unknown[] };
    };
    expect(body.ticket.id).toBe(ticket.id);
    expect(body.customer.orderCount).toBe(0);
    expect(body.customer.openTicketCount).toBe(1);
    expect(Array.isArray(body.customer.recentOrders)).toBe(true);
    // ticket_reply above wrote an audit row targeting this ticket.
    expect(body.timeline.ticket.length).toBeGreaterThan(0);
    expect(body.timeline.order).toEqual([]);
  });

  it("404s for a non-existent ticket", async () => {
    const res = await get("/api/support/999999", cookie);
    expect(res.statusCode).toBe(404);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const ticket = await createTicket(prisma, customerId, "Need help");
    const res = await get(`/api/support/${ticket.id}`, null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});

describe("POST /api/support/:ticketId/priority", () => {
  it("happy path: sets priority and audits", async () => {
    const ticket = await createTicket(prisma, customerId, "Help please");
    const res = await postJson(`/api/support/${ticket.id}/priority`, cookie, csrf, { priority: "urgent" });
    expect(res.statusCode).toBe(200);
    expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).priority).toBe("URGENT");
    const audit = await prisma.auditLog.findFirst({ where: { action: "ticket_set_priority" } });
    expect(audit).toBeTruthy();
  });

  it("rejects an invalid priority with 400", async () => {
    const ticket = await createTicket(prisma, customerId, "Help please");
    const res = await postJson(`/api/support/${ticket.id}/priority`, cookie, csrf, { priority: "SUPER_URGENT" });
    expect(res.statusCode).toBe(400);
  });

  it("404s for a non-existent ticket", async () => {
    const res = await postJson("/api/support/999999/priority", cookie, csrf, { priority: "HIGH" });
    expect(res.statusCode).toBe(404);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const ticket = await createTicket(prisma, customerId, "Help please");
    const res = await postJson(`/api/support/${ticket.id}/priority`, null, csrf, { priority: "HIGH" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const ticket = await createTicket(prisma, customerId, "Help please");
    const res = await postJson(`/api/support/${ticket.id}/priority`, cookie, "bad", { priority: "HIGH" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/support/bulk-action", () => {
  it("assign: happy path assigns all ids and audits a single summary row", async () => {
    const t1 = await createTicket(prisma, customerId, "One");
    const t2 = await createTicket(prisma, customerId, "Two");
    const res = await postJson("/api/support/bulk-action", cookie, csrf, {
      ids: [t1.id, t2.id],
      action: "assign",
      adminId,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { succeeded: number[]; failed: unknown[] };
    expect(body.succeeded.sort()).toEqual([t1.id, t2.id].sort());
    expect(body.failed).toEqual([]);
    expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: t1.id } })).adminId).toBe(adminId);
    const audits = await prisma.auditLog.findMany({ where: { action: "ticket_bulk_assign" } });
    expect(audits).toHaveLength(1);
  });

  it("priority: happy path bulk-sets priority and audits", async () => {
    const t1 = await createTicket(prisma, customerId, "One");
    const res = await postJson("/api/support/bulk-action", cookie, csrf, {
      ids: [t1.id],
      action: "priority",
      priority: "low",
    });
    expect(res.statusCode).toBe(200);
    expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: t1.id } })).priority).toBe("LOW");
    const audit = await prisma.auditLog.findFirst({ where: { action: "ticket_bulk_priority" } });
    expect(audit).toBeTruthy();
  });

  it("priority: rejects an invalid priority with 400", async () => {
    const t1 = await createTicket(prisma, customerId, "One");
    const res = await postJson("/api/support/bulk-action", cookie, csrf, {
      ids: [t1.id],
      action: "priority",
      priority: "nope",
    });
    expect(res.statusCode).toBe(400);
  });

  it("close: happy path closes all ids and audits a single summary row", async () => {
    const t1 = await createTicket(prisma, customerId, "One");
    const res = await postJson("/api/support/bulk-action", cookie, csrf, { ids: [t1.id], action: "close" });
    expect(res.statusCode).toBe(200);
    expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: t1.id } })).status).toBe("CLOSED");
    const audits = await prisma.auditLog.findMany({ where: { action: "ticket_bulk_close" } });
    expect(audits).toHaveLength(1);
  });

  it("rejects more than 50 ids with 400", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    const res = await postJson("/api/support/bulk-action", cookie, csrf, { ids, action: "close" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown action with 400", async () => {
    const t1 = await createTicket(prisma, customerId, "One");
    const res = await postJson("/api/support/bulk-action", cookie, csrf, { ids: [t1.id], action: "delete" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an empty selection with 400", async () => {
    const res = await postJson("/api/support/bulk-action", cookie, csrf, { ids: [], action: "close" });
    expect(res.statusCode).toBe(400);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const t1 = await createTicket(prisma, customerId, "One");
    const res = await postJson("/api/support/bulk-action", null, csrf, { ids: [t1.id], action: "close" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const t1 = await createTicket(prisma, customerId, "One");
    const res = await postJson("/api/support/bulk-action", cookie, "bad", { ids: [t1.id], action: "close" });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/support/photo/:fileId", () => {
  const realResolver = getFileResolver();
  afterEach(() => {
    setFileResolver(realResolver);
  });

  it("happy path: redirects to the resolved Telegram file URL (stubbed, never hits the real network)", async () => {
    setFileResolver(async (botToken, fileId) => {
      expect(botToken).toBeTruthy();
      expect(fileId).toBe("FAKE_FILE_ID");
      return { ok: true, filePath: "photos/fake.jpg" };
    });
    const res = await get("/api/support/photo/FAKE_FILE_ID", cookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/api\.telegram\.org\/file\/bot.+\/photos\/fake\.jpg$/);
  });

  it("returns 503 when no bot token is configured", async () => {
    setFileResolver(async () => ({ ok: true, filePath: "photos/fake.jpg" }));
    const originalToken = config.BOT_TOKEN;
    config.BOT_TOKEN = "";
    try {
      const res = await get("/api/support/photo/FAKE_FILE_ID", cookie);
      expect(res.statusCode).toBe(503);
    } finally {
      config.BOT_TOKEN = originalToken;
    }
  });

  it("returns 502 when Telegram can't resolve the file", async () => {
    setFileResolver(async () => ({ ok: false }));
    const res = await get("/api/support/photo/FAKE_FILE_ID", cookie);
    expect(res.statusCode).toBe(502);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await get("/api/support/photo/FAKE_FILE_ID", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});
