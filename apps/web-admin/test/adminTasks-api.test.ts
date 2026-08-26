import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { AdminTaskType, AdminTaskStatus, AdminTaskPriority } from "@app/core/enums";
import {
  prisma,
  initDb,
  upsertUser,
  setSetting,
  createCategory,
  createCatalogProduct,
  createDenomination,
  bulkAddStock,
  createOrderDirect,
  createAdminTask,
  createRefund,
} from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti, webRoleKey } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
// Must be in setup-env.ts's ADMIN_IDS ("999,1000") — upsertUser only stamps
// User.role=ADMIN for a telegram id config recognizes as an admin (see
// packages/db/src/crud/users.ts's isAdmin() gate), which is what
// assignAdminTask's "assignee must have role ADMIN" check actually reads.
const OTHER_ADMIN_TG = 1000;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let adminId: number;
let otherAdminId: number;
let customerId: number;
let orderId: number;
let orderItemId: number;

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

  const otherAdmin = await upsertUser(prisma, { telegramId: OTHER_ADMIN_TG, username: "otheradmin", fullName: "Other Admin" });
  otherAdminId = otherAdmin.id;

  const customer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
  customerId = customer.id;

  const category = await createCategory(prisma, "TestCategory");
  const catalogProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "TestProduct" });
  const denomination = await createDenomination(prisma, {
    productId: catalogProduct.id,
    name: "Test Denom",
    type: "SHARED",
    durationLabel: "Test",
    price: "100",
  });
  await bulkAddStock(prisma, denomination.id, ["test@example.com:code1"]);
  const order = await createOrderDirect(prisma, {
    user: { id: customerId, role: customer.role },
    productId: denomination.id,
    quantity: 1,
  });
  orderId = order!.id;
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId } });
  orderItemId = item.id;
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

async function makeTask(overrides: Partial<Parameters<typeof createAdminTask>[1]> = {}) {
  return createAdminTask(prisma, {
    type: AdminTaskType.MANUAL_DELIVERY,
    orderId,
    adminId,
    ...overrides,
  });
}

describe("GET /api/admin-tasks/assignees", () => {
  it("a support-role admin (not just super) gets a non-empty assignee list", async () => {
    await setSetting(prisma, webRoleKey(ADMIN_TG), "support");
    const res = await get("/api/admin-tasks/assignees", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { admins: Array<{ id: number; name: string }> };
    expect(body.admins.length).toBeGreaterThanOrEqual(2);
    expect(body.admins.map((a) => a.id)).toEqual(expect.arrayContaining([adminId, otherAdminId]));
    // Never the customer, who is not role=ADMIN.
    expect(body.admins.map((a) => a.id)).not.toContain(customerId);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await get("/api/admin-tasks/assignees", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});

describe("GET /api/admin-tasks", () => {
  it("happy path: lists tasks newest-first with queue-wide stats", async () => {
    await makeTask();
    await makeTask({ type: AdminTaskType.REQUEST_CUSTOMER_INFO });

    const res = await get("/api/admin-tasks", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number; stats: { pending: number } };
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.stats.pending).toBeGreaterThanOrEqual(2);
  });

  it("shapes an order/orderItem/refund-linked task without leaking raw relation rows", async () => {
    const refund = await createRefund(prisma, { orderId, amount: "10.00", currency: "IDR", adminId });
    await makeTask({ type: AdminTaskType.REFUND_REVIEW, orderItemId, refundId: refund.id });

    const res = await get("/api/admin-tasks", cookie);
    const body = res.json() as {
      items: Array<{ order: { orderCode: string } | null; orderItem: { id: number } | null; refund: { amount: string; currency: string } | null }>;
    };
    const task = body.items[0]!;
    expect(task.order?.orderCode).toBeTruthy();
    expect(task.orderItem?.id).toBe(orderItemId);
    expect(task.refund?.amount).toBe("10");
    expect(task.refund?.currency).toBe("IDR");
  });

  it("filters by status/type/priority", async () => {
    await makeTask({ type: AdminTaskType.MANUAL_DELIVERY, priority: AdminTaskPriority.HIGH });
    await makeTask({ type: AdminTaskType.FAILED_TOPUP_REVIEW });

    const byType = await get("/api/admin-tasks?type=FAILED_TOPUP_REVIEW", cookie);
    const byTypeBody = byType.json() as { items: Array<{ type: string }> };
    expect(byTypeBody.items).toHaveLength(1);
    expect(byTypeBody.items[0]!.type).toBe("FAILED_TOPUP_REVIEW");

    const byPriority = await get("/api/admin-tasks?priority=HIGH", cookie);
    const byPriorityBody = byPriority.json() as { items: unknown[] };
    expect(byPriorityBody.items).toHaveLength(1);
  });

  it("filters by assignedTo=unassigned", async () => {
    const assigned = await makeTask();
    await postJson(`/api/admin-tasks/${assigned.id}/assign`, cookie, csrf, {
      from: AdminTaskStatus.PENDING,
      assignedTo: adminId,
    });
    await makeTask();

    const res = await get("/api/admin-tasks?assignedTo=unassigned", cookie);
    const body = res.json() as { items: Array<{ assignedTo: number | null }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.assignedTo).toBeNull();
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await get("/api/admin-tasks", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});

describe("POST /api/admin-tasks/:taskId/assign", () => {
  it("happy path: PENDING -> ASSIGNED, sets assignedTo, and audits", async () => {
    const task = await makeTask();
    const res = await postJson(`/api/admin-tasks/${task.id}/assign`, cookie, csrf, {
      from: AdminTaskStatus.PENDING,
      assignedTo: otherAdminId,
    });
    expect(res.statusCode).toBe(200);
    const updated = await prisma.adminTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe("ASSIGNED");
    expect(updated.assignedTo).toBe(otherAdminId);
    const audit = await prisma.auditLog.findFirst({ where: { action: "admin_task_status_change", targetId: task.id } });
    expect(audit).toBeTruthy();
  });

  it("422s on a stale/illegal transition (already ASSIGNED elsewhere)", async () => {
    const task = await makeTask();
    await postJson(`/api/admin-tasks/${task.id}/assign`, cookie, csrf, { from: "PENDING", assignedTo: otherAdminId });
    // Retrying the same "from: PENDING" claim now fails — the row already moved on.
    const res = await postJson(`/api/admin-tasks/${task.id}/assign`, cookie, csrf, { from: "PENDING", assignedTo: adminId });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("error.illegal_admin_task_status_transition");
  });

  it("422s when assignedTo isn't an admin", async () => {
    const task = await makeTask();
    const res = await postJson(`/api/admin-tasks/${task.id}/assign`, cookie, csrf, { from: "PENDING", assignedTo: customerId });
    expect(res.statusCode).toBe(422);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const task = await makeTask();
    const res = await postJson(`/api/admin-tasks/${task.id}/assign`, null, csrf, { from: "PENDING", assignedTo: adminId });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const task = await makeTask();
    const res = await postJson(`/api/admin-tasks/${task.id}/assign`, cookie, "bad", { from: "PENDING", assignedTo: adminId });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/admin-tasks/:taskId/start", () => {
  it("happy path: ASSIGNED -> IN_PROGRESS", async () => {
    const task = await makeTask();
    await postJson(`/api/admin-tasks/${task.id}/assign`, cookie, csrf, { from: "PENDING", assignedTo: adminId });
    const res = await postJson(`/api/admin-tasks/${task.id}/start`, cookie, csrf, { from: "ASSIGNED" });
    expect(res.statusCode).toBe(200);
    const updated = await prisma.adminTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe("IN_PROGRESS");
  });

  it("422s starting straight from PENDING (must be assigned first)", async () => {
    const task = await makeTask();
    const res = await postJson(`/api/admin-tasks/${task.id}/start`, cookie, csrf, { from: "PENDING" });
    expect(res.statusCode).toBe(422);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const task = await makeTask();
    const res = await postJson(`/api/admin-tasks/${task.id}/start`, null, csrf, { from: "ASSIGNED" });
    expect(res.statusCode).toBe(303);
  });

  it("rejects bad CSRF (403)", async () => {
    const task = await makeTask();
    const res = await postJson(`/api/admin-tasks/${task.id}/start`, cookie, "bad", { from: "ASSIGNED" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/admin-tasks/:taskId/complete", () => {
  it("happy path: IN_PROGRESS -> COMPLETED, stamps completedAt", async () => {
    const task = await makeTask();
    await postJson(`/api/admin-tasks/${task.id}/assign`, cookie, csrf, { from: "PENDING", assignedTo: adminId });
    await postJson(`/api/admin-tasks/${task.id}/start`, cookie, csrf, { from: "ASSIGNED" });
    const res = await postJson(`/api/admin-tasks/${task.id}/complete`, cookie, csrf, { from: "IN_PROGRESS" });
    expect(res.statusCode).toBe(200);
    const updated = await prisma.adminTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.completedAt).not.toBeNull();
  });

  it("requires auth (anon → 303 /login)", async () => {
    const task = await makeTask();
    const res = await postJson(`/api/admin-tasks/${task.id}/complete`, null, csrf, { from: "IN_PROGRESS" });
    expect(res.statusCode).toBe(303);
  });

  it("rejects bad CSRF (403)", async () => {
    const task = await makeTask();
    const res = await postJson(`/api/admin-tasks/${task.id}/complete`, cookie, "bad", { from: "IN_PROGRESS" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/admin-tasks/:taskId/escalate", () => {
  it("happy path: PENDING -> ESCALATED, keeps no assignee", async () => {
    const task = await makeTask();
    const res = await postJson(`/api/admin-tasks/${task.id}/escalate`, cookie, csrf, { from: "PENDING" });
    expect(res.statusCode).toBe(200);
    const updated = await prisma.adminTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe("ESCALATED");
    expect(updated.assignedTo).toBeNull();
  });

  it("requires auth (anon → 303 /login)", async () => {
    const task = await makeTask();
    const res = await postJson(`/api/admin-tasks/${task.id}/escalate`, null, csrf, { from: "PENDING" });
    expect(res.statusCode).toBe(303);
  });

  it("rejects bad CSRF (403)", async () => {
    const task = await makeTask();
    const res = await postJson(`/api/admin-tasks/${task.id}/escalate`, cookie, "bad", { from: "PENDING" });
    expect(res.statusCode).toBe(403);
  });
});
