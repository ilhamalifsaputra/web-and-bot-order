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

function deleteReq(url: string, c: string | null, csrfToken: string) {
  return app.inject({
    method: "DELETE",
    url,
    headers: { "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
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
    expect(audit!.details).toContain("ORDER_DELIVERED");
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
  const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Test Product" });
  const product = await createDenomination(prisma, { productId: parent.id, name: "Test Product", type: "SHARED", durationLabel: "1 Month", price: "5" });
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
    expect(audit!.details).toContain("5-star");
    expect(audit!.details).toContain("Test Product");
  });

  it("unhide restores the review and audits as review_unhide", async () => {
    const { reviewId } = await makeReview(true);
    const res = await postJson(`/api/reviews/${reviewId}/hide`, cookie, csrf, { hidden: false });
    expect(res.statusCode).toBe(200);
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.hidden).toBe(false);
    const audit = await prisma.auditLog.findFirst({ where: { action: "review_unhide", targetId: reviewId } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("5-star");
    expect(audit!.details).toContain("Test Product");
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

describe("POST /api/reviews/:reviewId/reply", () => {
  it("happy path: saves a reply, flips status to REPLIED, and audits", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/reply`, cookie, csrf, { reply: "Thanks for the feedback!" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const row = await prisma.review.findUnique({ where: { id: reviewId } });
    expect(row!.adminReply).toBe("Thanks for the feedback!");
    expect(row!.status).toBe("REPLIED");
    expect(row!.repliedAt).toBeTruthy();
    const audit = await prisma.auditLog.findFirst({ where: { action: "review_reply", targetId: reviewId } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("5-star");
    expect(audit!.details).toContain("Test Product");
  });

  it("replying again to an already-replied review audits as review_reply_edit", async () => {
    const { reviewId } = await makeReview();
    await postJson(`/api/reviews/${reviewId}/reply`, cookie, csrf, { reply: "First reply" });
    const res = await postJson(`/api/reviews/${reviewId}/reply`, cookie, csrf, { reply: "Updated reply" });
    expect(res.statusCode).toBe(200);
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.adminReply).toBe("Updated reply");
    const audit = await prisma.auditLog.findFirst({ where: { action: "review_reply_edit", targetId: reviewId } });
    expect(audit).toBeTruthy();
  });

  it("returns 400 for a blank reply", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/reply`, cookie, csrf, { reply: "   " });
    expect(res.statusCode).toBe(400);
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.adminReply).toBeNull();
  });

  it("returns 404 for a review that doesn't exist", async () => {
    const res = await postJson(`/api/reviews/999999/reply`, cookie, csrf, { reply: "Hi" });
    expect(res.statusCode).toBe(404);
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/reply`, null, csrf, { reply: "Hi" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.adminReply).toBeNull();
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/reply`, cookie, "bad", { reply: "Hi" });
    expect(res.statusCode).toBe(403);
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.adminReply).toBeNull();
  });
});

describe("DELETE /api/reviews/:reviewId/reply", () => {
  it("happy path: clears the reply, reverts status to PENDING_REPLY, and audits", async () => {
    const { reviewId } = await makeReview();
    await postJson(`/api/reviews/${reviewId}/reply`, cookie, csrf, { reply: "Thanks!" });
    const res = await deleteReq(`/api/reviews/${reviewId}/reply`, cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const row = await prisma.review.findUnique({ where: { id: reviewId } });
    expect(row!.adminReply).toBeNull();
    expect(row!.repliedAt).toBeNull();
    expect(row!.repliedByAdminId).toBeNull();
    expect(row!.status).toBe("PENDING_REPLY");
    const audit = await prisma.auditLog.findFirst({ where: { action: "review_reply_delete", targetId: reviewId } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("5-star");
    expect(audit!.details).toContain("Test Product");
  });

  it("returns 404 for a review with no reply set", async () => {
    const { reviewId } = await makeReview();
    const res = await deleteReq(`/api/reviews/${reviewId}/reply`, cookie, csrf);
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a review that doesn't exist", async () => {
    const res = await deleteReq(`/api/reviews/999999/reply`, cookie, csrf);
    expect(res.statusCode).toBe(404);
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const { reviewId } = await makeReview();
    await postJson(`/api/reviews/${reviewId}/reply`, cookie, csrf, { reply: "Thanks!" });
    const res = await deleteReq(`/api/reviews/${reviewId}/reply`, null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.adminReply).toBe("Thanks!");
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const { reviewId } = await makeReview();
    await postJson(`/api/reviews/${reviewId}/reply`, cookie, csrf, { reply: "Thanks!" });
    const res = await deleteReq(`/api/reviews/${reviewId}/reply`, cookie, "bad");
    expect(res.statusCode).toBe(403);
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.adminReply).toBe("Thanks!");
  });
});

describe("POST /api/reviews/:reviewId/status", () => {
  it("happy path: sets status to CLOSED and audits", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/status`, cookie, csrf, { status: "CLOSED" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.status).toBe("CLOSED");
    const audit = await prisma.auditLog.findFirst({ where: { action: "review_status_change", targetId: reviewId } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("5-star");
    expect(audit!.details).toContain("Test Product");
  });

  it("sets status back to PENDING_REPLY and audits", async () => {
    const { reviewId } = await makeReview();
    await postJson(`/api/reviews/${reviewId}/status`, cookie, csrf, { status: "CLOSED" });
    const res = await postJson(`/api/reviews/${reviewId}/status`, cookie, csrf, { status: "PENDING_REPLY" });
    expect(res.statusCode).toBe(200);
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.status).toBe("PENDING_REPLY");
  });

  it("rejects REPLIED (and any other invalid value) with 400", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/status`, cookie, csrf, { status: "REPLIED" });
    expect(res.statusCode).toBe(400);
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.status).toBe("PENDING_REPLY");

    const res2 = await postJson(`/api/reviews/${reviewId}/status`, cookie, csrf, { status: "BOGUS" });
    expect(res2.statusCode).toBe(400);
  });

  it("returns 404 for a review that doesn't exist", async () => {
    const res = await postJson(`/api/reviews/999999/status`, cookie, csrf, { status: "CLOSED" });
    expect(res.statusCode).toBe(404);
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/status`, null, csrf, { status: "CLOSED" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.status).toBe("PENDING_REPLY");
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/status`, cookie, "bad", { status: "CLOSED" });
    expect(res.statusCode).toBe(403);
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.status).toBe("PENDING_REPLY");
  });
});

describe("DELETE /api/reviews/:reviewId", () => {
  it("happy path: hard-deletes the review and audits", async () => {
    const { reviewId } = await makeReview();
    const res = await deleteReq(`/api/reviews/${reviewId}`, cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await prisma.review.findUnique({ where: { id: reviewId } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "review_delete", targetId: reviewId } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("5-star");
    expect(audit!.details).toContain("Test Product");
  });

  it("returns 404 for a review that doesn't exist", async () => {
    const res = await deleteReq(`/api/reviews/999999`, cookie, csrf);
    expect(res.statusCode).toBe(404);
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const { reviewId } = await makeReview();
    const res = await deleteReq(`/api/reviews/${reviewId}`, null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect(await prisma.review.findUnique({ where: { id: reviewId } })).toBeTruthy();
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const { reviewId } = await makeReview();
    const res = await deleteReq(`/api/reviews/${reviewId}`, cookie, "bad");
    expect(res.statusCode).toBe(403);
    expect(await prisma.review.findUnique({ where: { id: reviewId } })).toBeTruthy();
  });
});

describe("GET /api/reviews/kpis", () => {
  it("happy path: returns global KPI figures", async () => {
    const { reviewId } = await makeReview();
    await prisma.review.update({ where: { id: reviewId }, data: { sentiment: "NEGATIVE" } });
    await makeReview(true); // hidden — excluded from most figures, counted in hiddenCount

    const res = await app.inject({ method: "GET", url: "/api/reviews/kpis", cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalReviews).toBe(1);
    expect(body.avgRating).toBe(5);
    expect(body.pendingReplyCount).toBe(1);
    expect(body.negativeCount).toBe(1);
    expect(body.hiddenCount).toBe(1);
    expect(body.ratingDistribution["5"]).toBe(1);
  });
});

describe("GET /api/reviews filters", () => {
  it("filters by status, sentiment, rating, and search", async () => {
    const { reviewId: repliedId } = await makeReview();
    await postJson(`/api/reviews/${repliedId}/reply`, cookie, csrf, { reply: "Thanks!" });
    const { reviewId: pendingId } = await makeReview();
    await prisma.review.update({ where: { id: pendingId }, data: { sentiment: "NEGATIVE", comment: "unique-marker-comment" } });

    const byStatus = await app.inject({ method: "GET", url: "/api/reviews?status=REPLIED", cookies: { [COOKIE]: cookie } });
    const byStatusIds = (byStatus.json().reviews as { id: number }[]).map((r) => r.id);
    expect(byStatusIds).toEqual([repliedId]);

    const bySentiment = await app.inject({ method: "GET", url: "/api/reviews?sentiment=NEGATIVE", cookies: { [COOKIE]: cookie } });
    const bySentimentIds = (bySentiment.json().reviews as { id: number }[]).map((r) => r.id);
    expect(bySentimentIds).toEqual([pendingId]);

    const byRating = await app.inject({ method: "GET", url: "/api/reviews?rating=5", cookies: { [COOKIE]: cookie } });
    expect(byRating.json().total).toBe(2);

    const bySearch = await app.inject({ method: "GET", url: "/api/reviews?q=unique-marker-comment", cookies: { [COOKIE]: cookie } });
    const bySearchIds = (bySearch.json().reviews as { id: number }[]).map((r) => r.id);
    expect(bySearchIds).toEqual([pendingId]);
  });
});
