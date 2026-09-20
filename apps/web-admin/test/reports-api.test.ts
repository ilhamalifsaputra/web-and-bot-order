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

function get(url: string, c: string | null) {
  return app.inject({ method: "GET", url, cookies: c ? { [COOKIE]: c } : {} });
}

async function makeDeliveredOrder(): Promise<void> {
  const category = await createCategory(prisma, "Streaming", "🎬");
  const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Netflix Premium 1M" });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Netflix Premium 1M",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "5.00",
  });
  await bulkAddStock(prisma, denom.id, ["acct1@example.com:pwd1"]);
  const user = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
  await createOrderDirect(prisma, { user, productId: denom.id, quantity: 1 });
}

describe("GET /api/reports", () => {
  it("happy path: returns the daily revenue series, totals, and product/voucher summaries", async () => {
    await makeDeliveredOrder();
    const res = await get("/api/reports", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { daily: unknown[]; totalIdr: string; days: number };
    expect(Array.isArray(body.daily)).toBe(true);
    expect(typeof body.totalIdr).toBe("string");
    expect(body.days).toBe(30);
  });

  it("funnel counts product orders only — a wallet top-up is not a sale — and sums every status it has", async () => {
    const user = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const mk = (code: string, status: string, kind = "PRODUCT") =>
      prisma.order.create({
        data: { orderCode: code, userId: user.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status, kind },
      });
    await mk("ORD-F1", "DELIVERED");
    await mk("ORD-F2", "DELIVERED");
    await mk("ORD-F3", "PENDING_PAYMENT");
    await mk("ORD-F4", "PAID");
    await mk("ORD-TOPUP", "DELIVERED", "WALLET_TOPUP");

    const body = (await get("/api/reports", cookie)).json() as { funnel: { status: string; count: number }[] };
    const byStatus = Object.fromEntries(body.funnel.map((f) => [f.status, f.count]));
    expect(byStatus).toEqual({ DELIVERED: 2, PENDING_PAYMENT: 1, PAID: 1 });
  });

  it("top products report revenue net of order discounts, matching the dashboard's Top Products list", async () => {
    const user = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const category = await createCategory(prisma, "Cat");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, { productId: parent.id, name: "Disc item", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "5000" });
    const order = await prisma.order.create({
      data: { orderCode: "ORD-D", userId: user.id, subtotalAmount: "20000", discountAmount: "5000", totalAmount: "15000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() },
    });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: denom.id, quantity: 2, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const reports = (await get("/api/reports", cookie)).json() as { products: { productId: number; revenue: string }[] };
    const dashboard = (await get("/api/dashboard/top-products?days=30", cookie)).json() as { productId: number; revenueIdrEquiv: string }[];
    expect(reports.products).toEqual([expect.objectContaining({ productId: denom.id, revenue: "15000" })]);
    expect(reports.products[0].revenue).toBe(dashboard[0].revenueIdrEquiv);
  });

  it("treats a fractional ?days like its whole part, so the window still starts on a local midnight", async () => {
    const whole = (await get("/api/reports?days=7", cookie)).json() as { daily: { day: string }[]; days: number };
    const fractional = (await get("/api/reports?days=7.5", cookie)).json() as { daily: { day: string }[]; days: number };
    expect(fractional.daily.map((d) => d.day)).toEqual(whole.daily.map((d) => d.day));
    expect(whole.daily).toHaveLength(7);
    // The echoed window size is the normalized one, not the raw 7.5.
    expect(fractional.days).toBe(7);
  });

  it("requires auth (anon → 401)", async () => {
    const res = await get("/api/reports", null);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });
});

describe("GET /api/reports/export", () => {
  it("happy path: returns a CSV with the daily revenue header + Content-Disposition", async () => {
    const res = await get("/api/reports/export", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="reports.csv"');
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toBe("Date,Revenue (IDR),Revenue (USDT),Orders");
    expect(lines.length).toBe(31); // header + 30 days (default window)
  });

  it("respects the days query param", async () => {
    const res = await get("/api/reports/export?days=7", cookie);
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split("\r\n");
    expect(lines.length).toBe(8); // header + 7 days
  });

  it("requires auth (anon → 401)", async () => {
    const res = await get("/api/reports/export", null);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });
});
