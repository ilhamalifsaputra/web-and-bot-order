// Per-channel service availability on the storefront: a service switched off
// for the WEBSITE (`service_game_topup_enabled_web=false`) disappears from the
// site and cannot be bought, while the same service switched off only for the
// BOT (`service_game_topup_enabled_bot=false`) must leave the site untouched.
//
// Pattern: api.test.ts / topup-order-api.test.ts — app.inject() against an
// isolated temp DB.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  setSetting,
  deleteSetting,
  createCatalogProduct,
  createDenomination,
  addToCart,
  clearCart,
} from "@app/db";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";

const WEB_KEY = "service_game_topup_enabled_web";
const BOT_KEY = "service_game_topup_enabled_bot";

let app: FastifyInstance;
let categorySlug: string;
let productSlug: string;
let denomId: number;

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

async function loginAs(identifier: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  expect(res.statusCode).toBe(200);
  const c = res.headers["set-cookie"];
  const cookie = Array.isArray(c) ? c.join("; ") : String(c);
  const shell = await app.inject({ method: "GET", url: "/spa-shell-probe", headers: { cookie } });
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(shell.body)![1]!;
  expect(csrf).not.toBe("");
  return { cookie, csrf };
}

async function makeBuyer(username: string, refCode: string): Promise<{ id: number; cookie: string; csrf: string }> {
  const u = await prisma.user.create({
    data: {
      loginUsername: username,
      email: `${username}@u.test`,
      passwordHash: hashPassword(`${username}-pw-1`),
      referralCode: refCode,
    },
  });
  return { id: u.id, ...(await loginAs(username, `${username}-pw-1`)) };
}

/** Run `fn` with one setting switched to "false", always restoring afterwards. */
async function withSetting(key: string, fn: () => Promise<void>): Promise<void> {
  await setSetting(prisma, key, "false");
  try {
    await fn();
  } finally {
    await deleteSetting(prisma, key);
  }
}

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Channel Games", slug: "channel-games", emoji: "🎮", sortOrder: 1, group: "GAME_TOPUP" },
  });
  categorySlug = cat.slug;
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Channel Game Product" });
  productSlug = product.slug;
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "86 Diamonds",
    type: "SHARED",
    durationLabel: "-",
    price: "40000",
  });
  denomId = denom.id;
  await prisma.stockItem.createMany({
    data: Array.from({ length: 10 }, () => ({
      productId: denomId,
      credentials: "user@mail.com:pass",
      status: "AVAILABLE",
    })),
  });

  await setSetting(prisma, "bybit_uid", "123456789");
  await setSetting(prisma, "bybit_api_key", "k");
  await setSetting(prisma, "bybit_api_secret", "s");
  await setSetting(prisma, "usd_idr_rate", "16000");
  await setSetting(prisma, "setup_completed", "true");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

describe("catalog reads follow the website flag only", () => {
  it("hides Game Top-Up when it is disabled for the website", async () => {
    await withSetting(WEB_KEY, async () => {
      const categories = await app.inject({ method: "GET", url: "/api/v1/categories" });
      expect(categories.json().categories.some((c: { slug: string }) => c.slug === categorySlug)).toBe(false);
      const products = await app.inject({ method: "GET", url: "/api/v1/products" });
      expect(products.json().products.some((p: { slug: string }) => p.slug === productSlug)).toBe(false);
      expect((await app.inject({ method: "GET", url: `/api/v1/products/${productSlug}` })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/v1/categories/${categorySlug}/products` })).statusCode).toBe(404);
      const home = await app.inject({ method: "GET", url: "/api/v1/pages/home" });
      expect(JSON.stringify(home.json())).not.toContain(productSlug);
    });
  });

  it("leaves the website catalog untouched when only the bot flag is off", async () => {
    await withSetting(BOT_KEY, async () => {
      const categories = await app.inject({ method: "GET", url: "/api/v1/categories" });
      expect(categories.json().categories.some((c: { slug: string }) => c.slug === categorySlug)).toBe(true);
      const products = await app.inject({ method: "GET", url: "/api/v1/products" });
      expect(products.json().products.some((p: { slug: string }) => p.slug === productSlug)).toBe(true);
      expect((await app.inject({ method: "GET", url: `/api/v1/products/${productSlug}` })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/api/v1/categories/${categorySlug}/products` })).statusCode).toBe(200);
      const home = await app.inject({ method: "GET", url: "/api/v1/pages/home" });
      expect(JSON.stringify(home.json())).toContain(productSlug);
    });
  });
});

describe("cart checkout follows the website flag only", () => {
  it("refuses to create an order for a Game Top-Up cart line when disabled for the website", async () => {
    const buyer = await makeBuyer("chanwebcart", "CHWCRT");
    await addToCart(prisma, buyer.id, denomId, 1);
    try {
      const ordersBefore = await prisma.order.count({ where: { userId: buyer.id } });
      await withSetting(WEB_KEY, async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/checkout",
          headers: { cookie: buyer.cookie, "x-csrf-token": buyer.csrf, "x-forwarded-for": freshIp() },
          payload: { method: "bybit" },
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
      });
      expect(await prisma.order.count({ where: { userId: buyer.id } })).toBe(ordersBefore);
    } finally {
      await clearCart(prisma, buyer.id);
    }
  });

  it("still creates the order when only the bot flag is off", async () => {
    const buyer = await makeBuyer("chanbotcart", "CHBCRT");
    await addToCart(prisma, buyer.id, denomId, 1);
    try {
      await withSetting(BOT_KEY, async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/checkout",
          headers: { cookie: buyer.cookie, "x-csrf-token": buyer.csrf, "x-forwarded-for": freshIp() },
          payload: { method: "bybit" },
        });
        expect(res.statusCode).toBe(201);
        const order = await prisma.order.findFirst({
          where: { orderCode: res.json().order_code },
          include: { items: true },
        });
        expect(order!.userId).toBe(buyer.id);
        expect(order!.items.map((i) => i.productId)).toEqual([denomId]);
      });
    } finally {
      await clearCart(prisma, buyer.id);
    }
  });
});

describe("instant top-up order follows the website flag only", () => {
  it("rejects the order when Game Top-Up is disabled for the website", async () => {
    const buyer = await makeBuyer("chanwebtopup", "CHWTOP");
    const ordersBefore = await prisma.order.count({ where: { userId: buyer.id } });
    await withSetting(WEB_KEY, async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/topup/order",
        headers: { cookie: buyer.cookie, "x-csrf-token": buyer.csrf, "x-forwarded-for": freshIp() },
        payload: { denomination_id: denomId, qty: 1, method: "bybit" },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      const preview = await app.inject({
        method: "POST",
        url: "/api/v1/topup/preview",
        headers: { cookie: buyer.cookie, "x-csrf-token": buyer.csrf, "x-forwarded-for": freshIp() },
        payload: { denomination_id: denomId, qty: 1 },
      });
      expect(preview.statusCode).toBe(400);
      expect(preview.json()).toEqual({ error: "invalid_request" });
    });
    expect(await prisma.order.count({ where: { userId: buyer.id } })).toBe(ordersBefore);
  });

  it("still creates the order when only the bot flag is off", async () => {
    const buyer = await makeBuyer("chanbottopup", "CHBTOP");
    await withSetting(BOT_KEY, async () => {
      const preview = await app.inject({
        method: "POST",
        url: "/api/v1/topup/preview",
        headers: { cookie: buyer.cookie, "x-csrf-token": buyer.csrf, "x-forwarded-for": freshIp() },
        payload: { denomination_id: denomId, qty: 1 },
      });
      expect(preview.statusCode).toBe(200);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/topup/order",
        headers: { cookie: buyer.cookie, "x-csrf-token": buyer.csrf, "x-forwarded-for": freshIp() },
        payload: { denomination_id: denomId, qty: 1, method: "bybit" },
      });
      expect(res.statusCode).toBe(201);
      const order = await prisma.order.findFirst({
        where: { orderCode: res.json().order_code },
        include: { items: true },
      });
      expect(order!.userId).toBe(buyer.id);
      expect(order!.items.map((i) => i.productId)).toEqual([denomId]);
    });
  });
});
