import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import {
  prisma,
  initDb,
  upsertUser,
  setSetting,
  createCategory,
  createCatalogProduct,
  createDenomination,
  createOrderDirect,
  bulkAddStock,
} from "@app/db";
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

async function makeFailedNotif(): Promise<number> {
  const row = await prisma.notificationOutbox.create({
    data: { event: "ORDER_DELIVERED", payloadJson: JSON.stringify({ x: 1 }), status: "FAILED", attempts: 5, lastError: "boom" },
  });
  return row.id;
}

describe("POST /api/outbox/:id/retry", () => {
  it("happy path: requeues a FAILED notification back to PENDING and audits", async () => {
    const id = await makeFailedNotif();
    const res = await postJson(`/api/outbox/${id}/retry`, cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const row = await prisma.notificationOutbox.findUnique({ where: { id } });
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(0);
    expect(row!.lastError).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "outbox_retry", targetId: id } });
    expect(audit).toBeTruthy();
  });

  it("returns 404 for a notification that no longer exists, writes no audit", async () => {
    const res = await postJson(`/api/outbox/999999/retry`, cookie, csrf);
    expect(res.statusCode).toBe(404);
    expect(await prisma.auditLog.findFirst({ where: { action: "outbox_retry" } })).toBeNull();
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const id = await makeFailedNotif();
    const res = await postJson(`/api/outbox/${id}/retry`, null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.notificationOutbox.findUnique({ where: { id } }))!.status).toBe("FAILED");
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const id = await makeFailedNotif();
    const res = await postJson(`/api/outbox/${id}/retry`, cookie, "bad");
    expect(res.statusCode).toBe(403);
    expect((await prisma.notificationOutbox.findUnique({ where: { id } }))!.status).toBe("FAILED");
  });
});

async function makeReview(hidden = false): Promise<{ reviewId: number; buyerId: number }> {
  const category = await createCategory(prisma, `c${Math.random()}`);
  const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "P" });
  const product = await createDenomination(prisma, { productId: parent.id, name: "P", type: "SHARED", durationLabel: "1 Month", price: "5" });
  // createOrderDirect requires AVAILABLE stock — seed one row so the order can
  // actually be placed (the brief's version omitted this and would have
  // thrown error.out_of_stock).
  await bulkAddStock(prisma, product.id, [`stock-${Math.random()}`]);
  const buyer = await upsertUser(prisma, { telegramId: Math.floor(Math.random() * 1_000_000_000), username: "buyer", fullName: "Buyer" });
  const order = await createOrderDirect(prisma, { user: buyer, productId: product.id, quantity: 1 });
  const r = await prisma.review.create({
    data: { userId: buyer.id, orderId: order!.id, productId: product.id, rating: 5, comment: "great", hidden },
  });
  return { reviewId: r.id, buyerId: buyer.id };
}

describe("POST /api/reviews/:reviewId/hide", () => {
  it("happy path: hides a review and audits", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/hide`, cookie, csrf, { hidden: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, hidden: true });
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.hidden).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { action: "review_hide", targetId: reviewId } });
    expect(audit).toBeTruthy();
  });

  it("unhide restores the review and audits as review_unhide", async () => {
    const { reviewId } = await makeReview(true);
    const res = await postJson(`/api/reviews/${reviewId}/hide`, cookie, csrf, { hidden: false });
    expect(res.statusCode).toBe(200);
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.hidden).toBe(false);
    const audit = await prisma.auditLog.findFirst({ where: { action: "review_unhide", targetId: reviewId } });
    expect(audit).toBeTruthy();
  });

  it("returns 404 for a review that doesn't exist", async () => {
    const res = await postJson(`/api/reviews/999999/hide`, cookie, csrf, { hidden: true });
    expect(res.statusCode).toBe(404);
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/hide`, null, csrf, { hidden: true });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.hidden).toBe(false);
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/hide`, cookie, "bad", { hidden: true });
    expect(res.statusCode).toBe(403);
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.hidden).toBe(false);
  });
});
