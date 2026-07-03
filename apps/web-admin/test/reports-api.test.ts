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

  it("requires auth (anon → 303 /login)", async () => {
    const res = await get("/api/reports", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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

  it("requires auth (anon → 303 /login)", async () => {
    const res = await get("/api/reports/export", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});
