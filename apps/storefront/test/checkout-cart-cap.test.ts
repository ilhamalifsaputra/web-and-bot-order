// Route-level regression test for the storefront cart-size cap (M-7 fix,
// backend audit 2026-07-31): createOrderFromCart used to do per-unit work
// (allocateOneAvailableStock + an individual orderItem.create) for every
// single unit in the cart, with no cap on the total across all lines — only
// a 99-per-line clamp. A large multi-line cart could turn into thousands of
// queries inside one $transaction (Prisma's default 5s timeout), holding
// SQLite's single writer long enough to starve every other writer (the bot,
// webhooks, delivery transactions) before likely timing out and rolling
// back — so the buyer could never complete that cart at all.
//
// performCheckout now sums the cart's total units and rejects an over-cap
// cart BEFORE it ever calls prisma.$transaction — this test proves that by
// spying on prisma.$transaction and asserting it is never invoked for a
// rejected cart (not just that the eventual response is an error).
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import { prisma, initDb, createCatalogProduct, createDenomination, addToCart, setSetting, deleteSetting } from "@app/db";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";

let app: FastifyInstance;

// The CSRF token is scraped from the SPA shell's <meta name="csrf-token"> via
// an arbitrary unmapped path — same pattern as api.test.ts / spa-api.test.ts's
// loginAs(), since /login and its own CSRF-bearing form are gone post-cutover.
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

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "Cap Test Shop");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

describe("storefront cart-size cap (M-7)", () => {
  it("rejects an over-cap cart with error.cart_too_large WITHOUT ever opening the write transaction", async () => {
    const u = await prisma.user.create({
      data: {
        loginUsername: "capbuyer",
        email: "capbuyer@u.test",
        passwordHash: hashPassword("cap-buyer-pw-99"),
        referralCode: "CAPBUYER",
      },
    });
    const { cookie, csrf } = await loginAs("capbuyer", "cap-buyer-pw-99");

    const category = await prisma.category.create({
      data: { name: "Cap Test", slug: "cap-test", emoji: "🧪", sortOrder: 1 },
    });
    // 4 lines x 99 units = 396, over the 300-unit cap — each line stays
    // within the existing 99-per-line clamp, so only the NEW total-units cap
    // can reject this cart.
    for (let i = 0; i < 4; i++) {
      const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `Cap Item ${i}` });
      const denom = await createDenomination(prisma, {
        productId: product.id,
        name: `Cap Item ${i}`,
        type: "SHARED",
        durationLabel: "1 Month",
        price: "5.00",
      });
      await addToCart(prisma, u.id, denom.id, 99);
    }

    // A valid, available payment method — otherwise performCheckout would
    // throw web.pay_method_unavailable before it ever reaches the cart-cap
    // check, and this test would prove nothing about the cap.
    await setSetting(prisma, "bybit_uid", "123456789");
    await setSetting(prisma, "bybit_api_key", "k");
    await setSetting(prisma, "bybit_api_secret", "s");
    await setSetting(prisma, "usd_idr_rate", "16000");

    const transactionSpy = vi.spyOn(prisma, "$transaction");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { method: "bybit" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "error.cart_too_large" });
      // The whole point of the fix: an over-cap cart never even opens the
      // write transaction that the per-unit allocation loop would otherwise
      // hold for seconds.
      expect(transactionSpy).not.toHaveBeenCalled();
    } finally {
      transactionSpy.mockRestore();
      await deleteSetting(prisma, "bybit_uid");
      await deleteSetting(prisma, "bybit_api_key");
      await deleteSetting(prisma, "bybit_api_secret");
      await deleteSetting(prisma, "usd_idr_rate");
    }

    // No order was created — the cart is left untouched for the buyer to
    // trim down and retry.
    expect(await prisma.order.count({ where: { userId: u.id } })).toBe(0);
    expect(await prisma.cartItem.count({ where: { userId: u.id } })).toBe(4);
  });
});
