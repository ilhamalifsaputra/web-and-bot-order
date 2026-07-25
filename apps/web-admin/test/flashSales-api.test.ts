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

describe("GET /api/flash-sales/denominations", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/flash-sales/denominations", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("returns a row with no flash object for a SKU with no schedule", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "Plain item",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
    });

    const res = await get("/api/flash-sales/denominations", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.denominations.find((d: { id: number }) => d.id === denom.id);
    expect(row).toMatchObject({ id: denom.id, productId: product.id, name: "Plain item", price: "10000" });
    expect(row.flash).toBeNull();
  });

  it("includes sale price, performance and stock aggregates for a scheduled auto-delivery SKU", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "Flash item",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      deliveryType: "auto",
    });
    await bulkAddStock(prisma, denom.id, ["a@b.com:pw", "c@d.com:pw"]);

    const startsAt = new Date(Date.now() - 60_000);
    const endsAt = new Date(Date.now() + 60 * 60_000);
    await prisma.denomination.update({
      where: { id: denom.id },
      data: { flashDiscountPercent: "10", flashStartsAt: startsAt, flashEndsAt: endsAt },
    });

    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-flash-1",
        userId: buyer.id,
        subtotalAmount: "9000",
        totalAmount: "9000",
        status: "DELIVERED",
        deliveredAt: new Date(),
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: denom.id, quantity: 1, unitPrice: "9000", warrantyDaysSnapshot: 0 },
    });

    const res = await get("/api/flash-sales/denominations", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.denominations.find((d: { id: number }) => d.id === denom.id);
    expect(row.productId).toBe(product.id);
    expect(row.flash).toMatchObject({
      discountPercent: "10",
      status: "live",
      salePrice: "9000",
      sold: 1,
      revenue: "9000",
      orders: 1,
      availableStock: 2,
    });
    expect(row.flash.startsAtDisplay).toEqual(expect.any(String));
    expect(row.flash.endsAtDisplay).toEqual(expect.any(String));
    expect(row.flash.windowDisplay).toBeUndefined();
  });

  it("reports availableStock as null (not 0) for a manual-delivery SKU with a schedule", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "Manual flash item",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      deliveryType: "manual",
    });
    await prisma.denomination.update({
      where: { id: denom.id },
      data: {
        flashDiscountPercent: "10",
        flashStartsAt: new Date(Date.now() - 60_000),
        flashEndsAt: new Date(Date.now() + 60_000),
      },
    });

    const res = await get("/api/flash-sales/denominations", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.denominations.find((d: { id: number }) => d.id === denom.id);
    expect(row.flash.availableStock).toBeNull();
  });

  // Regression test: flashPrice() (checkout's shared pricing function) is
  // time-gated and returns null outside [flashStartsAt, flashEndsAt) — i.e.
  // for exactly the "scheduled" and "ended" statuses computed a line above
  // it in the handler. Calling it here must not 500 the whole response for
  // these two entirely normal, unvalidated-against admin states.
  it("computes salePrice as plain percent-off (not null, not a 500) for a scheduled (future) row", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "Future flash item",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
    });
    await prisma.denomination.update({
      where: { id: denom.id },
      data: {
        flashDiscountPercent: "10",
        flashStartsAt: new Date(Date.now() + 60 * 60_000),
        flashEndsAt: new Date(Date.now() + 2 * 60 * 60_000),
      },
    });

    const res = await get("/api/flash-sales/denominations", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.denominations.find((d: { id: number }) => d.id === denom.id);
    expect(row.flash.status).toBe("scheduled");
    expect(row.flash.salePrice).toBe("9000");
  });

  it("computes salePrice as plain percent-off (not null, not a 500) for an ended (past) row", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "Past flash item",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "20000",
    });
    await prisma.denomination.update({
      where: { id: denom.id },
      data: {
        flashDiscountPercent: "25",
        flashStartsAt: new Date(Date.now() - 2 * 60 * 60_000),
        flashEndsAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    const res = await get("/api/flash-sales/denominations", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.denominations.find((d: { id: number }) => d.id === denom.id);
    expect(row.flash.status).toBe("ended");
    expect(row.flash.salePrice).toBe("15000");
  });
});
