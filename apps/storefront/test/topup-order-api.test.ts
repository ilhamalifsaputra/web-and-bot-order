// Final-review fix N2: the cart-free instant top-up rail —
// POST /api/v1/topup/preview and POST /api/v1/topup/order.
//
// The bug this replaces: InstantBuyPage.tsx used to write its selected
// denomination into the server-side cart (clearing every existing line first)
// purely so the cart-based computeTotals could price it, so merely opening a
// Top Up Game product page destroyed the visitor's cart. These two routes price
// and charge an ad-hoc single line instead, reading and writing no cart at all.
//
// The single most important assertion in this file is the cross-check that the
// preview and the actual order agree to the cent for the same inputs: the whole
// point of threading an `adHocLine` parameter through the EXISTING
// checkoutView/computeTotals — rather than writing a second pricing path — is
// that "the preview quoted something other than what checkout charged" must be
// structurally impossible.
//
// Pattern: guest-checkout-api.test.ts — app.inject() against an isolated temp DB.
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
  createVoucher,
  addToCart,
  clearCart,
  getCart,
} from "@app/db";
import { VoucherType } from "@app/core/enums";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";
import { CART_COOKIE, CART_COOKIE_VERSION } from "../src/shop";
import { SHOP_COOKIE_NAME } from "../src/auth";
import { GUEST_CHECKOUT_RATE_LIMIT_MAX, CHECKOUT_PREVIEW_RATE_LIMIT_MAX, CHECKOUT_SUBMIT_RATE_LIMIT_MAX } from "../src/rateLimit";
import { MAX_PENDING_ORDERS } from "../src/routes/checkout";

let app: FastifyInstance;
/** AUTO SKU with stock — the default subject of most tests here. */
let denomId: number;
/** MANUAL_WITH_INFO SKU — for the customer_data validation tests. */
let infoDenomId: number;
/** Deactivated SKU — must be refused by both routes. */
let inactiveDenomId: number;
/** A Digiflazz-routed SKU — single-unit only, same rule POST /cart enforces. */
let digiflazzDenomId: number;

const DENOM_PRICE = "40000";

function cartCookie(items: Array<{ p: number; q: number }>): string {
  return `${CART_COOKIE}=` + encodeURIComponent(JSON.stringify({ v: CART_COOKIE_VERSION, items }));
}

/** A distinct simulated client IP per test, so one test's quota can never spill
 * into another's (both limiters are process-wide). */
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
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

function sessionCookieFrom(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const found = cookies.find((c) => c.startsWith(`${SHOP_COOKIE_NAME}=`));
  expect(found).toBeDefined();
  return found!.split(";")[0]!;
}

const countUsers = () => prisma.user.count();

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Topup API Cat", slug: "topup-api-cat", emoji: "🎮", sortOrder: 1 },
  });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Topup API Product" });

  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "86 Diamonds",
    type: "SHARED",
    durationLabel: "-",
    price: DENOM_PRICE,
  });
  denomId = denom.id;
  // Every completed order permanently consumes stock rows (reserved at order
  // creation), and the rate-limit test alone runs GUEST_CHECKOUT_RATE_LIMIT_MAX
  // orders — keep the pool comfortably ahead of that.
  await prisma.stockItem.createMany({
    data: Array.from({ length: 80 }, () => ({
      productId: denomId,
      credentials: "user@mail.com:pass",
      status: "AVAILABLE",
    })),
  });

  const infoDenom = await createDenomination(prisma, {
    productId: product.id,
    name: "172 Diamonds",
    type: "SHARED",
    durationLabel: "-",
    price: DENOM_PRICE,
    deliveryType: "manual_with_info",
    additionalFields: JSON.stringify([
      { key: "user_id", label: { id: "ID", en: "User ID" }, type: "text", required: true, options: [] },
    ]),
  });
  infoDenomId = infoDenom.id;

  const inactive = await createDenomination(prisma, {
    productId: product.id,
    name: "Retired Pack",
    type: "SHARED",
    durationLabel: "-",
    price: DENOM_PRICE,
    isActive: false,
  });
  inactiveDenomId = inactive.id;

  const digi = await createDenomination(prisma, {
    productId: product.id,
    name: "Digiflazz Pack",
    type: "SHARED",
    durationLabel: "-",
    price: DENOM_PRICE,
    autoDeliverySource: "digiflazz",
  });
  digiflazzDenomId = digi.id;

  // Enable one gateway (bybit) so the happy path has a live payment method.
  await setSetting(prisma, "bybit_uid", "123456789");
  await setSetting(prisma, "bybit_api_key", "k");
  await setSetting(prisma, "bybit_api_secret", "s");
  await setSetting(prisma, "usd_idr_rate", "16000");
  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "Topup API Test Shop");

  await createVoucher(prisma, { code: "TOPUP10", type: VoucherType.PERCENT, value: "10" });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

// ------------------------------------------------------------------- preview
describe("POST /api/v1/topup/preview", () => {
  // THE cross-check. Both routes must be pricing the same line through the
  // same computeTotals — anything that made this drift (a second bulk-discount
  // rule, a differently-capped voucher, a QRIS fee taken off a different base)
  // would show up here as a mismatched field.
  it("returns byte-identical totals to GET /api/v1/checkout for the same denomination as the only cart line", async () => {
    const uid = await makeUser("topupxcheck", "topupxcheck-pw-1", "TPXCHK");
    const { cookie, csrf } = await loginAs("topupxcheck", "topupxcheck-pw-1");
    await addToCart(prisma, uid, denomId, 1);

    const cartBased = await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } });
    const adHoc = await app.inject({
      method: "POST",
      url: "/api/v1/topup/preview",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: denomId, qty: 1 },
    });
    expect(cartBased.statusCode).toBe(200);
    expect(adHoc.statusCode).toBe(200);
    expect(adHoc.json()).toEqual(cartBased.json());
    expect(adHoc.json().subtotal).toBe(DENOM_PRICE);

    await clearCart(prisma, uid);
  });

  it("applies a voucher the same way the cart-based preview does", async () => {
    const uid = await makeUser("topupvoucher", "topupvoucher-pw-1", "TPVOUC");
    const { cookie, csrf } = await loginAs("topupvoucher", "topupvoucher-pw-1");
    await addToCart(prisma, uid, denomId, 1);

    const cartBased = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/voucher/preview",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { voucher_code: "TOPUP10" },
    });
    const adHoc = await app.inject({
      method: "POST",
      url: "/api/v1/topup/preview",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: denomId, qty: 1, voucher_code: "topup10" },
    });
    expect(adHoc.statusCode).toBe(200);
    expect(adHoc.json()).toEqual(cartBased.json());
    expect(adHoc.json().voucher_discount).toBe("4000"); // 10% of 40000
    expect(adHoc.json().total).toBe("36000");
    expect(adHoc.json().error_key).toBeNull();

    await clearCart(prisma, uid);
  });

  it("reports an unknown voucher code the same way, without pricing anything differently", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/preview",
      headers: { "x-forwarded-for": freshIp() },
      payload: { denomination_id: denomId, qty: 1, voucher_code: "NOPE" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().error_key).toBe("error.voucher_not_found");
    expect(res.json().total).toBe(DENOM_PRICE);
  });

  it("serves an anonymous visitor with is_guest true, both wallet methods off, and no cart cookie of any kind", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/preview",
      headers: { "x-forwarded-for": freshIp() },
      payload: { denomination_id: denomId, qty: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.is_guest).toBe(true);
    expect(body.wallet_idr_enabled).toBe(false);
    expect(body.wallet_usdt_enabled).toBe(false);
    expect(body.subtotal).toBe(DENOM_PRICE);
    expect(body.items).toEqual([
      { denomination_id: denomId, delivery_type: "auto", additional_fields: [], qty: 1, flash: null },
    ]);
    // Nothing about the guest cart cookie is read or written by a preview.
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("prices ONLY the requested denomination, ignoring whatever the caller's cart holds", async () => {
    const uid = await makeUser("topupignorecart", "topupignorecart-pw-1", "TPIGNC");
    const { cookie, csrf } = await loginAs("topupignorecart", "topupignorecart-pw-1");
    await addToCart(prisma, uid, denomId, 3); // 120000 worth of unrelated cart

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/preview",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: denomId, qty: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().subtotal).toBe(DENOM_PRICE); // one unit, not three
    // ...and the cart is still exactly what it was.
    expect(await getCart(prisma, uid)).toHaveLength(1);
    expect((await getCart(prisma, uid))[0]!.quantity).toBe(3);

    await clearCart(prisma, uid);
  });

  it("400s invalid_request for a missing, non-numeric, unknown or deactivated denomination_id", async () => {
    for (const payload of [
      {},
      { denomination_id: "abc" },
      { denomination_id: 0 },
      { denomination_id: -1 },
      { denomination_id: 9_999_999 },
      { denomination_id: inactiveDenomId },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/topup/preview",
        headers: { "x-forwarded-for": freshIp() },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("400s invalid_request for an out-of-range qty, and for qty > 1 on a Digiflazz SKU", async () => {
    for (const qty of [0, -1, 100, 1.5]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/topup/preview",
        headers: { "x-forwarded-for": freshIp() },
        payload: { denomination_id: denomId, qty },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_request" });
    }
    // The supplier dispatch poller can only place ONE top-up per order, so a
    // multi-unit Digiflazz order would charge for units it can never deliver.
    const digi = await app.inject({
      method: "POST",
      url: "/api/v1/topup/preview",
      headers: { "x-forwarded-for": freshIp() },
      payload: { denomination_id: digiflazzDenomId, qty: 2 },
    });
    expect(digi.statusCode).toBe(400);
    const digiOk = await app.inject({
      method: "POST",
      url: "/api/v1/topup/preview",
      headers: { "x-forwarded-for": freshIp() },
      payload: { denomination_id: digiflazzDenomId, qty: 1 },
    });
    expect(digiOk.statusCode).toBe(200);
  });

  it("429s an anonymous caller off the SAME quota the cart-based previews share", async () => {
    const ip = freshIp();
    const headers = { "x-forwarded-for": ip };
    for (let i = 0; i < CHECKOUT_PREVIEW_RATE_LIMIT_MAX; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/topup/preview",
        headers,
        payload: { denomination_id: denomId, qty: 1 },
      });
      expect(res.statusCode).toBe(200);
    }
    const capped = await app.inject({
      method: "POST",
      url: "/api/v1/topup/preview",
      headers,
      payload: { denomination_id: denomId, qty: 1 },
    });
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toEqual({ error: "error.rate_limited" });

    // One shared quota — the cart-based voucher preview is capped too, so an
    // attacker can't reset the voucher-code oracle by switching routes.
    const cartPreview = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/voucher/preview",
      headers: { ...headers, cookie: cartCookie([{ p: denomId, q: 1 }]) },
      payload: { voucher_code: "GUESS" },
    });
    expect(cartPreview.statusCode).toBe(429);

    // A signed-in shopper on that same exhausted IP is unaffected.
    await makeUser("topupthrottle", "topupthrottle-pw-1", "TPTHRO");
    const { cookie, csrf } = await loginAs("topupthrottle", "topupthrottle-pw-1");
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/v1/topup/preview",
      headers: { cookie, "x-csrf-token": csrf, "x-forwarded-for": ip },
      payload: { denomination_id: denomId, qty: 1 },
    });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json().is_guest).toBe(false);
  });

  it("403s a signed-in caller with no CSRF token (csrfOk, the one repo-wide rule)", async () => {
    await makeUser("topuppreviewcsrf", "topuppreviewcsrf-pw-1", "TPPRCS");
    const { cookie } = await loginAs("topuppreviewcsrf", "topuppreviewcsrf-pw-1");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/preview",
      headers: { cookie, "x-csrf-token": "bad" },
      payload: { denomination_id: denomId, qty: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_failed" });
  });
});

// --------------------------------------------------------------------- order
describe("POST /api/v1/topup/order — signed-in gateway branch", () => {
  it("creates the order, charges exactly what the preview quoted, and never touches the buyer's cart", async () => {
    const uid = await makeUser("topuporder", "topuporder-pw-1", "TPORDR");
    const { cookie, csrf } = await loginAs("topuporder", "topuporder-pw-1");
    // Three unrelated lines the buyer was already shopping for — the whole
    // point of N2: this purchase must leave them completely alone.
    await addToCart(prisma, uid, denomId, 3);
    const cartBefore = await getCart(prisma, uid);

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/topup/preview",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: denomId, qty: 1, voucher_code: "TOPUP10" },
    });
    expect(preview.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: denomId, qty: 1, method: "bybit", voucher_code: "TOPUP10" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["order_code", "pay_url"]);
    expect(body.pay_url).toBe(`/checkout/${body.order_code}/pay`);

    const order = await prisma.order.findFirst({
      where: { orderCode: body.order_code },
      include: { items: true },
    });
    expect(order!.userId).toBe(uid);
    expect(order!.items).toHaveLength(1);
    expect(order!.items[0]!.productId).toBe(denomId);
    // To the cent: the preview's IDR total is what the order was priced at.
    // (order.totalAmount is a USDT figure for a bybit order — compare against
    // the pre-currency-conversion subtotal/discount fields instead.)
    expect(order!.subtotalAmount.toString()).toBe(preview.json().subtotal);
    expect(order!.bulkDiscountAmount.toString()).toBe(preview.json().bulk_discount);
    expect(order!.discountAmount.toString()).toBe(preview.json().voucher_discount);
    expect(order!.totalAmount.toString()).toBe(preview.json().total_usdt);

    // The cart is byte-for-byte what it was before (createOrderDirect, unlike
    // createOrderFromCart, never clears it).
    const cartAfter = await getCart(prisma, uid);
    expect(cartAfter.map((l) => ({ p: l.productId, q: l.quantity }))).toEqual(
      cartBefore.map((l) => ({ p: l.productId, q: l.quantity })),
    );

    await clearCart(prisma, uid);
  });

  it("403s csrf_failed for a signed-in caller with no token, creating no order", async () => {
    await makeUser("topupcsrf", "topupcsrf-pw-1", "TPCSRF");
    const { cookie } = await loginAs("topupcsrf", "topupcsrf-pw-1");
    const before = await prisma.order.count();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie },
      payload: { denomination_id: denomId, qty: 1, method: "bybit" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_failed" });
    expect(await prisma.order.count()).toBe(before);
  });

  // Task 12 fix-review: this route's CSRF check is its own inline copy (the
  // "structural twin" of POST /api/v1/checkout in api.ts, per this file's
  // comment above), so it needed its own Origin/Referer defense-in-depth
  // coverage rather than inheriting csrfOk's.
  it("403s (same shape as bad token) when Origin is present but mismatched, even with a valid token, creating no order", async () => {
    await makeUser("topuporiginbad", "topuporiginbad-pw-1", "TPORGB");
    const { cookie, csrf } = await loginAs("topuporiginbad", "topuporiginbad-pw-1");
    const before = await prisma.order.count();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf, origin: "https://evil.example" },
      payload: { denomination_id: denomId, qty: 1, method: "bybit" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_failed" });
    expect(await prisma.order.count()).toBe(before);
  });

  it("201s with a valid token and no Origin/Referer header at all", async () => {
    await makeUser("topuporiginnone", "topuporiginnone-pw-1", "TPORGN");
    const { cookie, csrf } = await loginAs("topuporiginnone", "topuporiginnone-pw-1");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: denomId, qty: 1, method: "bybit" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("201s with a valid token and an Origin header matching this request's own host", async () => {
    await makeUser("topuporiginok", "topuporiginok-pw-1", "TPORGO");
    const { cookie, csrf } = await loginAs("topuporiginok", "topuporiginok-pw-1");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf, origin: "http://localhost" },
      payload: { denomination_id: denomId, qty: 1, method: "bybit" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("400s web.pay_method_unavailable for a gateway that isn't configured", async () => {
    await makeUser("topupnogw", "topupnogw-pw-1", "TPNOGW");
    const { cookie, csrf } = await loginAs("topupnogw", "topupnogw-pw-1");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: denomId, qty: 1, method: "qris" }, // no TokoPay creds here
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "web.pay_method_unavailable" });
  });

  it("400s invalid_request for a deactivated denomination, before any order exists", async () => {
    await makeUser("topupinactive", "topupinactive-pw-1", "TPINAC");
    const { cookie, csrf } = await loginAs("topupinactive", "topupinactive-pw-1");
    const before = await prisma.order.count();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: inactiveDenomId, qty: 1, method: "bybit" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
    expect(await prisma.order.count()).toBe(before);
  });

  it("rejects invalid customer_data for a manual_with_info SKU server-side, and accepts a valid set", async () => {
    await makeUser("topupinfo", "topupinfo-pw-1", "TPINFO");
    const { cookie, csrf } = await loginAs("topupinfo", "topupinfo-pw-1");

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: infoDenomId, qty: 1, method: "bybit" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatch(/^error\./);

    const blank = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: infoDenomId, qty: 1, method: "bybit", customer_data: [{ user_id: "" }] },
    });
    expect(blank.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: infoDenomId, qty: 1, method: "bybit", customer_data: [{ user_id: "1234567" }] },
    });
    expect(ok.statusCode).toBe(201);
    const order = await prisma.order.findFirst({ where: { orderCode: ok.json().order_code } });
    expect(JSON.parse(order!.customerData!)).toEqual([{ user_id: "1234567" }]);
  });

  it("enforces the same MAX_PENDING_ORDERS cap the cart-based checkout does", async () => {
    await makeUser("topupcap", "topupcap-pw-1", "TPCAPX");
    const { cookie, csrf } = await loginAs("topupcap", "topupcap-pw-1");
    for (let i = 0; i < MAX_PENDING_ORDERS; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/topup/order",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { denomination_id: denomId, qty: 1, method: "bybit" },
      });
      expect(res.statusCode).toBe(201);
    }
    const capped = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: denomId, qty: 1, method: "bybit" },
    });
    expect(capped.statusCode).toBe(400);
    expect(capped.json()).toEqual({ error: "error.too_many_pending" });
  });
});

describe("POST /api/v1/topup/order — wallet-credit branch", () => {
  it("settles synchronously against the IDR balance and answers the order page, not a pay page", async () => {
    const uid = await makeUser("topupwallet", "topupwallet-pw-1", "TPWALL");
    await prisma.user.update({ where: { id: uid }, data: { walletBalance: "100000" } });
    const { cookie, csrf } = await loginAs("topupwallet", "topupwallet-pw-1");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: denomId, qty: 1, method: "wallet_idr" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["order_code", "pay_url"]);
    // Already settled — there is no gateway page to send the buyer to.
    expect(body.pay_url).toBe(`/account/orders/${body.order_code}`);

    const order = await prisma.order.findFirst({ where: { orderCode: body.order_code } });
    expect(order!.userId).toBe(uid);
    expect(order!.totalAmount.toString()).toBe("0"); // fully covered by credit
    expect(order!.walletUsed.toString()).toBe(DENOM_PRICE);
    const after = await prisma.user.findUnique({ where: { id: uid } });
    expect(after!.walletBalance.toString()).toBe("60000"); // 100000 - 40000
  });

  it("400s error.insufficient_wallet when the balance doesn't fully cover the order", async () => {
    const uid = await makeUser("topupwalletshort", "topupwalletshort-pw-1", "TPWSHT");
    await prisma.user.update({ where: { id: uid }, data: { walletBalance: "1000" } });
    const { cookie, csrf } = await loginAs("topupwalletshort", "topupwalletshort-pw-1");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { denomination_id: denomId, qty: 1, method: "wallet_idr" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.insufficient_wallet" });
    // Rolled back — no order, and the balance is untouched.
    const after = await prisma.user.findUnique({ where: { id: uid } });
    expect(after!.walletBalance.toString()).toBe("1000");
    expect(await prisma.order.count({ where: { userId: uid } })).toBe(0);
  });
});

describe("POST /api/v1/topup/order — guest branch", () => {
  it("mints a guest user + session, hands back the CSRF token, and involves no cart cookie at all", async () => {
    const before = await countUsers();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { "x-forwarded-for": freshIp() }, // note: NO cart cookie
      payload: {
        denomination_id: denomId,
        qty: 1,
        method: "bybit",
        guest_email: "  Topup.Guest@Example.COM  ",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.pay_url).toBe(`/checkout/${body.order_code}/pay`);
    expect(typeof body.csrf_token).toBe("string");
    expect(body.csrf_token.length).toBeGreaterThan(0);
    expect(body.email_sent).toBe(false); // no SMTP configured in this suite

    expect(await countUsers()).toBe(before + 1);
    const guest = await prisma.user.findFirst({ where: { guestEmail: "topup.guest@example.com" } });
    expect(guest!.isGuest).toBe(true);
    expect(guest!.email).toBeNull();
    const order = await prisma.order.findFirst({ where: { orderCode: body.order_code } });
    expect(order!.userId).toBe(guest!.id);

    // Nothing was migrated into (or read out of) a cart: this flow has none.
    expect(await getCart(prisma, guest!.id)).toEqual([]);
    const setCookies = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
    expect(cookies.some((c) => c.startsWith(`${SHOP_COOKIE_NAME}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${CART_COOKIE}=`))).toBe(false);

    // The handed-back token really is this session's.
    const cookie = sessionCookieFrom(setCookies);
    const cancel = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${body.order_code}/cancel`,
      headers: { cookie, "x-csrf-token": body.csrf_token },
    });
    expect(cancel.statusCode).toBe(200);
  });

  it("leaves an unrelated guest cart cookie's lines intact when it mints the session", async () => {
    // establishSession migrates any cart cookie the visitor happens to carry
    // into their new account, exactly as logging in does — the lines are
    // PRESERVED (never cleared, never ordered against), which is the property
    // N2 broke.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie: cartCookie([{ p: denomId, q: 3 }]), "x-forwarded-for": freshIp() },
      payload: { denomination_id: denomId, qty: 1, method: "bybit", guest_email: "carrying.cart@example.com" },
    });
    expect(res.statusCode).toBe(201);
    const guest = await prisma.user.findFirst({ where: { guestEmail: "carrying.cart@example.com" } });
    const cart = await getCart(prisma, guest!.id);
    expect(cart).toHaveLength(1);
    expect(cart[0]!.productId).toBe(denomId);
    expect(cart[0]!.quantity).toBe(3); // all three units still there
    // ...and the order is for the ONE unit that was actually bought.
    const order = await prisma.order.findFirst({
      where: { orderCode: res.json().order_code },
      include: { items: true },
    });
    expect(order!.items).toHaveLength(1);
  });

  it("400s web.guest_email_invalid for a missing/malformed address, creating no user row", async () => {
    const before = await countUsers();
    for (const payload of [
      { denomination_id: denomId, qty: 1, method: "bybit" },
      { denomination_id: denomId, qty: 1, method: "bybit", guest_email: "" },
      { denomination_id: denomId, qty: 1, method: "bybit", guest_email: "   " },
      { denomination_id: denomId, qty: 1, method: "bybit", guest_email: "not-an-email" },
      { denomination_id: denomId, qty: 1, method: "bybit", guest_email: "no@domain" },
      { denomination_id: denomId, qty: 1, method: "bybit", guest_email: `${"a".repeat(250)}@example.com` },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/topup/order",
        headers: { "x-forwarded-for": freshIp() },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "web.guest_email_invalid" });
      expect(res.headers["set-cookie"]).toBeUndefined(); // no session minted
    }
    expect(await countUsers()).toBe(before);
  });

  it("400s web.pay_method_unavailable for a wallet method and creates no user row", async () => {
    const before = await countUsers();
    for (const method of ["wallet_idr", "wallet_usdt", "WALLET_IDR"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/topup/order",
        headers: { "x-forwarded-for": freshIp() },
        payload: { denomination_id: denomId, qty: 1, method, guest_email: "wallet.topup@example.com" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "web.pay_method_unavailable" });
    }
    expect(await countUsers()).toBe(before);
  });

  it("400s invalid_request for a deactivated denomination BEFORE minting a guest row", async () => {
    const before = await countUsers();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { "x-forwarded-for": freshIp() },
      payload: { denomination_id: inactiveDenomId, qty: 1, method: "bybit", guest_email: "dead.sku@example.com" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
    expect(await countUsers()).toBe(before);
  });

  it("hands the CSRF token back on a 4xx raised AFTER the session was minted, so the retry works", async () => {
    // `qris` needs TokoPay creds this suite never sets — the method gate throws
    // only after the guest user and session already exist.
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { "x-forwarded-for": freshIp() },
      payload: { denomination_id: denomId, qty: 1, method: "qris", guest_email: "topup.retry@example.com" },
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.json().error).toBe("web.pay_method_unavailable");
    expect(typeof failed.json().csrf_token).toBe("string");

    const cookie = sessionCookieFrom(failed.headers["set-cookie"]);
    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": failed.json().csrf_token },
      payload: { denomination_id: denomId, qty: 1, method: "bybit" },
    });
    expect(retry.statusCode).toBe(201);
    const guest = await prisma.user.findFirst({ where: { guestEmail: "topup.retry@example.com" } });
    const order = await prisma.order.findFirst({ where: { orderCode: retry.json().order_code } });
    expect(order!.userId).toBe(guest!.id);
    // The retry took the signed-in branch, so it still gets `email_sent` (keyed
    // on the buyer's row, not on who minted the session).
    expect(retry.json().email_sent).toBe(false);
  });

  it("429s once one IP exceeds the shared guest-checkout quota, before writing any row", async () => {
    const ip = freshIp();
    for (let i = 0; i < GUEST_CHECKOUT_RATE_LIMIT_MAX; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/topup/order",
        headers: { "x-forwarded-for": ip },
        payload: { denomination_id: denomId, qty: 1, method: "bybit", guest_email: `topupflood${i}@example.com` },
      });
      expect(res.statusCode).toBe(201);
    }
    const before = await countUsers();
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { "x-forwarded-for": ip },
      payload: { denomination_id: denomId, qty: 1, method: "bybit", guest_email: "topupflood-over@example.com" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "error.rate_limited" });
    expect(await countUsers()).toBe(before);
  });
});

// -------------------------------------------------------- Idempotency-Key
// Task 3: an `Idempotency-Key` header on POST /topup/order lets a
// double-tapped "Beli" button or a network retry replay the exact response
// from the first attempt instead of creating a second order — or, for a
// guest, a second orphan account. Mirrors POST /api/v1/checkout's own
// Idempotency-Key contract (api.test.ts's "Idempotency-Key (Task 1)" block,
// guest-checkout-api.test.ts's guest-branch block) on this route's cart-free
// rail. Every request below calls freshIp() so these tests can't interact
// with any other test's rate-limit budget (a future task adds rate limiting
// to this same route).
describe("POST /api/v1/topup/order — Idempotency-Key", () => {
  it("with no header, two identical requests create two separate orders (opt-in feature)", async () => {
    const uid = await makeUser("topupidemnohdr", "topupidemnohdr-pw-1", "TPINHD");
    const { cookie, csrf } = await loginAs("topupidemnohdr", "topupidemnohdr-pw-1");

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf, "x-forwarded-for": freshIp() },
      payload: { denomination_id: denomId, qty: 1, method: "bybit" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf, "x-forwarded-for": freshIp() },
      payload: { denomination_id: denomId, qty: 1, method: "bybit" },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().order_code).not.toBe(first.json().order_code);

    expect(await prisma.order.count({ where: { userId: uid } })).toBe(2);
  });

  it("signed-in: replays the exact response for a repeated request with the same key, creating exactly ONE order", async () => {
    const uid = await makeUser("topupidemreplay", "topupidemreplay-pw-1", "TPIDRP");
    const { cookie, csrf } = await loginAs("topupidemreplay", "topupidemreplay-pw-1");
    const key = "topup-idem-signedin-replay";

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf, "x-forwarded-for": freshIp(), "idempotency-key": key },
      payload: { denomination_id: denomId, qty: 1, method: "bybit" },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();
    expect(typeof firstBody.order_code).toBe("string");

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf, "x-forwarded-for": freshIp(), "idempotency-key": key },
      payload: { denomination_id: denomId, qty: 1, method: "bybit" },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(firstBody);

    expect(await prisma.order.count({ where: { userId: uid } })).toBe(1);
  });

  it("signed-in: 409s when the same key is reused with a DIFFERENT request body, without creating a second order", async () => {
    const uid = await makeUser("topupidemconflict", "topupidemconflict-pw-1", "TPIDCF");
    const { cookie, csrf } = await loginAs("topupidemconflict", "topupidemconflict-pw-1");
    const key = "topup-idem-signedin-conflict";

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf, "x-forwarded-for": freshIp(), "idempotency-key": key },
      payload: { denomination_id: denomId, qty: 1, method: "bybit" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { cookie, "x-csrf-token": csrf, "x-forwarded-for": freshIp(), "idempotency-key": key },
      payload: { denomination_id: denomId, qty: 1, method: "bybit", voucher_code: "TOPUP10" }, // different body => different hash
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "error.idempotency_key_reused" });

    expect(await prisma.order.count({ where: { userId: uid } })).toBe(1);
  });

  it("guest: a repeated request with no session cookie in either attempt creates exactly ONE guest User and ONE order, and replays the body", async () => {
    const ip = freshIp();
    const key = "topup-idem-guest-replay";
    const email = "topup.idem.replay@example.com";

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { "x-forwarded-for": ip, "idempotency-key": key },
      payload: { denomination_id: denomId, qty: 1, method: "bybit", guest_email: email },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();
    expect(typeof firstBody.order_code).toBe("string");

    // Second attempt: same key, same body, SAME lack of a session cookie —
    // simulates the client never having received the first response at all.
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { "x-forwarded-for": ip, "idempotency-key": key },
      payload: { denomination_id: denomId, qty: 1, method: "bybit", guest_email: email },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(firstBody);
    // The replay short-circuits before establishGuestTopupCustomer runs, so
    // it carries no Set-Cookie of its own.
    expect(second.headers["set-cookie"]).toBeUndefined();

    const guests = await prisma.user.findMany({ where: { guestEmail: email } });
    expect(guests).toHaveLength(1);
    const orders = await prisma.order.findMany({ where: { orderCode: firstBody.order_code } });
    expect(orders).toHaveLength(1);
    expect(orders[0]!.userId).toBe(guests[0]!.id);
  });

  it("guest: 409s when the same key is reused for a DIFFERENT request, without minting a second account", async () => {
    const ip = freshIp();
    const key = "topup-idem-guest-conflict";

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { "x-forwarded-for": ip, "idempotency-key": key },
      payload: { denomination_id: denomId, qty: 1, method: "bybit", guest_email: "topup.idem.conflict.a@example.com" },
    });
    expect(first.statusCode).toBe(201);
    const usersAfterFirst = await countUsers();

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { "x-forwarded-for": ip, "idempotency-key": key },
      payload: { denomination_id: denomId, qty: 1, method: "bybit", guest_email: "topup.idem.conflict.b@example.com" }, // different email => different hash
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "error.idempotency_key_reused" });
    // The conflict short-circuited before establishGuestTopupCustomer ran for
    // the second (different) email — no new user row was created for it.
    expect(await countUsers()).toBe(usersAfterFirst);
    const secondGuest = await prisma.user.findFirst({ where: { guestEmail: "topup.idem.conflict.b@example.com" } });
    expect(secondGuest).toBeNull();
  });
});

// Task 5: checkoutSubmitRateLimited(ip) — POST /topup/order shares ONE quota
// with POST /api/v1/checkout (see rateLimit.ts's doc comment); checked as the
// very first statement, so a 400 (deactivated denomination) below still
// counts as a hit.
describe("POST /api/v1/topup/order — rate limiting (Task 5)", () => {
  it("429s after CHECKOUT_SUBMIT_RATE_LIMIT_MAX submits from one IP, without affecting a different IP", async () => {
    const ip = freshIp();
    const headers = { "x-forwarded-for": ip };
    for (let i = 0; i < CHECKOUT_SUBMIT_RATE_LIMIT_MAX; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/topup/order",
        headers,
        payload: { denomination_id: inactiveDenomId, qty: 1, method: "bybit" },
      });
      expect(res.statusCode).toBe(400); // still under the cap (deactivated denom)
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers,
      payload: { denomination_id: inactiveDenomId, qty: 1, method: "bybit" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "error.rate_limited" });

    // A different IP has its own, unexhausted quota.
    const otherIp = freshIp();
    const unaffected = await app.inject({
      method: "POST",
      url: "/api/v1/topup/order",
      headers: { "x-forwarded-for": otherIp },
      payload: { denomination_id: inactiveDenomId, qty: 1, method: "bybit" },
    });
    expect(unaffected.statusCode).toBe(400);
    expect(unaffected.json()).toEqual({ error: "invalid_request" });
  });
});
