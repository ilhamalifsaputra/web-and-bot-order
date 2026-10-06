/**
 * M11 / audit P0-1 at the storefront's own checkout — the two buyer-facing
 * halves of the minimum-order-amount work:
 *
 *  - A cart a voucher alone reduces to Rp0 must still check out. It is settled
 *    from the shop's own books (paid, delivered, no gateway field ever set)
 *    whichever payment method the buyer had selected, because there is nothing
 *    for a gateway to collect. Without this the new finalize-time guard would
 *    make a fully-discounted cart unpayable by any route.
 *  - A payment method whose configured minimum the cart total cannot clear is
 *    not offered at all. The filter reads the SAME settings the finalize-time
 *    guard enforces (crud/orderMinimums.ts), so a rail can never be offered on
 *    the checkout page and then refused at the moment of payment.
 *
 * Pattern: guest-checkout-api.test.ts — app.inject() against an isolated temp DB.
 */
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
  createVoucher,
  addToCart,
  clearCart,
  MIN_ORDER_AMOUNT_IDR_KEY,
  TOKOPAY_MIN_AMOUNT_KEY,
  BYBIT_MIN_AMOUNT_KEY,
  USD_IDR_RATE_UPDATED_AT_KEY,
  FX_QUOTE_TTL_MINUTES_KEY,
  DEFAULT_FX_QUOTE_TTL_MINUTES,
} from "@app/db";
import { DeliveryType, OrderStatus, PaymentMethod, VoucherType } from "@app/core/enums";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let denomId: number;
let manualDenomId: number;
let userId: number;
let cookie: string;
let csrf: string;

const DENOM_PRICE = "40000";

async function loginAs(identifier: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  expect(res.statusCode).toBe(200);
  const c = res.headers["set-cookie"];
  const sessionCookie = Array.isArray(c) ? c.join("; ") : String(c);
  const shell = await app.inject({ method: "GET", url: "/spa-shell-probe", headers: { cookie: sessionCookie } });
  const token = /name="csrf-token" content="([^"]*)"/.exec(shell.body)![1]!;
  expect(token).not.toBe("");
  return { cookie: sessionCookie, csrf: token };
}

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Minimums Cat", slug: "minimums-cat", emoji: "🛒", sortOrder: 1 },
  });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Minimums Product" });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "1 Month",
    type: "SHARED",
    durationLabel: "1 Month",
    price: DENOM_PRICE,
  });
  denomId = denom.id;
  await prisma.stockItem.createMany({
    data: Array.from({ length: 20 }, () => ({
      productId: denomId,
      credentials: "user@mail.com:pass",
      status: "AVAILABLE",
    })),
  });
  // Both an IDR rail (TokoPay/QRIS) and a USDT one (Bybit) live, so the
  // filtering cases below have something to hide.
  await setSetting(prisma, "tokopay_merchant_id", "M-TEST");
  await setSetting(prisma, "tokopay_secret", "S-TEST");
  await setSetting(prisma, "bybit_uid", "123456789");
  await setSetting(prisma, "bybit_api_key", "k");
  await setSetting(prisma, "bybit_api_secret", "s");
  await setSetting(prisma, "usd_idr_rate", "16000");
  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "Minimums Test Shop");
  // One 100%-off voucher per test that spends one: a voucher can only be
  // redeemed once per user (the (voucherId, userId) unique index), so reusing
  // a single code across two checkouts by the same buyer would fail on the
  // redemption rule rather than on anything this file is about.
  await createVoucher(prisma, { code: "FREE100", type: VoucherType.PERCENT, value: "100", usageLimit: 100 });
  await createVoucher(prisma, { code: "FREE100B", type: VoucherType.PERCENT, value: "100", usageLimit: 100 });
  await createVoucher(prisma, { code: "FREE100C", type: VoucherType.PERCENT, value: "100", usageLimit: 100 });
  await createVoucher(prisma, { code: "FREE100D", type: VoucherType.PERCENT, value: "100", usageLimit: 100 });
  // Preview requires an unused per-user voucher; earlier checkout tests redeem FREE100.
  await createVoucher(prisma, { code: "FREEPREVIEW", type: VoucherType.PERCENT, value: "100", usageLimit: 100 });

  // A hand-fulfilled SKU: its paid orders stop at PROCESSING until an admin
  // types and sends the account, which is the state the pay page used to render
  // as "closed". No stock rows — a manual SKU has none by definition.
  const manualDenom = await createDenomination(prisma, {
    productId: product.id,
    name: "Manual 1 Month",
    type: "SHARED",
    durationLabel: "1 Month",
    price: DENOM_PRICE,
    deliveryType: DeliveryType.MANUAL,
  });
  manualDenomId = manualDenom.id;

  const u = await prisma.user.create({
    data: {
      loginUsername: "minbuyer",
      email: "minbuyer@u.test",
      passwordHash: hashPassword("minbuyer-pw-1"),
      referralCode: "MINBUY",
    },
  });
  userId = u.id;
  ({ cookie, csrf } = await loginAs("minbuyer", "minbuyer-pw-1"));
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

beforeEach(async () => {
  await clearCart(prisma, userId);
  // Each case declares the minimums it needs; start from none in force.
  await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
  await setSetting(prisma, TOKOPAY_MIN_AMOUNT_KEY, "");
  await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "");
  // Deleted, not blanked: no freshness stamp at all is "freshness unknown",
  // which the FX quote guard lets through, so the minimum cases below are
  // unaffected by it — while the TTL itself stays at its documented default so
  // the freshness cases further down can lean on that default.
  await deleteSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY);
  await deleteSetting(prisma, FX_QUOTE_TTL_MINUTES_KEY);
});

describe("POST /api/v1/checkout — a cart a discount alone reduced to Rp0", () => {
  it("settles from the shop's own books and delivers, with no gateway field set", async () => {
    await addToCart(prisma, userId, denomId, 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "bybit", voucher_code: "FREE100" },
    });
    expect(res.statusCode).toBe(201);

    const order = await prisma.order.findFirstOrThrow({
      where: { orderCode: res.json().order_code },
    });
    expect(order.status).toBe(OrderStatus.DELIVERED);
    // The buyer picked Bybit; there was nothing to collect, so no rail was used.
    expect(order.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(Number(order.totalAmount)).toBe(0);
    expect(Number(order.uniqueCents)).toBe(0);
    // No gateway reference and no exchange rate: the USDT branch of
    // finalizeOrderPayment, which is what would have set both (and replaced the
    // plain creation-time payment window with Bybit's own), never ran.
    expect(order.paymentRef).toBeNull();
    expect(order.fxRate).toBeNull();
    expect(order.paidAt).not.toBeNull();
    // Nothing moved, so nothing was booked against the buyer's credit.
    expect(await prisma.walletTransaction.count({ where: { userId } })).toBe(0);
  });

  // Whole-branch review A3: the reply's `pay_url` used to be the pay page for
  // every gateway checkout, including one that had already been settled —
  // handing the buyer a payment screen for an order nobody owes anything on,
  // where the countdown is the order's creation-time window and the only real
  // action is "cancel". The wallet-credit branch of this same route has always
  // answered `/account/orders/<code>`; a fully-discounted order is in exactly
  // that position and now answers the same way.
  it("answers with the order page, not the pay page — there is nothing left to pay", async () => {
    await addToCart(prisma, userId, denomId, 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "qris", voucher_code: "FREE100C" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.pay_url).toBe(`/account/orders/${body.order_code}`);
  });

  it("still answers with the pay page when there IS something to collect", async () => {
    await addToCart(prisma, userId, denomId, 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "bybit" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.pay_url).toBe(`/checkout/${body.order_code}/pay`);
  });

  // Whole-branch review A3, second half: a hand-fulfilled SKU's settled order
  // stops at PROCESSING, which payState's catch-all read as "closed" — so the
  // pay page told a buyer whose voucher had just bought them a manual SKU that
  // "This order is closed." It is the most alive an order gets: paid, waiting
  // for an admin to type and send the account.
  it("a settled MANUAL SKU order polls as a live 'processing', never as 'closed'", async () => {
    await addToCart(prisma, userId, manualDenomId, 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "qris", voucher_code: "FREE100D" },
    });
    expect(res.statusCode).toBe(201);
    const code = res.json().order_code;
    const order = await prisma.order.findFirstOrThrow({ where: { orderCode: code } });
    expect(order.status).toBe(OrderStatus.PROCESSING);

    const poll = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${code}/status`,
      headers: { cookie },
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().state).toBe("processing");
  });

  it("does the same for an IDR rail (the routing is per-total, not per-method)", async () => {
    await addToCart(prisma, userId, denomId, 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "qris", voucher_code: "FREE100B" },
    });
    expect(res.statusCode).toBe(201);

    const order = await prisma.order.findFirstOrThrow({ where: { orderCode: res.json().order_code } });
    expect(order.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(order.status).toBe(OrderStatus.DELIVERED);
    expect(order.paymentRef).toBeNull();
  });
});

// Whole-branch review F4a. `error.amount_below_rail_minimum` reads "That total is
// below the minimum this payment method accepts ({min} {currency})." The bot fills
// those braces from the ValidationError's `formatArgs`; the storefront threw them
// away, so the buyer read the placeholders verbatim. The args now travel with the
// key in the response body, for every route in this app and every key that has
// any — the whole point of fixing it in the API layer rather than per message.
describe("POST /api/v1/checkout — a refusal carries the figures its wording names", () => {
  it("answers 400 with the rail-minimum key AND the {min}/{currency} args that fill it", async () => {
    await setSetting(prisma, TOKOPAY_MIN_AMOUNT_KEY, "100000"); // > Rp40.000
    await addToCart(prisma, userId, denomId, 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "qris" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "error.amount_below_rail_minimum",
      // Strings, not Decimals or numbers: this is JSON on its way to a
      // `{placeholder}` substitution, and the figure an admin typed is the figure
      // the buyer must be shown.
      error_args: { min: "100000", currency: "IDR" },
    });
  });

  it("omits error_args entirely for a key that names no placeholder", async () => {
    // Nothing in the cart: `error.cart_empty` is a bare sentence, so a body with
    // an empty `error_args` object would be noise every caller has to ignore.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "qris" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_args).toBeUndefined();
  });
});

describe("GET /api/v1/checkout — payment methods the total cannot clear are not offered", () => {
  it("offers both rails when the total clears every minimum", async () => {
    await addToCart(prisma, userId, denomId, 1);
    const body = (await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } })).json();
    expect(body.total).toBe(DENOM_PRICE);
    expect(body.idr_enabled).toBe(true);
    expect(body.bybit_enabled).toBe(true);
  });

  it("hides the IDR rail whose own minimum the total misses, keeping the others", async () => {
    await setSetting(prisma, TOKOPAY_MIN_AMOUNT_KEY, "100000"); // > Rp40.000
    await addToCart(prisma, userId, denomId, 1);

    const body = (await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } })).json();
    expect(body.idr_enabled).toBe(false);
    expect(body.bybit_enabled).toBe(true);
  });

  it("hides a USDT rail whose USDT minimum the converted total misses", async () => {
    // Rp40.000 at 16.000 is 2.5 USDT — under a 5 USDT floor.
    await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "5");
    await addToCart(prisma, userId, denomId, 1);

    const body = (await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } })).json();
    expect(body.bybit_enabled).toBe(false);
    expect(body.idr_enabled).toBe(true);
  });

  it("the shop-wide minimum hides every gateway at once", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "100000");
    await addToCart(prisma, userId, denomId, 1);

    const body = (await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } })).json();
    expect(body.idr_enabled).toBe(false);
    expect(body.bybit_enabled).toBe(false);
  });

  // Whole-branch review A5: with every flag false the page cannot tell "this
  // shop has no working gateway" from "your order is too cheap for the ones it
  // has", and it showed contact-support copy for both. Only the second is
  // something the buyer can act on, so the server says which it is.
  it("reports below_all_minimums when a live gateway was hidden only by a minimum", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "100000");
    await addToCart(prisma, userId, denomId, 1);

    const body = (await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } })).json();
    expect(body.below_all_minimums).toBe(true);
  });

  it("does NOT report below_all_minimums when at least one method is still offered", async () => {
    await setSetting(prisma, TOKOPAY_MIN_AMOUNT_KEY, "100000"); // hides QRIS only
    await addToCart(prisma, userId, denomId, 1);

    const body = (await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } })).json();
    expect(body.idr_enabled).toBe(false);
    expect(body.bybit_enabled).toBe(true);
    expect(body.below_all_minimums).toBe(false);
  });

  it("does NOT report below_all_minimums when no gateway is configured at all — the total is not the problem", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "100000");
    await setSetting(prisma, "tokopay_merchant_id", "");
    await setSetting(prisma, "bybit_uid", "");
    await addToCart(prisma, userId, denomId, 1);
    try {
      const body = (await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } })).json();
      expect(body.idr_enabled).toBe(false);
      expect(body.bybit_enabled).toBe(false);
      expect(body.below_all_minimums).toBe(false);
    } finally {
      await setSetting(prisma, "tokopay_merchant_id", "M-TEST");
      await setSetting(prisma, "bybit_uid", "123456789");
    }
  });

  it("does NOT report below_all_minimums on a Rp0 total — it is never filtered", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "100000");
    await addToCart(prisma, userId, denomId, 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/voucher/preview",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { voucher_code: "FREEPREVIEW" },
    });
    expect(res.json().below_all_minimums).toBe(false);
  });

  it("a Rp0 total is not filtered — it needs no rail, and the buyer must still be able to submit", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "100000");
    await addToCart(prisma, userId, denomId, 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/voucher/preview",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { voucher_code: "FREEPREVIEW" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe("0");
    expect(body.idr_enabled).toBe(true);
    expect(body.bybit_enabled).toBe(true);
  });
});

/**
 * Whole-branch review A2: the same "never offer what the guard would refuse"
 * rule applied to M12's quote TTL rather than M11's minimums.
 * `fx_rate_max_age_hours` (48h) is what makes the saved rate read as null and
 * takes the USDT options away; `fx_quote_ttl_minutes` (180m) refuses the
 * finalize. Between the two, this page offered every USDT method and had each
 * one refused with `error.fx_quote_expired` the moment it was submitted.
 *
 * The rate stays a live, non-null Rp16.000 throughout — only its freshness
 * stamp moves, which is exactly the window the bug lived in.
 */
describe("GET /api/v1/checkout — USDT methods are hidden once the rate's quote lifetime has passed", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  const view = async () =>
    (await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } })).json();

  it("hides the USDT rails but keeps the IDR one when the stamp is older than the default TTL", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(Number(DEFAULT_FX_QUOTE_TTL_MINUTES) + 5));
    await addToCart(prisma, userId, denomId, 1);

    const body = await view();
    expect(body.bybit_enabled).toBe(false);
    expect(body.idr_enabled).toBe(true);
    // The rate itself is still live — this is the TTL, not the 48-hour horizon.
    expect(body.total_usdt).not.toBeNull();
  });

  it("keeps the USDT rails when the stamp is inside the TTL", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(5));
    await addToCart(prisma, userId, denomId, 1);

    expect((await view()).bybit_enabled).toBe(true);
  });

  it("widening fx_quote_ttl_minutes past the stamp's age brings the USDT rails back", async () => {
    // Derived from the default rather than a literal: an age that is stale under
    // one default and fresh under the next makes this case pass for the wrong
    // reason, which is what the 120-minute figure it used to carry started doing
    // the moment the default moved to 180.
    const staleBy = Number(DEFAULT_FX_QUOTE_TTL_MINUTES) + 60;
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(staleBy));
    await addToCart(prisma, userId, denomId, 1);
    expect((await view()).bybit_enabled).toBe(false);

    await setSetting(prisma, FX_QUOTE_TTL_MINUTES_KEY, String(staleBy + 60));
    expect((await view()).bybit_enabled).toBe(true);
  });

  it("a Rp0 total keeps its USDT option however stale the quote is — it never reaches the guard", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(60 * 24));
    await addToCart(prisma, userId, denomId, 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/voucher/preview",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { voucher_code: "FREEPREVIEW" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe("0");
    expect(body.bybit_enabled).toBe(true);
  });
});
