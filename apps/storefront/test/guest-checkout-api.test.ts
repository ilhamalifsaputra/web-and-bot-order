// Task 4 (guest checkout): the HTTP auth gate on the JSON checkout routes.
// Task 2 taught checkoutView/computeTotals to price an anonymous cookie cart;
// this file pins the ROUTE-level contract on top of it — GET /api/v1/checkout
// and the voucher preview serve anonymous visitors, POST /api/v1/checkout
// mints a guest `User` + session and creates a real order, and the
// pay/status/cancel routes stay session-locked with an ownership check.
//
// Pattern: spa-api.test.ts — app.inject() against an isolated temp DB.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  setSetting,
  createCatalogProduct,
  createDenomination,
  addToCart,
} from "@app/db";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";
import { CART_COOKIE, CART_COOKIE_VERSION } from "../src/shop";
import { SHOP_COOKIE_NAME } from "../src/auth";
import { GUEST_CHECKOUT_RATE_LIMIT_MAX } from "../src/rateLimit";

let app: FastifyInstance;
let denomId: number;

/** The versioned guest-cart cookie, encoded exactly as writeGuestCart writes it. */
function cartCookie(items: Array<{ p: number; q: number }>): string {
  return `${CART_COOKIE}=` + encodeURIComponent(JSON.stringify({ v: CART_COOKIE_VERSION, items }));
}

/** A distinct simulated client IP per test, so one test's guest-checkout
 * quota can never spill into another's (the limiter is process-wide). */
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

/** Sign in via the JSON endpoint and scrape the session's CSRF token from the
 * SPA shell's <meta>, same wiring as spa-api.test.ts's loginAs. */
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

async function makeUser(username: string, password: string, refCode: string): Promise<number> {
  const u = await prisma.user.create({
    data: {
      loginUsername: username,
      email: `${username}@u.test`,
      passwordHash: hashPassword(password),
      referralCode: refCode,
    },
  });
  return u.id;
}

const countUsers = () => prisma.user.count();

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Guest API Cat", slug: "guest-api-cat", emoji: "🛒", sortOrder: 1 },
  });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Guest API Product" });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "1 Month",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "40000",
  });
  denomId = denom.id;
  // Every completed checkout permanently consumes stock rows (reserved at
  // order creation), and the rate-limit test alone runs GUEST_CHECKOUT_RATE_
  // LIMIT_MAX checkouts — keep the pool comfortably ahead of that.
  await prisma.stockItem.createMany({
    data: Array.from({ length: 40 }, () => ({
      productId: denomId,
      credentials: "user@mail.com:pass",
      status: "AVAILABLE",
    })),
  });
  // Enable one gateway (bybit) so the happy path has a live payment method.
  await setSetting(prisma, "bybit_uid", "123456789");
  await setSetting(prisma, "bybit_api_key", "k");
  await setSetting(prisma, "bybit_api_secret", "s");
  await setSetting(prisma, "usd_idr_rate", "16000");
  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "Guest API Test Shop");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

// --------------------------------------------------------------- reads (4b)
describe("GET /api/v1/checkout — open to anonymous visitors (Task 4b)", () => {
  it("200s for an anonymous visitor with is_guest true and both wallet methods off", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/checkout",
      headers: { cookie: cartCookie([{ p: denomId, q: 1 }]) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.is_guest).toBe(true);
    expect(body.wallet_idr_enabled).toBe(false);
    expect(body.wallet_usdt_enabled).toBe(false);
    expect(body.subtotal).toBe("40000"); // priced from the cookie cart
  });

  it("still 200s for a signed-in buyer with is_guest false (regression)", async () => {
    const uid = await makeUser("guestapireader", "guestapireader-pw-1", "GAPIRD");
    const { cookie } = await loginAs("guestapireader", "guestapireader-pw-1");
    await addToCart(prisma, uid, denomId, 1);

    const res = await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.is_guest).toBe(false);
    expect(body.wallet_idr_enabled).toBe(true);
    expect(body.subtotal).toBe("40000");
  });

  it("voucher preview works anonymously without a CSRF token, but a signed-in caller still needs one", async () => {
    const anon = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/voucher/preview",
      headers: { cookie: cartCookie([{ p: denomId, q: 1 }]) },
      payload: { voucher_code: "NOPE" },
    });
    expect(anon.statusCode).toBe(200);
    expect(anon.json().is_guest).toBe(true);
    expect(anon.json().error_key).toBe("error.voucher_not_found");

    await makeUser("guestapivoucher", "guestapivoucher-pw-1", "GAPIVC");
    const { cookie } = await loginAs("guestapivoucher", "guestapivoucher-pw-1");
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/voucher/preview",
      headers: { cookie, "x-csrf-token": "bad" },
      payload: { voucher_code: "NOPE" },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json()).toEqual({ error: "csrf_failed" });
  });
});

// ------------------------------------------------- POST /checkout guest (4c)
describe("POST /api/v1/checkout — guest branch validation (Task 4c)", () => {
  it("400s with web.guest_email_invalid when guest_email is missing or malformed, creating no user row", async () => {
    const before = await countUsers();
    for (const payload of [
      { method: "bybit" },
      { method: "bybit", guest_email: "" },
      { method: "bybit", guest_email: "   " },
      { method: "bybit", guest_email: "not-an-email" },
      { method: "bybit", guest_email: "no@domain" },
      { method: "bybit", guest_email: `${"a".repeat(250)}@example.com` }, // > 254 chars
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie: cartCookie([{ p: denomId, q: 1 }]), "x-forwarded-for": freshIp() },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "web.guest_email_invalid" });
    }
    expect(await countUsers()).toBe(before);
  });

  it("400s with web.pay_method_unavailable for a wallet method and creates no user row", async () => {
    const before = await countUsers();
    for (const method of ["wallet_idr", "wallet_usdt"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie: cartCookie([{ p: denomId, q: 1 }]), "x-forwarded-for": freshIp() },
        payload: { method, guest_email: "wallet.guest@example.com" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "web.pay_method_unavailable" });
    }
    expect(await countUsers()).toBe(before);
  });

  it("400s with error.cart_empty for an empty guest cart and creates no user row", async () => {
    const before = await countUsers();
    const noCookie = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { "x-forwarded-for": freshIp() },
      payload: { method: "bybit", guest_email: "empty.guest@example.com" },
    });
    expect(noCookie.statusCode).toBe(400);
    expect(noCookie.json()).toEqual({ error: "error.cart_empty" });

    const emptyCookie = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie: cartCookie([]), "x-forwarded-for": freshIp() },
      payload: { method: "bybit", guest_email: "empty.guest@example.com" },
    });
    expect(emptyCookie.statusCode).toBe(400);
    expect(emptyCookie.json()).toEqual({ error: "error.cart_empty" });

    expect(await countUsers()).toBe(before);
  });

  it("429s once one IP exceeds GUEST_CHECKOUT_RATE_LIMIT_MAX guest checkouts", async () => {
    const ip = freshIp();
    for (let i = 0; i < GUEST_CHECKOUT_RATE_LIMIT_MAX; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie: cartCookie([{ p: denomId, q: 1 }]), "x-forwarded-for": ip },
        payload: { method: "bybit", guest_email: `flood${i}@example.com` },
      });
      expect(res.statusCode).toBe(201); // still under the cap
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie: cartCookie([{ p: denomId, q: 1 }]), "x-forwarded-for": ip },
      payload: { method: "bybit", guest_email: "flood-over@example.com" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "error.rate_limited" });
  });
});

describe("POST /api/v1/checkout — guest happy path (Task 4c)", () => {
  it("creates a guest user, an order owned by it, a session cookie, and clears the guest cart cookie", async () => {
    const before = await countUsers();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie: cartCookie([{ p: denomId, q: 1 }]), "x-forwarded-for": freshIp() },
      payload: { method: "bybit", guest_email: "  Happy.Guest@Example.COM  " },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.order_code).toEqual(expect.any(String));
    expect(body.pay_url).toBe(`/checkout/${body.order_code}/pay`);

    // Exactly one new user row, and it is the guest.
    expect(await countUsers()).toBe(before + 1);
    const guest = await prisma.user.findFirst({ where: { guestEmail: "happy.guest@example.com" } });
    expect(guest).not.toBeNull();
    expect(guest!.isGuest).toBe(true);
    expect(guest!.email).toBeNull();
    expect(guest!.telegramId).toBeNull();

    // The order belongs to that guest user.
    const order = await prisma.order.findFirst({ where: { orderCode: body.order_code } });
    expect(order).not.toBeNull();
    expect(order!.userId).toBe(guest!.id);

    // The response establishes the storefront session AND empties the guest
    // cart cookie (establishSession migrated the lines to CartItem rows).
    const setCookies = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
    expect(cookies.some((c) => c.startsWith(`${SHOP_COOKIE_NAME}=`))).toBe(true);
    const cartSet = cookies.find((c) => c.startsWith(`${CART_COOKIE}=`));
    expect(cartSet).toBeDefined();
    expect(decodeURIComponent(cartSet!.split(";")[0]!.slice(CART_COOKIE.length + 1))).toBe(
      JSON.stringify({ v: CART_COOKIE_VERSION, items: [] }),
    );
  });
});

// ------------------------------------- signed-in regressions stay untouched
describe("POST /api/v1/checkout — signed-in path is unchanged (Task 4c)", () => {
  it("still 403s csrf_failed without an x-csrf-token header", async () => {
    const uid = await makeUser("guestapicsrf", "guestapicsrf-pw-1", "GAPICS");
    const { cookie } = await loginAs("guestapicsrf", "guestapicsrf-pw-1");
    await addToCart(prisma, uid, denomId, 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie },
      payload: { method: "bybit" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_failed" });
  });

  it("ignores guest_email for a signed-in buyer — the order stays on their own account", async () => {
    const uid = await makeUser("guestapiowner", "guestapiowner-pw-1", "GAPIOW");
    const { cookie, csrf } = await loginAs("guestapiowner", "guestapiowner-pw-1");
    await addToCart(prisma, uid, denomId, 1);
    const before = await countUsers();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "bybit", guest_email: "someone.else@example.com" },
    });
    expect(res.statusCode).toBe(201);
    expect(await countUsers()).toBe(before); // no guest row minted
    const order = await prisma.order.findFirst({ where: { orderCode: res.json().order_code } });
    expect(order!.userId).toBe(uid);
  });
});

describe("pay / status / cancel stay session-locked (Task 4b)", () => {
  it("401s anonymously and 404s for a signed-in stranger", async () => {
    const ownerId = await makeUser("guestapipay", "guestapipay-pw-1", "GAPIPY");
    const owner = await loginAs("guestapipay", "guestapipay-pw-1");
    await addToCart(prisma, ownerId, denomId, 1);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf },
      payload: { method: "bybit" },
    });
    expect(created.statusCode).toBe(201);
    const code = created.json().order_code;

    for (const url of [`/api/v1/orders/${code}/pay`, `/api/v1/orders/${code}/status`]) {
      const anon = await app.inject({ method: "GET", url });
      expect(anon.statusCode).toBe(401);
      expect(anon.json()).toEqual({ error: "unauthorized" });
    }

    await makeUser("guestapistranger", "guestapistranger-pw-1", "GAPIST");
    const stranger = await loginAs("guestapistranger", "guestapistranger-pw-1");
    for (const url of [`/api/v1/orders/${code}/pay`, `/api/v1/orders/${code}/status`]) {
      const probe = await app.inject({ method: "GET", url, headers: { cookie: stranger.cookie } });
      expect(probe.statusCode).toBe(404);
      expect(probe.json()).toEqual({ error: "not_found" });
    }

    const anonCancel = await app.inject({ method: "POST", url: `/api/v1/orders/${code}/cancel` });
    expect(anonCancel.statusCode).toBe(401);
  });
});
