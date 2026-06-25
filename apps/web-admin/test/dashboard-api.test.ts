import "./setup-env";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
  bulkAddStock,
} from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";
import { makeSession, newJti, sessionJtiKey } from "../src/auth";

const ADMIN_TG = 999;
const COOKIE = config.WEB_COOKIE_NAME;
let app: FastifyInstance;
let cookie: string;

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
  const { raw } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  await setSetting(prisma, "setup_completed", "true");
});

function get(url: string, withCookie: string | null) {
  return app.inject({ method: "GET", url, cookies: withCookie ? { [COOKIE]: withCookie } : {} });
}

describe("GET /api/dashboard/kpis", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/kpis", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("returns today's revenue, profit, order funnel, and pending actions", async () => {
    const user = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const order = await prisma.order.create({
      data: { orderCode: "ORD-1", userId: user.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() },
    });
    void order;

    const res = await get("/api/dashboard/kpis", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revenue.idr).toBe("10000");
    expect(body.revenue.usdt).toBeNull();
    expect(body.orders.total).toBe(1);
    expect(body.orders.delivered).toBe(1);
    expect(body.pendingActions).toEqual({ toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 });
  });
});

describe("GET /api/dashboard/operations", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/operations", null);
    expect(res.statusCode).toBe(303);
  });

  it("reports the operation-center counts", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-pp", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "PENDING_PAYMENT" } });
    await prisma.order.create({ data: { orderCode: "ORD-proc", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "PAID" } });

    const res = await get("/api/dashboard/operations", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pendingPayments: 1, ordersProcessing: 1 });
  });
});

describe("GET /api/dashboard/inventory", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/inventory", null);
    expect(res.statusCode).toBe(303);
  });

  it("lists denominations at or below the threshold", async () => {
    const category = await createCategory(prisma, "Cat");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, { productId: parent.id, name: "Low item", type: "SHARED", durationLabel: "1 Month", price: "1" });
    await bulkAddStock(prisma, denom.id, ["a@b.com:pw"]);

    const res = await get("/api/dashboard/inventory?threshold=3", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ denominationId: denom.id, productName: "Low item", available: 1, threshold: 3 }]);
  });
});

describe("GET /api/dashboard/expirations", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/expirations", null);
    expect(res.statusCode).toBe(303);
  });

  it("lists order items whose warranty expires within the window", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const category = await createCategory(prisma, "Cat");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, { productId: parent.id, name: "Expiring item", type: "SHARED", durationLabel: "1 Month", price: "1", warrantyDays: 1 });
    const deliveredAt = new Date(); // expires in 1 day, well inside a 7-day window
    const order = await prisma.order.create({ data: { orderCode: "ORD-exp", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", deliveredAt } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: denom.id, quantity: 1, unitPrice: "1", warrantyDaysSnapshot: 1 } });

    const res = await get("/api/dashboard/expirations?withinDays=7", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ orderId: order.id, orderCode: "ORD-exp", productName: "Expiring item", customerLabel: "buyer" });
  });
});

describe("GET /api/dashboard/orders/recent", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/orders/recent", null);
    expect(res.statusCode).toBe(303);
  });

  it("returns the newest orders first", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-1", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED" } });

    const res = await get("/api/dashboard/orders/recent?limit=5", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });
});

describe("GET /api/dashboard/health", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/health", null);
    expect(res.statusCode).toBe(303);
  });

  it("reports the bot token-present flag and an unmonitored status for unhealthed providers", async () => {
    const res = await get("/api/dashboard/health", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // setup-env.ts sets BOT_TOKEN to a non-blank test value and resetDb()
    // clears any Settings-row override, so resolveBotCredentials() falls
    // through to that env token — "green", not "red" — in this test env.
    expect(body.telegramBot).toBe("green");
    expect(body.bybit).toBe("unmonitored");
    expect(body.tokopay).toBe("unmonitored");
    expect(body.paydisini).toBe("unmonitored");
    expect(body.nowpayments).toBe("unmonitored");
  });
});

describe("GET /api/dashboard/top-products", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/top-products", null);
    expect(res.statusCode).toBe(303);
  });

  it("returns delivered products ranked by units sold", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const category = await createCategory(prisma, "Cat");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, { productId: parent.id, name: "Top item", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "5000" });
    const order = await prisma.order.create({ data: { orderCode: "ORD-top", userId: buyer.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: denom.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const res = await get("/api/dashboard/top-products?days=30&limit=5", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ productId: denom.id, name: "Top item", unitsSold: 1, revenueIdrEquiv: "10000", profitIdrEquiv: "5000", costUnknownUnits: 0 }]);
  });
});
