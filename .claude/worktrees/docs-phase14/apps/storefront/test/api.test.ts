// Storefront JSON API (/api/v1) tests — drives the Fastify app with
// app.inject() against an isolated temp DB (pattern: storefront.test.ts).
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
  getOrderByCode,
} from "@app/db";
import { buildApp } from "../src/server";

async function seedProduct(
  categoryId: number,
  name: string,
  denoms: Array<{ name: string; price: string; duration?: string }>,
) {
  const product = await createCatalogProduct(prisma, { categoryId, name });
  const members = [];
  for (const d of denoms) {
    members.push(
      await createDenomination(prisma, {
        productId: product.id,
        name: d.name,
        type: "SHARED",
        durationLabel: d.duration ?? "1 Month",
        price: d.price,
      }),
    );
  }
  return { product, members };
}

let app: FastifyInstance;
let categoryId: number;
let categorySlug: string;
let productSlug: string;
let denomId: number;
let emptyProductSlug: string;

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Streaming", slug: "streaming", emoji: "🎬", sortOrder: 1 },
  });
  categoryId = cat.id;
  categorySlug = cat.slug;

  const { product, members } = await seedProduct(cat.id, "Netflix Premium", [
    { name: "1 Month", price: "40000", duration: "1 Month" },
  ]);
  productSlug = product.slug;
  denomId = members[0]!.id;
  await prisma.stockItem.createMany({
    data: Array.from({ length: 5 }, () => ({
      productId: denomId,
      credentials: "user@mail.com:pass",
      status: "AVAILABLE",
    })),
  });

  // A product with zero active denominations (the "empty" 404 case).
  const emptyParent = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Spotify Family" });
  emptyProductSlug = emptyParent.slug;

  await setSetting(prisma, "setup_completed", "true");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

async function loginAs(identifier: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/login", payload: { identifier, password } });
  const c = res.headers["set-cookie"];
  const cookie = Array.isArray(c) ? c.join("; ") : String(c);
  const page = await app.inject({ method: "GET", url: "/account/settings", headers: { cookie } });
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(page.body)![1]!;
  return { cookie, csrf };
}

describe("GET /api/v1/categories", () => {
  it("returns active categories", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/categories" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.categories)).toBe(true);
    const found = body.categories.find((c: { slug: string }) => c.slug === categorySlug);
    expect(found).toMatchObject({
      slug: categorySlug,
      name: "Streaming",
      emoji: "🎬",
      description: null,
      image: null,
    });
    expect(typeof found.id).toBe("number");
  });
});

describe("GET /api/v1/categories/:slug/products", () => {
  it("returns products in the category", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/categories/${categorySlug}/products` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const found = body.products.find((p: { slug: string }) => p.slug === productSlug);
    expect(found).toBeDefined();
    expect(found.name).toBe("Netflix Premium");
    expect(found.category.slug).toBe(categorySlug);
    expect(found.denominations).toHaveLength(1);
    expect(found.denominations[0]).toMatchObject({
      id: denomId,
      name: "1 Month",
      price: "40000",
      stock: 5,
      status: "in_stock",
    });
  });

  it("404s an unknown category slug", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/categories/no-such-category/products" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("404s an inactive category", async () => {
    const inactive = await prisma.category.create({
      data: { name: "Inactive", slug: "inactive-cat", isActive: false },
    });
    const res = await app.inject({ method: "GET", url: `/api/v1/categories/${inactive.slug}/products` });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/v1/products", () => {
  it("returns the full active catalog", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/products" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.products.some((p: { slug: string }) => p.slug === productSlug)).toBe(true);
    // The empty product (zero active denominations) must not appear.
    expect(body.products.some((p: { slug: string }) => p.slug === emptyProductSlug)).toBe(false);
  });
});

describe("GET /api/v1/products/:slug", () => {
  it("returns the product with its denominations", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/products/${productSlug}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.product.slug).toBe(productSlug);
    expect(body.product.image).toBeTruthy(); // category-fallback image, never null here
    expect(body.product.denominations).toHaveLength(1);
  });

  it("404s an unknown product slug", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/products/no-such-product" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("404s a product with zero active denominations", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/products/${emptyProductSlug}` });
    expect(res.statusCode).toBe(404);
  });

  it("404s an inactive product", async () => {
    await prisma.product.update({ where: { slug: productSlug }, data: { isActive: false } });
    const res = await app.inject({ method: "GET", url: `/api/v1/products/${productSlug}` });
    expect(res.statusCode).toBe(404);
    await prisma.product.update({ where: { slug: productSlug }, data: { isActive: true } });
  });
});

describe("GET /api/v1/products/:slug/denominations", () => {
  it("returns just the denominations array", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/products/${productSlug}/denominations` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.denominations)).toBe(true);
    expect(body.denominations[0]).toMatchObject({ id: denomId, name: "1 Month", price: "40000" });
    expect(body.product).toBeUndefined();
  });

  it("404s an unknown product slug", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/products/no-such-product/denominations" });
    expect(res.statusCode).toBe(404);
  });

  it("404s a product with zero active denominations", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/products/${emptyProductSlug}/denominations` });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/v1/cart", () => {
  it("adds to the guest cart with no auth and no CSRF", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      payload: { denomination_id: denomId, qty: 2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ denomination_id: denomId, qty: 2 });
    expect(body.subtotal).toBe("80000");
  });

  it("clamps qty to [1,99] and defaults missing qty to 1", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      payload: { denomination_id: denomId, qty: 500 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items[0].qty).toBeLessThanOrEqual(99);
  });

  it("400s an invalid denomination_id", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/cart", payload: { denomination_id: -1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
  });

  it("400s a denomination_id naming an inactive denomination", async () => {
    await prisma.denomination.update({ where: { id: denomId }, data: { isActive: false } });
    const res = await app.inject({ method: "POST", url: "/api/v1/cart", payload: { denomination_id: denomId } });
    expect(res.statusCode).toBe(400);
    await prisma.denomination.update({ where: { id: denomId }, data: { isActive: true } });
  });

  describe("signed-in customer", () => {
    let cookie: string;
    let csrf: string;
    beforeAll(async () => {
      const { hashPassword } = await import("@app/core/password");
      await prisma.user.create({
        data: {
          loginUsername: "apicartuser",
          email: "apicart@u.test",
          passwordHash: hashPassword("apicart-pw-99"),
          referralCode: "APICART",
        },
      });
      const session = await loginAs("apicartuser", "apicart-pw-99");
      cookie = session.cookie;
      csrf = session.csrf;
    });

    it("403s when X-CSRF-Token is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/cart",
        headers: { cookie },
        payload: { denomination_id: denomId, qty: 1 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "csrf_failed" });
    });

    it("403s when X-CSRF-Token is wrong", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/cart",
        headers: { cookie, "x-csrf-token": "wrong-token" },
        payload: { denomination_id: denomId, qty: 1 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "csrf_failed" });
    });

    it("200s and updates the cart when X-CSRF-Token is correct", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/cart",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { denomination_id: denomId, qty: 3 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items[0]).toMatchObject({ denomination_id: denomId, qty: 3 });
      expect(body.subtotal).toBe("120000");
    });
  });
});

describe("POST /api/v1/checkout", () => {
  it("401s when logged out", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/checkout", payload: { method: "qris" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  describe("signed-in customer", () => {
    let buyerId: number;
    let cookie: string;
    let csrf: string;

    beforeAll(async () => {
      const { hashPassword } = await import("@app/core/password");
      const u = await prisma.user.create({
        data: {
          loginUsername: "apicheckoutuser",
          email: "apicheckout@u.test",
          passwordHash: hashPassword("apicheckout-pw-99"),
          referralCode: "APICHKT",
        },
      });
      buyerId = u.id;
      const session = await loginAs("apicheckoutuser", "apicheckout-pw-99");
      cookie = session.cookie;
      csrf = session.csrf;
      const { addToCart } = await import("@app/db");
      await addToCart(prisma, buyerId, denomId, 1);
    });

    it("403s when X-CSRF-Token is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie },
        payload: { method: "qris" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "csrf_failed" });
    });

    it("403s when X-CSRF-Token is wrong", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie, "x-csrf-token": "wrong" },
        payload: { method: "qris" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "csrf_failed" });
    });

    it("400s an unavailable payment method (no tokopay creds configured)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { method: "qris" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "web.pay_method_unavailable" });
    });

    it("creates an order on success (bybit) and returns order_code + pay_url", async () => {
      await setSetting(prisma, "bybit_deposit_address", "0xDEADBEEF00000000000000000000000000000000");
      await setSetting(prisma, "bybit_api_key", "k");
      await setSetting(prisma, "bybit_api_secret", "s");
      await setSetting(prisma, "usd_idr_rate", "16000");
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/checkout",
          headers: { cookie, "x-csrf-token": csrf },
          payload: { method: "bybit" },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(typeof body.order_code).toBe("string");
        expect(body.pay_url).toBe(`/checkout/${body.order_code}/pay`);

        const order = await getOrderByCode(prisma, body.order_code);
        expect(order).not.toBeNull();
        expect(order!.userId).toBe(buyerId);
        expect(order!.paymentMethod).toBe("BYBIT");
      } finally {
        await deleteSetting(prisma, "bybit_deposit_address");
        await deleteSetting(prisma, "bybit_api_key");
        await deleteSetting(prisma, "bybit_api_secret");
        await deleteSetting(prisma, "usd_idr_rate");
      }
    });
  });
});
