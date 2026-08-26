// Wallet top-up storefront routes (Task 5, apps/storefront/src/routes/apiWalletTopup.ts).
// Pattern: spa-api.test.ts's checkout describe block — app.inject() against an
// isolated temp DB; the happy/auth-fail/bad-csrf trio per mutating endpoint
// (CLAUDE.md), plus the validation matrix and ownership checks the task brief
// calls out explicitly.
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
  WALLET_TOPUP_MIN_AMOUNT_IDR_KEY,
  WALLET_TOPUP_MAX_AMOUNT_IDR_KEY,
} from "@app/db";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let denomId: number;

/** Sign in via the JSON endpoint, then scrape the CSRF token from the SPA
 * shell's <meta name="csrf-token"> — same helper as spa-api.test.ts. */
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

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Streaming", slug: "streaming-wt", emoji: "🎬", sortOrder: 1 },
  });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Netflix Premium WT" });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "1 Month",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "40000",
  });
  denomId = denom.id;
  await prisma.stockItem.createMany({
    data: Array.from({ length: 5 }, () => ({
      productId: denomId,
      credentials: "user@mail.com:pass",
      status: "AVAILABLE",
    })),
  });
  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "WT Test Shop");
  // IDR + USDT rails, mirroring spa-api.test.ts's checkout fixtures.
  await setSetting(prisma, "tokopay_merchant_id", "m-test");
  await setSetting(prisma, "tokopay_secret", "s-test");
  await setSetting(prisma, "bybit_uid", "123456789");
  await setSetting(prisma, "bybit_api_key", "k");
  await setSetting(prisma, "bybit_api_secret", "s");
  await setSetting(prisma, "usd_idr_rate", "16000");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

describe("GET /api/v1/wallet/topup", () => {
  it("401s an anonymous visitor — a guest has no wallet to top up", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/wallet/topup" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns enabled gateways per currency, limits and current balances for a signed-in customer", async () => {
    await makeUser("wtreaduser", "wtread-pw-123", "WTREAD");
    const { cookie } = await loginAs("wtreaduser", "wtread-pw-123");
    const res = await app.inject({ method: "GET", url: "/api/v1/wallet/topup", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.idr_enabled).toBe(true); // tokopay configured above
    expect(body.paydisini_enabled).toBe(false); // never configured in this file
    expect(body.bybit_enabled).toBe(true); // bybit + usd_idr_rate configured above
    expect(body).toMatchObject({
      wallet_idr: "0",
      wallet_usdt: "0",
      min_idr: null,
      max_idr: null,
      min_usdt: null,
      max_usdt: null,
    });
  });
});

describe("POST /api/v1/wallet/topup — validation matrix", () => {
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    await makeUser("wtbuyer", "wtbuyer-pw-123", "WTBUYER");
    const session = await loginAs("wtbuyer", "wtbuyer-pw-123");
    cookie = session.cookie;
    csrf = session.csrf;
  });

  function post(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/wallet/topup",
      headers: { cookie, "x-csrf-token": csrf },
      payload: body,
    });
  }

  it("401s an anonymous request", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/wallet/topup", payload: { currency: "IDR", amount: "50000", method: "qris" } });
    expect(res.statusCode).toBe(401);
  });

  it("403s a signed-in request with a missing/bad CSRF token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/wallet/topup",
      headers: { cookie, "x-csrf-token": "bad" },
      payload: { currency: "IDR", amount: "50000", method: "qris" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_failed" });
  });

  // Task 12 fix-review: apiWalletTopup.ts's csrfHeaderOk (shared by both
  // mutating wallet-topup routes) was missing the Origin/Referer
  // defense-in-depth check that api.ts's inline checks already had — same
  // 403 shape as a bad token, same "no Origin/Referer passes" allowance.
  it("403s (same shape as bad token) when Origin is present but mismatched, even with a valid token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/wallet/topup",
      headers: { cookie, "x-csrf-token": csrf, origin: "https://evil.example" },
      payload: { currency: "IDR", amount: "50000", method: "qris" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_failed" });
  });

  it("201s with a valid token and no Origin/Referer header at all", async () => {
    const res = await post({ currency: "IDR", amount: "50000", method: "qris" });
    expect(res.statusCode).toBe(201);
  });

  it("201s with a valid token and an Origin header matching this request's own host", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/wallet/topup",
      headers: { cookie, "x-csrf-token": csrf, origin: "http://localhost" },
      payload: { currency: "IDR", amount: "50000", method: "qris" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects an unknown/disabled method with a clean 400, not a 500", async () => {
    const unknown = await post({ currency: "IDR", amount: "50000", method: "visa" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: "web.pay_method_unavailable" });

    // PayDisini creds are never configured in this file.
    const disabled = await post({ currency: "IDR", amount: "50000", method: "paydisini" });
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json()).toEqual({ error: "web.pay_method_unavailable" });
  });

  it("rejects a currency/method mismatch with a clean 400", async () => {
    const res = await post({ currency: "USDT", amount: "50000", method: "qris" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "web.pay_method_unavailable" });
  });

  it("rejects an amount below the configured minimum with a clean 400", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "20000");
    try {
      const res = await post({ currency: "IDR", amount: "5000", method: "qris" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "error.wallet_topup_below_min" });
    } finally {
      await deleteSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY);
    }
  });

  it("rejects an amount above the configured maximum with a clean 400", async () => {
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_IDR_KEY, "100000");
    try {
      const res = await post({ currency: "IDR", amount: "500000", method: "qris" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "error.wallet_topup_above_max" });
    } finally {
      await deleteSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_IDR_KEY);
    }
  });

  it("creates a WALLET_TOPUP order (kind + no items) on a valid request", async () => {
    const before = await prisma.order.count();
    const res = await post({ currency: "IDR", amount: "50000", method: "qris" });
    expect(res.statusCode).toBe(201);
    const { orderCode } = res.json();
    expect(typeof orderCode).toBe("string");
    const order = await prisma.order.findUnique({ where: { orderCode }, include: { items: true } });
    expect(order).toMatchObject({ kind: "WALLET_TOPUP", totalAmount: expect.anything() });
    expect(order!.items).toHaveLength(0);
    expect((await prisma.order.count()) - before).toBe(1);
  });

  it("creates a USDT WALLET_TOPUP order via bybit, stamping the fx rate without converting the amount", async () => {
    const res = await post({ currency: "USDT", amount: "25", method: "bybit" });
    expect(res.statusCode).toBe(201);
    const order = await prisma.order.findUniqueOrThrow({ where: { orderCode: res.json().orderCode } });
    expect(order.currency).toBe("USDT");
    expect(order.totalAmount.toString()).toBe("25"); // no usdtFromIdr conversion
    expect(order.fxRate?.toString()).toBe("16000");
  });
});

describe("wallet-topup pay/status/cancel wrappers — ownership + kind checks", () => {
  let ownerCookie: string;
  let ownerCsrf: string;
  let topupCode: string;
  let otherCookie: string;
  let otherCsrf: string;
  let productOrderCode: string;

  beforeAll(async () => {
    const ownerId = await makeUser("wtowner", "wtowner-pw-123", "WTOWNER");
    const owner = await loginAs("wtowner", "wtowner-pw-123");
    ownerCookie = owner.cookie;
    ownerCsrf = owner.csrf;

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/wallet/topup",
      headers: { cookie: ownerCookie, "x-csrf-token": ownerCsrf },
      payload: { currency: "IDR", amount: "50000", method: "qris" },
    });
    expect(created.statusCode).toBe(201);
    topupCode = created.json().orderCode;

    await makeUser("wtother", "wtother-pw-123", "WTOTHER");
    const other = await loginAs("wtother", "wtother-pw-123");
    otherCookie = other.cookie;
    otherCsrf = other.csrf;

    // A PRODUCT-kind order for the ownership-by-kind check below — bought by
    // the SAME owner, so the only variable under test is `kind`, not ownership.
    await addToCart(prisma, ownerId, denomId, 1);
    const productOrder = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie: ownerCookie, "x-csrf-token": ownerCsrf },
      payload: { method: "bybit" },
    });
    expect(productOrder.statusCode).toBe(201);
    productOrderCode = productOrder.json().order_code;
  });

  it("GET .../pay: 401 anonymous, 200 for the owner, 404 for someone else's code, 404 for a PRODUCT-kind code", async () => {
    const anon = await app.inject({ method: "GET", url: `/api/v1/wallet/topup/${topupCode}/pay` });
    expect(anon.statusCode).toBe(401);

    const owned = await app.inject({ method: "GET", url: `/api/v1/wallet/topup/${topupCode}/pay`, headers: { cookie: ownerCookie } });
    expect(owned.statusCode).toBe(200);
    const body = owned.json();
    expect(body.order.code).toBe(topupCode);
    expect(body.state).toBe("waiting");
    expect(body.is_qris).toBe(true);

    const foreign = await app.inject({ method: "GET", url: `/api/v1/wallet/topup/${topupCode}/pay`, headers: { cookie: otherCookie } });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: "not_found" });

    // Owned by the same customer, but it's a PRODUCT order — the top-up route
    // must not serve it either (kind check, not just ownership).
    const wrongKind = await app.inject({ method: "GET", url: `/api/v1/wallet/topup/${productOrderCode}/pay`, headers: { cookie: ownerCookie } });
    expect(wrongKind.statusCode).toBe(404);
  });

  it("GET .../status returns {state, redirect} and 404s the same way as .../pay", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/wallet/topup/${topupCode}/status`, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: "waiting", redirect: null });

    const foreign = await app.inject({ method: "GET", url: `/api/v1/wallet/topup/${topupCode}/status`, headers: { cookie: otherCookie } });
    expect(foreign.statusCode).toBe(404);

    const wrongKind = await app.inject({ method: "GET", url: `/api/v1/wallet/topup/${productOrderCode}/status`, headers: { cookie: ownerCookie } });
    expect(wrongKind.statusCode).toBe(404);
  });

  it("POST .../cancel: trio (401/403/200), 404 for someone else's code, 404 for a PRODUCT-kind code", async () => {
    const anon = await app.inject({ method: "POST", url: `/api/v1/wallet/topup/${topupCode}/cancel` });
    expect(anon.statusCode).toBe(401);

    const badCsrf = await app.inject({
      method: "POST",
      url: `/api/v1/wallet/topup/${topupCode}/cancel`,
      headers: { cookie: ownerCookie, "x-csrf-token": "bad" },
    });
    expect(badCsrf.statusCode).toBe(403);

    const foreign = await app.inject({
      method: "POST",
      url: `/api/v1/wallet/topup/${topupCode}/cancel`,
      headers: { cookie: otherCookie, "x-csrf-token": otherCsrf },
    });
    expect(foreign.statusCode).toBe(404);

    const wrongKind = await app.inject({
      method: "POST",
      url: `/api/v1/wallet/topup/${productOrderCode}/cancel`,
      headers: { cookie: ownerCookie, "x-csrf-token": ownerCsrf },
    });
    expect(wrongKind.statusCode).toBe(404);
    // The PRODUCT order must be untouched by that 404'd attempt.
    const untouched = await prisma.order.findUniqueOrThrow({ where: { orderCode: productOrderCode } });
    expect(untouched.status).toBe("PENDING_PAYMENT");

    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/wallet/topup/${topupCode}/cancel`,
      headers: { cookie: ownerCookie, "x-csrf-token": ownerCsrf },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    const status = await app.inject({ method: "GET", url: `/api/v1/wallet/topup/${topupCode}/status`, headers: { cookie: ownerCookie } });
    expect(status.json().state).toBe("closed");
  });
});
