// Storefront JSON API (/api/v1) tests — drives the Fastify app with
// app.inject() against an isolated temp DB (pattern: storefront.test.ts).
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  setSetting,
  deleteSetting,
  createCatalogProduct,
  createDenomination,
  updateDenomination,
  getOrderByCode,
} from "@app/db";
import { DeliveryType } from "@app/core/enums";
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

// Auth cutover (docs/REACT_STOREFRONT_MIGRATION.md Phase 5): the HTML POST
// /login form is gone — sign in via the JSON twin (same Set-Cookie either
// way). /account/settings itself fell to the SPA shell on the Phase 7
// (Cluster D) cutover, so the CSRF token is now scraped from the shell's
// <meta name="csrf-token"> via an arbitrary unmapped path — same pattern as
// spa-api.test.ts's loginAs().
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

// Design decision (Task 6 brief): a non-auto cart is single-SKU-only — the
// storefront enforces a stricter rule than "auto vs manual" alone, because
// Order.customerData assumes one denomination's field spec applies to the
// whole order (the bot only ever orders one denomination at a time). A cart
// with any manual/manual_with_info line may hold ONLY that one line (any
// qty); adding a second, different line — auto or not — is rejected.
describe("POST /api/v1/cart — cart guard (single-SKU-per-non-auto-cart)", () => {
  let manualDenomId: number;
  let manualDenomId2: number;

  beforeAll(async () => {
    const { members } = await seedProduct(categoryId, "Manual Product", [{ name: "Manual Denom", price: "10000" }]);
    manualDenomId = members[0]!.id;
    await updateDenomination(prisma, manualDenomId, { deliveryType: DeliveryType.MANUAL });

    const { members: members2 } = await seedProduct(categoryId, "Manual Product 2", [{ name: "Manual Denom 2", price: "20000" }]);
    manualDenomId2 = members2[0]!.id;
    await updateDenomination(prisma, manualDenomId2, { deliveryType: DeliveryType.MANUAL_WITH_INFO });
  });

  it("guest: adding a manual line to a cart that already has an auto line is rejected", async () => {
    const add = await app.inject({ method: "POST", url: "/api/v1/cart", payload: { denomination_id: denomId, qty: 1 } });
    const cookie = (Array.isArray(add.headers["set-cookie"]) ? add.headers["set-cookie"] : [String(add.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie },
      payload: { denomination_id: manualDenomId, qty: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.cart_mixed_delivery" });
  });

  it("guest: adding an auto line to a cart that already has a manual line is rejected", async () => {
    const add = await app.inject({ method: "POST", url: "/api/v1/cart", payload: { denomination_id: manualDenomId, qty: 1 } });
    const cookie = (Array.isArray(add.headers["set-cookie"]) ? add.headers["set-cookie"] : [String(add.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie },
      payload: { denomination_id: denomId, qty: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.cart_mixed_delivery" });
  });

  it("guest: adding a second, different manual/manual_with_info line is rejected", async () => {
    const add = await app.inject({ method: "POST", url: "/api/v1/cart", payload: { denomination_id: manualDenomId, qty: 1 } });
    const cookie = (Array.isArray(add.headers["set-cookie"]) ? add.headers["set-cookie"] : [String(add.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie },
      payload: { denomination_id: manualDenomId2, qty: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.cart_mixed_delivery" });
  });

  it("guest: re-adding the SAME manual denomination increments qty normally (not rejected)", async () => {
    const add = await app.inject({ method: "POST", url: "/api/v1/cart", payload: { denomination_id: manualDenomId, qty: 1 } });
    const cookie = (Array.isArray(add.headers["set-cookie"]) ? add.headers["set-cookie"] : [String(add.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie },
      payload: { denomination_id: manualDenomId, qty: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0]).toMatchObject({ denomination_id: manualDenomId, qty: 3 });
  });

  it("an auto-only cart stays unrestricted (multiple different auto lines allowed)", async () => {
    const { members } = await seedProduct(categoryId, "Second Auto Product", [{ name: "Auto Denom 2", price: "15000" }]);
    const secondAutoId = members[0]!.id;
    const add = await app.inject({ method: "POST", url: "/api/v1/cart", payload: { denomination_id: denomId, qty: 1 } });
    const cookie = (Array.isArray(add.headers["set-cookie"]) ? add.headers["set-cookie"] : [String(add.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie },
      payload: { denomination_id: secondAutoId, qty: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
  });

  it("signed-in customer: same guard applies (mixed delivery rejected)", async () => {
    const { hashPassword } = await import("@app/core/password");
    await prisma.user.create({
      data: {
        loginUsername: "cartguarduser",
        email: "cartguard@u.test",
        passwordHash: hashPassword("cartguard-pw-99"),
        referralCode: "CARTGRD",
      },
    });
    const session = await loginAs("cartguarduser", "cartguard-pw-99");
    const add = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
      payload: { denomination_id: manualDenomId, qty: 1 },
    });
    expect(add.statusCode).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
      payload: { denomination_id: denomId, qty: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.cart_mixed_delivery" });
  });
});

// Final-review N1 fix: a Digiflazz-routed denomination (autoDeliverySource
// "digiflazz") may only ever be added/held at quantity 1 — the supplier
// dispatch poller (packages/db/src/crud/digiflazz.ts) places exactly one
// top-up per order and marks the whole order DELIVERED, so a qty>1 line for
// one would leave the buyer paid for N and delivered 1.
describe("POST /api/v1/cart — Digiflazz single-unit guard", () => {
  let digiflazzDenomId: number;
  let manualWithInfoDenomId: number;

  beforeAll(async () => {
    const { members } = await seedProduct(categoryId, "Digiflazz Game", [{ name: "100 Diamonds", price: "16500" }]);
    digiflazzDenomId = members[0]!.id;
    await updateDenomination(prisma, digiflazzDenomId, {
      autoDeliverySource: "digiflazz",
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      supplierSku: "ml100",
    });

    // A non-Digiflazz manual_with_info denomination — same delivery type,
    // no autoDeliverySource — to prove the new guard is keyed on
    // autoDeliverySource specifically, not deliveryType.
    const { members: members2 } = await seedProduct(categoryId, "Ordinary Manual Game", [
      { name: "Info Denom", price: "12000" },
    ]);
    manualWithInfoDenomId = members2[0]!.id;
    await updateDenomination(prisma, manualWithInfoDenomId, { deliveryType: DeliveryType.MANUAL_WITH_INFO });
  });

  it("rejects qty=2 for a Digiflazz-routed denomination", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      payload: { denomination_id: digiflazzDenomId, qty: 2 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.digiflazz_single_unit_only" });
  });

  it("accepts qty=1 for the same Digiflazz-routed denomination", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      payload: { denomination_id: digiflazzDenomId, qty: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ denomination_id: digiflazzDenomId, qty: 1 });
  });

  it("leaves qty=2 for a non-Digiflazz manual_with_info denomination unaffected", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      payload: { denomination_id: manualWithInfoDenomId, qty: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ denomination_id: manualWithInfoDenomId, qty: 2 });
  });

  it("leaves qty=2 for a plain auto denomination unaffected", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      payload: { denomination_id: denomId, qty: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ denomination_id: denomId, qty: 2 });
  });

  // addToCart (signed-in) / the guest merge branch both INCREMENT an
  // existing line rather than setting it absolutely — re-POSTing qty:1 for a
  // Digiflazz denomination that's ALREADY in the cart would otherwise land at
  // qty:2 even though this one request looks like "qty 1" in isolation.
  it("rejects re-adding a Digiflazz-routed denomination that's already in the cart, even at qty=1", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      payload: { denomination_id: digiflazzDenomId, qty: 1 },
    });
    expect(first.statusCode).toBe(200);
    const cookie = (Array.isArray(first.headers["set-cookie"]) ? first.headers["set-cookie"] : [String(first.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie },
      payload: { denomination_id: digiflazzDenomId, qty: 1 },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toEqual({ error: "error.digiflazz_single_unit_only" });

    const check = await app.inject({ method: "GET", url: "/api/v1/cart", headers: { cookie } });
    expect(check.json().items[0]).toMatchObject({ denomination_id: digiflazzDenomId, qty: 1 });
  });

  it("signed-in: rejects re-adding a Digiflazz-routed denomination that's already in the cart, even at qty=1", async () => {
    const { hashPassword } = await import("@app/core/password");
    await prisma.user.create({
      data: {
        loginUsername: "digiflazzreadduser",
        email: "digiflazzreadd@u.test",
        passwordHash: hashPassword("digiflazzreadd-pw-99"),
        referralCode: "DFREADD",
      },
    });
    const session = await loginAs("digiflazzreadduser", "digiflazzreadd-pw-99");
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
      payload: { denomination_id: digiflazzDenomId, qty: 1 },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
      payload: { denomination_id: digiflazzDenomId, qty: 1 },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toEqual({ error: "error.digiflazz_single_unit_only" });
  });
});

// Trustance Phase 1 Task 3 — `cart_kind` at the route boundary.
//
// The suite above ("cart guard (single-SKU-per-non-auto-cart)") is the
// characterization half: it passes UNCHANGED, which is the evidence that
// naming the rule did not alter it. This suite covers the two things naming it
// added.
describe("POST /api/v1/cart — cart_kind (TOPUP vs PREMIUM)", () => {
  let topupDenomId: number;
  let autoTypedTopupId: number;

  beforeAll(async () => {
    // A top-up EXACTLY as packages/db/src/crud/digiflazz.ts creates one.
    const { members } = await seedProduct(categoryId, "Kind Topup Game", [{ name: "86 Diamonds", price: "20000" }]);
    topupDenomId = members[0]!.id;
    await updateDenomination(prisma, topupDenomId, {
      autoDeliverySource: "digiflazz",
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      supplierSku: "kind86",
    });

    // A shape the catalog sync NEVER produces: Digiflazz-routed but hand-edited
    // to auto delivery. This is the only input that reaches the kind rule,
    // because every real top-up is non-AUTO and the pre-existing homogeneity
    // rule catches those first.
    const { members: members2 } = await seedProduct(categoryId, "Kind Misconfigured Game", [
      { name: "Misconfigured", price: "21000" },
    ]);
    autoTypedTopupId = members2[0]!.id;
    await updateDenomination(prisma, autoTypedTopupId, {
      autoDeliverySource: "digiflazz",
      deliveryType: DeliveryType.AUTO,
      supplierSku: "kindauto",
    });
  });

  const cookieOf = (res: { headers: Record<string, unknown> }): string =>
    (Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"] : [String(res.headers["set-cookie"])])
      .map((c) => String(c).split(";")[0])
      .join("; ");

  // THE no-op proof at the route level: a real top-up mixing with a premium
  // line is still refused under the OLD error key. A buyer sees exactly the
  // message they saw before this task.
  it("a real top-up joining a premium cart is still rejected as error.cart_mixed_delivery", async () => {
    const add = await app.inject({ method: "POST", url: "/api/v1/cart", payload: { denomination_id: denomId, qty: 1 } });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie: cookieOf(add) },
      payload: { denomination_id: topupDenomId, qty: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.cart_mixed_delivery" });
  });

  it("a premium line joining a real top-up cart is still rejected as error.cart_mixed_delivery", async () => {
    const add = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      payload: { denomination_id: topupDenomId, qty: 1 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie: cookieOf(add) },
      payload: { denomination_id: denomId, qty: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.cart_mixed_delivery" });
  });

  // The single intentional behavior delta in Task 3. Before it, this add
  // SUCCEEDED — and the resulting order would have been settled by
  // dispatchPendingDigiflazzOrders, which places one supplier top-up and then
  // marks the WHOLE order DELIVERED, so the buyer paid for two lines and
  // received one.
  it("an admin-misconfigured AUTO-typed top-up is refused with error.cart_kind_conflict", async () => {
    const add = await app.inject({ method: "POST", url: "/api/v1/cart", payload: { denomination_id: denomId, qty: 1 } });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      headers: { cookie: cookieOf(add) },
      payload: { denomination_id: autoTypedTopupId, qty: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.cart_kind_conflict" });
  });

  it("an AUTO-typed top-up is still allowed to be the cart's only line", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      payload: { denomination_id: autoTypedTopupId, qty: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ denomination_id: autoTypedTopupId, qty: 1 });
  });
});

describe("POST /api/v1/checkout", () => {
  // Guest checkout (Task 4) replaced the blanket 401 with a validated guest
  // branch: no session is required, but a contact email is, and it is checked
  // before any user row is written. The full guest contract lives in
  // guest-checkout-api.test.ts; this just pins that the gate moved rather
  // than disappeared.
  it("400s (not 401) when logged out without a guest email", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/checkout", payload: { method: "qris" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "web.guest_email_invalid" });
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
      await setSetting(prisma, "bybit_uid", "123456789");
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
        await deleteSetting(prisma, "bybit_uid");
        await deleteSetting(prisma, "bybit_api_key");
        await deleteSetting(prisma, "bybit_api_secret");
        await deleteSetting(prisma, "usd_idr_rate");
      }
    });
  });

  // Task 1: Idempotency-Key protects the order-creating mutation from a
  // double-tapped "Pay" button or a network retry. Own buyer + own cart
  // reset per test so these are independent of execution order and of the
  // "signed-in customer" block above.
  describe("Idempotency-Key (Task 1)", () => {
    let buyerId: number;
    let cookie: string;
    let csrf: string;

    beforeAll(async () => {
      const { hashPassword } = await import("@app/core/password");
      const u = await prisma.user.create({
        data: {
          loginUsername: "idempotencyuser",
          email: "idempotency@u.test",
          passwordHash: hashPassword("idempotency-pw-99"),
          referralCode: "IDEMPKT",
          walletBalance: "1000000",
        },
      });
      buyerId = u.id;
      const session = await loginAs("idempotencyuser", "idempotency-pw-99");
      cookie = session.cookie;
      csrf = session.csrf;
    });

    beforeEach(async () => {
      const { addToCart } = await import("@app/db");
      await prisma.cartItem.deleteMany({ where: { userId: buyerId } });
      await addToCart(prisma, buyerId, denomId, 1);
    });

    it("replays the exact response for a repeated 400 (validation failure) instead of re-running it", async () => {
      const key = "idem-400-repeat";
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie, "x-csrf-token": csrf, "idempotency-key": key },
        payload: { method: "qris" },
      });
      expect(first.statusCode).toBe(400);
      expect(first.json()).toEqual({ error: "web.pay_method_unavailable" });

      const second = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie, "x-csrf-token": csrf, "idempotency-key": key },
        payload: { method: "qris" },
      });
      expect(second.statusCode).toBe(400);
      expect(second.json()).toEqual({ error: "web.pay_method_unavailable" });
    });

    it("409s when the same key is reused with a DIFFERENT request body", async () => {
      const key = "idem-conflict";
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie, "x-csrf-token": csrf, "idempotency-key": key },
        payload: { method: "qris" },
      });
      expect(first.statusCode).toBe(400);

      const second = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie, "x-csrf-token": csrf, "idempotency-key": key },
        payload: { method: "bybit" }, // different method => different request hash
      });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ error: "error.idempotency_key_reused" });
    });

    it("a repeated wallet checkout with the same key creates exactly ONE order and replays the order_code", async () => {
      const key = "idem-wallet-success";
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie, "x-csrf-token": csrf, "idempotency-key": key },
        payload: { method: "wallet_idr" },
      });
      expect(first.statusCode).toBe(201);
      const firstBody = first.json();
      expect(typeof firstBody.order_code).toBe("string");

      const second = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie, "x-csrf-token": csrf, "idempotency-key": key },
        payload: { method: "wallet_idr" },
      });
      expect(second.statusCode).toBe(201);
      expect(second.json()).toEqual(firstBody);

      const orders = await prisma.order.findMany({ where: { userId: buyerId, orderCode: firstBody.order_code } });
      expect(orders).toHaveLength(1);
    });

    it("with no Idempotency-Key header, behaves exactly as before (opt-in feature)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { method: "qris" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "web.pay_method_unavailable" });
    });
  });
});
