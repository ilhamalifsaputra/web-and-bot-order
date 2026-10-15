// Backend audit pass 2, Task 4 (A6 + A7).
//
// A6 — quote binding. Both wallet rails (POST /api/v1/checkout and
// POST /api/v1/topup/order with method wallet_idr / wallet_usdt) re-price from
// the live denomination and debit the balance in the same request. A buyer who
// previewed Rp40.000 and clicked after an admin raised the price was debited the
// NEW price without ever seeing it. The optional `expected_total` field binds the
// click to the figure the buyer saw: a different server-computed total is a 409
// `error.quote_changed` and nothing is debited. Absent, behaviour is unchanged.
//
// A7 — keyless double submit. With no `Idempotency-Key` header, two taps of
// "Beli" on the instant-buy rail created two orders and (on the wallet rail)
// debited the balance twice. A signed-in keyless request is now deduplicated on
// a key derived from the buyer + the request's content, for a short window, so a
// double tap yields one order and one debit. Header-carrying clients are
// untouched. Wallet top-up creation reuses an equivalent pending top-up made in
// the same window instead of opening a second invoice.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import { prisma, initDb, setSetting, createCatalogProduct, createDenomination, addToCart } from "@app/db";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let denomId: number;
const DENOM_PRICE = "40000";

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

let userCounter = 0;
/** A fresh signed-in buyer with the given balances. */
async function buyer(balances: { idr?: string; usdt?: string } = {}) {
  userCounter += 1;
  const username = `quotededupe${userCounter}`;
  const password = `${username}-pw-1`;
  const u = await prisma.user.create({
    data: {
      loginUsername: username,
      email: `${username}@u.test`,
      passwordHash: hashPassword(password),
      referralCode: `QD${userCounter}X`,
      walletBalance: balances.idr ?? "0",
      walletBalanceUsdt: balances.usdt ?? "0",
    },
  });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: username, password } });
  expect(login.statusCode).toBe(200);
  const c = login.headers["set-cookie"];
  const cookie = Array.isArray(c) ? c.join("; ") : String(c);
  const shell = await app.inject({ method: "GET", url: "/spa-shell-probe", headers: { cookie } });
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(shell.body)![1]!;
  return { id: u.id, cookie, csrf };
}

type Buyer = Awaited<ReturnType<typeof buyer>>;

function topupOrder(b: Buyer, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/topup/order",
    headers: { cookie: b.cookie, "x-csrf-token": b.csrf, "x-forwarded-for": freshIp(), ...extraHeaders },
    payload: { denomination_id: denomId, qty: 1, ...payload },
  });
}

function cartCheckout(b: Buyer, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { cookie: b.cookie, "x-csrf-token": b.csrf, "x-forwarded-for": freshIp(), ...extraHeaders },
    payload,
  });
}

function walletTopup(b: Buyer, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/wallet/topup",
    headers: { cookie: b.cookie, "x-csrf-token": b.csrf, "x-forwarded-for": freshIp() },
    payload,
  });
}

async function balances(userId: number) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return { idr: u.walletBalance.toString(), usdt: u.walletBalanceUsdt.toString() };
}

const ordersOf = (userId: number) => prisma.order.count({ where: { userId } });

/** Move every keyless dedupe record past the window, as if the buyer came back later. */
async function ageKeylessRecords() {
  await prisma.idempotencyRecord.updateMany({
    where: { key: { startsWith: "keyless:" } },
    data: { createdAt: new Date(Date.now() - 60 * 60_000) },
  });
}

async function withPrice<T>(price: string, run: () => Promise<T>): Promise<T> {
  await prisma.denomination.update({ where: { id: denomId }, data: { price } });
  try {
    return await run();
  } finally {
    await prisma.denomination.update({ where: { id: denomId }, data: { price: DENOM_PRICE } });
  }
}

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  const cat = await prisma.category.create({ data: { name: "Quote Cat", slug: "quote-cat", emoji: "🎮", sortOrder: 1 } });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Quote Product" });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "86 Diamonds",
    type: "SHARED",
    durationLabel: "-",
    price: DENOM_PRICE,
  });
  denomId = denom.id;
  await prisma.stockItem.createMany({
    data: Array.from({ length: 120 }, () => ({ productId: denomId, credentials: "user@mail.com:pass", status: "AVAILABLE" })),
  });
  await setSetting(prisma, "bybit_uid", "123456789");
  await setSetting(prisma, "bybit_api_key", "k");
  await setSetting(prisma, "bybit_api_secret", "s");
  await setSetting(prisma, "usd_idr_rate", "16000");
  await setSetting(prisma, "tokopay_merchant_id", "m-test");
  await setSetting(prisma, "tokopay_secret", "s-test");
  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "Quote Test Shop");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

// ---------------------------------------------------------------- A6
describe("A6 — expected_total binds a wallet checkout to the quoted price", () => {
  it("instant buy, wallet_idr: price changed after the preview → 409 error.quote_changed, no order, no debit", async () => {
    const b = await buyer({ idr: "100000" });
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/topup/preview",
      headers: { cookie: b.cookie, "x-csrf-token": b.csrf },
      payload: { denomination_id: denomId, qty: 1 },
    });
    expect(preview.statusCode).toBe(200);
    const quoted = preview.json().total as string;
    expect(quoted).toBe("40000");

    const res = await withPrice("45000", () => topupOrder(b, { method: "wallet_idr", expected_total: quoted }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "error.quote_changed",
      currency: "IDR",
      expected_total: "40000",
      current_total: "45000",
    });
    expect(await ordersOf(b.id)).toBe(0);
    expect(await balances(b.id)).toEqual({ idr: "100000", usdt: "0" });
  });

  it("instant buy, wallet_idr: a matching quote settles and debits exactly the quoted amount", async () => {
    const b = await buyer({ idr: "100000" });
    const res = await topupOrder(b, { method: "wallet_idr", expected_total: "40000" });
    expect(res.statusCode).toBe(201);
    expect(await ordersOf(b.id)).toBe(1);
    expect((await balances(b.id)).idr).toBe("60000");
  });

  it("instant buy, wallet_usdt: compares against the USDT figure the preview quoted (total_usdt)", async () => {
    const b = await buyer({ usdt: "10" });
    const stale = await withPrice("45000", () => topupOrder(b, { method: "wallet_usdt", expected_total: "2.5" }));
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: "error.quote_changed",
      currency: "USDT",
      expected_total: "2.5",
      current_total: "2.82",
    });
    expect(await ordersOf(b.id)).toBe(0);
    expect((await balances(b.id)).usdt).toBe("10");

    const ok = await topupOrder(b, { method: "wallet_usdt", expected_total: "2.5" });
    expect(ok.statusCode).toBe(201);
    expect((await balances(b.id)).usdt).toBe("7.5");
  });

  // The field is a machine echo of the preview's own Decimal string, read with
  // readCanonicalMoney exactly like the wallet top-up amount: a typed spelling
  // ("40.000" is forty thousand to a person), padding zeros, exponents, signs
  // and non-strings are refused rather than guessed at.
  it("instant buy: a non-canonical expected_total is a 400 and moves nothing", async () => {
    const b = await buyer({ idr: "100000" });
    for (const bad of ["abc", "1e3", "-40000", "40,000", "40.000", "40000.00", " 40000", 40000, true]) {
      const res = await topupOrder(b, { method: "wallet_idr", expected_total: bad });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_request" });
    }
    expect(await ordersOf(b.id)).toBe(0);
    expect((await balances(b.id)).idr).toBe("100000");
  });

  it("instant buy: without expected_total the request behaves exactly as before (charges the live price)", async () => {
    const b = await buyer({ idr: "100000" });
    const res = await withPrice("45000", () => topupOrder(b, { method: "wallet_idr" }));
    expect(res.statusCode).toBe(201);
    expect((await balances(b.id)).idr).toBe("55000");
  });

  it("cart checkout, wallet_idr: price changed after the summary → 409, cart kept, no debit; matching quote settles", async () => {
    const b = await buyer({ idr: "100000" });
    await addToCart(prisma, b.id, denomId, 1);
    const stale = await withPrice("45000", () => cartCheckout(b, { method: "wallet_idr", expected_total: "40000" }));
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "error.quote_changed", currency: "IDR", current_total: "45000" });
    expect(await ordersOf(b.id)).toBe(0);
    expect((await balances(b.id)).idr).toBe("100000");
    expect(await prisma.cartItem.count({ where: { userId: b.id } })).toBe(1);

    const ok = await cartCheckout(b, { method: "wallet_idr", expected_total: "40000" });
    expect(ok.statusCode).toBe(201);
    expect((await balances(b.id)).idr).toBe("60000");
  });

  it("header path: an expected_total mismatch is answered 409 with the key as well, and nothing is debited", async () => {
    const b = await buyer({ idr: "100000" });
    const res = await withPrice("45000", () =>
      topupOrder(b, { method: "wallet_idr", expected_total: "40000" }, { "idempotency-key": "quote-hdr-1" }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("error.quote_changed");
    expect((await balances(b.id)).idr).toBe("100000");
  });
});

