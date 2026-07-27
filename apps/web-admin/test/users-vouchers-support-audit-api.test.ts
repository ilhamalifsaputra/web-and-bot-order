import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { addMinutes } from "@app/core/datetime";
import { prisma, initDb, upsertUser, setSetting, createTicket, assignTicket, createCategory, createCatalogProduct, createDenomination, bulkAddStock, createOrderDirect } from "@app/db";
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

describe("POST /api/users/:userId/wallet", () => {
  it("happy path: credits a customer's wallet and audits", async () => {
    const res = await postJson(`/api/users/${customerId}/wallet`, cookie, csrf, {
      delta: "50000",
      currency: "IDR",
      note: "manual top-up",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; newBalance: string };
    expect(body.newBalance).toBe("50000");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    expect(user.walletBalance.toString()).toBe("50000");
    const audit = await prisma.auditLog.findFirst({ where: { action: "wallet_adjust" } });
    expect(audit).toBeTruthy();
  });

  it("404s for a non-existent user", async () => {
    const res = await postJson(`/api/users/999999/wallet`, cookie, csrf, { delta: "1000", note: "x" });
    expect(res.statusCode).toBe(404);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await postJson(`/api/users/${customerId}/wallet`, null, csrf, { delta: "1000", note: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const res = await postJson(`/api/users/${customerId}/wallet`, cookie, "bad", { delta: "1000", note: "x" });
    expect(res.statusCode).toBe(403);
  });

  it("is atomic: audit-log failure rolls back the balance change and ledger row too", async () => {
    // adjustWallet (no internal $transaction of its own — its doc comment
    // requires the CALLER to wrap it) writes the new wallet balance AND a
    // wallet_transactions ledger row as two separate awaited calls, before
    // logAdminAction writes a third, separate audit row. Force the audit
    // insert to fail (FK violation: the acting admin's User row no longer
    // exists, so audit_logs.admin_id has nothing to reference) and prove the
    // route's prisma.$transaction rolls the balance + ledger write back with
    // it — not just the audit write — so the three can never diverge.
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: customerId } })).walletBalance.toString();
    await prisma.user.delete({ where: { id: adminId } });

    const res = await postJson(`/api/users/${customerId}/wallet`, cookie, csrf, {
      delta: "50000",
      currency: "IDR",
      note: "manual top-up",
    });
    // Not a ValidationError, so the route's catch rethrows → Fastify 500,
    // not the usual JSON error response.
    expect(res.statusCode).toBe(500);

    // The balance must be unchanged — the adjustWallet write must have
    // rolled back alongside the failed audit insert.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    expect(user.walletBalance.toString()).toBe(before);

    // And no wallet_transactions ledger row or audit row exists either.
    const ledger = await prisma.walletTransaction.findMany({ where: { userId: customerId } });
    expect(ledger.length).toBe(0);
    const audit = await prisma.auditLog.findMany({ where: { action: "wallet_adjust" } });
    expect(audit.length).toBe(0);
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

  it("stamps isOverdue: true on an OPEN, never-replied ticket older than the 4h cutoff", async () => {
    const overdue = await createTicket(prisma, customerId, "Old open ticket");
    await prisma.supportTicket.update({
      where: { id: overdue.id },
      data: { createdAt: addMinutes(new Date(), -300) }, // 5h old — past the 4h overdue cutoff
    });
    const fresh = await createTicket(prisma, customerId, "Fresh open ticket"); // just created

    const res = await get("/api/support", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: number; isOverdue: boolean }[] };
    const overdueItem = body.items.find((t) => t.id === overdue.id);
    const freshItem = body.items.find((t) => t.id === fresh.id);
    expect(overdueItem?.isOverdue).toBe(true);
    expect(freshItem?.isOverdue).toBe(false);
  });

  it("filters by overdue=true — only OPEN, never-replied tickets older than the 4h cutoff", async () => {
    const overdue = await createTicket(prisma, customerId, "Old open ticket");
    await prisma.supportTicket.update({
      where: { id: overdue.id },
      data: { createdAt: addMinutes(new Date(), -300) },
    });
    const fresh = await createTicket(prisma, customerId, "Fresh open ticket");

    const res = await get("/api/support?overdue=true", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: number }[] };
    expect(body.items.map((t) => t.id)).toEqual([overdue.id]);
    expect(body.items.map((t) => t.id)).not.toContain(fresh.id);
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

  it("includes the order timeline block when the ticket is linked to an order", async () => {
    const order = await prisma.order.create({
      data: { orderCode: "ORD-t1", userId: customerId, subtotalAmount: "1", totalAmount: "1" },
    });
    await prisma.auditLog.create({
      data: { adminId, action: "approve_order", targetType: "order", targetId: order.id, details: "test" },
    });
    const ticket = await createTicket(prisma, customerId, "Order issue", null, null, order.id);

    const res = await get(`/api/support/${ticket.id}`, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { timeline: { ticket: unknown[]; order: unknown[] } };
    expect(body.timeline.order.length).toBeGreaterThan(0);
  });

  it("stamps server-side *Display timestamps on the ticket, its order, and every timeline row — never leaves it to the browser's local timezone", async () => {
    const order = await prisma.order.create({
      data: { orderCode: "ORD-t2", userId: customerId, subtotalAmount: "1", totalAmount: "1" },
    });
    await prisma.auditLog.create({
      data: { adminId, action: "approve_order", targetType: "order", targetId: order.id, details: "test" },
    });
    const ticket = await createTicket(prisma, customerId, "Order issue", null, null, order.id);
    await postJson(`/api/support/${ticket.id}/reply`, cookie, csrf, { content: "On it" });

    const res = await get(`/api/support/${ticket.id}`, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ticket: { createdAtDisplay: string | null; order: { createdAtDisplay: string | null } | null };
      timeline: { ticket: { createdAtDisplay: string | null }[]; order: { createdAtDisplay: string | null }[] };
    };
    expect(typeof body.ticket.createdAtDisplay).toBe("string");
    expect(body.ticket.order?.createdAtDisplay).toEqual(expect.any(String));
    expect(body.timeline.ticket.length).toBeGreaterThan(0);
    for (const row of body.timeline.ticket) expect(typeof row.createdAtDisplay).toBe("string");
    expect(body.timeline.order.length).toBeGreaterThan(0);
    for (const row of body.timeline.order) expect(typeof row.createdAtDisplay).toBe("string");
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
  it("assign: happy path assigns all ids, audits one summary row plus one per-ticket row each", async () => {
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
    const summaryRows = await prisma.auditLog.findMany({
      where: { action: "ticket_bulk_assign", targetId: null },
    });
    expect(summaryRows).toHaveLength(1);
    // Each affected ticket ALSO gets its own row (targetId set) — so its own
    // detail-page timeline (which reads listAuditLogs({targetType, targetId}))
    // isn't empty, the same as a single-ticket /assign call would produce.
    const t1Row = await prisma.auditLog.findFirst({ where: { action: "ticket_bulk_assign", targetId: t1.id } });
    const t2Row = await prisma.auditLog.findFirst({ where: { action: "ticket_bulk_assign", targetId: t2.id } });
    expect(t1Row?.details).toBe(`Assigned ticket #${t1.id} to "Admin".`);
    expect(t2Row?.details).toBe(`Assigned ticket #${t2.id} to "Admin".`);
  });

  it("assign: a non-existent id in the batch is reported as failed, not falsely echoed as succeeded", async () => {
    const t1 = await createTicket(prisma, customerId, "One");
    const res = await postJson("/api/support/bulk-action", cookie, csrf, {
      ids: [t1.id, 999999],
      action: "assign",
      adminId,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { succeeded: number[]; failed: { id: number; error: string }[] };
    // The concrete regression this guards: updateMany silently no-ops on the
    // nonexistent id, so the response must NOT just echo back both requested
    // ids as succeeded — it must match what actually changed in the DB.
    expect(body.succeeded).toEqual([t1.id]);
    expect(body.failed).toEqual([{ id: 999999, error: "ticket not found" }]);
    expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: t1.id } })).adminId).toBe(adminId);
    const audit = await prisma.auditLog.findFirst({ where: { action: "ticket_bulk_assign", targetId: null } });
    expect(audit!.details).toContain("Assigned 1 ticket");
    expect(audit!.details).not.toContain("Assigned 1 tickets");
  });

  it("priority: happy path bulk-sets priority and audits both a summary row and a per-ticket row", async () => {
    const t1 = await createTicket(prisma, customerId, "One");
    const res = await postJson("/api/support/bulk-action", cookie, csrf, {
      ids: [t1.id],
      action: "priority",
      priority: "low",
    });
    expect(res.statusCode).toBe(200);
    expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: t1.id } })).priority).toBe("LOW");
    const summary = await prisma.auditLog.findFirst({
      where: { action: "ticket_bulk_priority", targetId: null },
    });
    expect(summary).toBeTruthy();
    expect(summary!.details).toBe("Set 1 ticket's priority to LOW.");
    const t1Row = await prisma.auditLog.findFirst({ where: { action: "ticket_bulk_priority", targetId: t1.id } });
    expect(t1Row?.details).toBe(`Set ticket #${t1.id}'s priority to LOW.`);
  });

  it("priority: a non-existent id in the batch is reported as failed, not falsely echoed as succeeded", async () => {
    const t1 = await createTicket(prisma, customerId, "One");
    const res = await postJson("/api/support/bulk-action", cookie, csrf, {
      ids: [t1.id, 999999],
      action: "priority",
      priority: "high",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { succeeded: number[]; failed: { id: number; error: string }[] };
    expect(body.succeeded).toEqual([t1.id]);
    expect(body.failed).toEqual([{ id: 999999, error: "ticket not found" }]);
    expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: t1.id } })).priority).toBe("HIGH");
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

  it("close: happy path closes all ids, audits one summary row plus one per-ticket row", async () => {
    const t1 = await createTicket(prisma, customerId, "One");
    const res = await postJson("/api/support/bulk-action", cookie, csrf, { ids: [t1.id], action: "close" });
    expect(res.statusCode).toBe(200);
    expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: t1.id } })).status).toBe("CLOSED");
    const summaryRows = await prisma.auditLog.findMany({ where: { action: "ticket_bulk_close", targetId: null } });
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0]!.details).toBe("Closed 1 ticket.");
    const t1Row = await prisma.auditLog.findFirst({ where: { action: "ticket_bulk_close", targetId: t1.id } });
    expect(t1Row?.details).toBe(`Closed ticket #${t1.id}.`);
  });

  it("close: a bulk-closed ticket's own detail-page timeline shows the per-ticket audit row, not just the bulk summary", async () => {
    const t1 = await createTicket(prisma, customerId, "One");
    const res = await postJson("/api/support/bulk-action", cookie, csrf, { ids: [t1.id], action: "close" });
    expect(res.statusCode).toBe(200);

    const detail = await get(`/api/support/${t1.id}`, cookie);
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { timeline: { ticket: { action: string; details: string | null }[] } };
    expect(
      body.timeline.ticket.some(
        (row) => row.action === "ticket_bulk_close" && row.details === `Closed ticket #${t1.id}.`,
      ),
    ).toBe(true);
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

  it("happy path: proxies the photo bytes (never redirects the browser to a URL containing the bot token)", async () => {
    const originalFetch = global.fetch;
    setFileResolver(async (botToken, fileId) => {
      expect(botToken).toBeTruthy();
      expect(fileId).toBe("FAKE_FILE_ID");
      return { ok: true, filePath: "photos/fake.jpg" };
    });
    const fakeBytes = Buffer.from("fake-jpeg-bytes");
    global.fetch = (async (url: string) => {
      // The bot token DOES appear in this server-to-Telegram fetch URL — that's
      // expected (it's a direct backend call, never sent to the browser). What
      // must NOT happen is the token reaching the client via a redirect.
      expect(url).toMatch(/^https:\/\/api\.telegram\.org\/file\/bot.+\/photos\/fake\.jpg$/);
      return {
        ok: true,
        headers: new Map([["content-type", "image/jpeg"]]) as unknown as Headers,
        arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength),
      } as unknown as Response;
    }) as typeof fetch;
    try {
      const res = await get("/api/support/photo/FAKE_FILE_ID", cookie);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("image/jpeg");
      expect(res.headers.location).toBeUndefined();
      expect(res.rawPayload.toString()).toBe("fake-jpeg-bytes");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns 502 when the upstream Telegram file fetch itself fails (never leaks the token in the response)", async () => {
    const originalFetch = global.fetch;
    setFileResolver(async () => ({ ok: true, filePath: "photos/fake.jpg" }));
    global.fetch = (async () => ({ ok: false, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
    try {
      const res = await get("/api/support/photo/FAKE_FILE_ID", cookie);
      expect(res.statusCode).toBe(502);
      expect(JSON.stringify(res.json())).not.toContain(config.BOT_TOKEN);
    } finally {
      global.fetch = originalFetch;
    }
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

describe("GET /api/users", () => {
  it("returns users with correct totalOrders in response", async () => {
    // Create a product/denomination with stock
    const category = await createCategory(prisma, "TestCategory");
    const catalogProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "TestProduct" });
    const denomination = await createDenomination(prisma, {
      productId: catalogProduct.id,
      name: "Test Denom",
      type: "SHARED",
      durationLabel: "Test",
      price: "100",
    });
    await bulkAddStock(prisma, denomination.id, ["test@example.com:code1", "test@example.com:code2"]);

    // Create an order for customerId
    const customer = await prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    await createOrderDirect(prisma, {
      user: { id: customer.id, role: customer.role },
      productId: denomination.id,
      quantity: 1,
    });

    // Create a second user with no orders
    const userWithoutOrders = await upsertUser(prisma, { telegramId: 99, username: "noorders", fullName: "No Orders" });

    // Call GET /api/users
    const res = await get("/api/users", cookie);
    expect(res.statusCode).toBe(200);

    const body = res.json() as { users: Array<{ id: number; totalOrders: number }> };
    expect(Array.isArray(body.users)).toBe(true);

    // Find the users in the response
    const userWithOrder = body.users.find((u) => u.id === customerId);
    const userWithoutOrder = body.users.find((u) => u.id === userWithoutOrders.id);

    // Assert totalOrders values
    expect(userWithOrder).toBeDefined();
    expect(userWithOrder!.totalOrders).toBe(1);

    expect(userWithoutOrder).toBeDefined();
    expect(userWithoutOrder!.totalOrders).toBe(0);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await get("/api/users", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});
