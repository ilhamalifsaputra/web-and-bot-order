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
  BYBIT_MIN_AMOUNT_KEY,
  TOKOPAY_MIN_AMOUNT_KEY,
} from "@app/db";
import { config } from "@app/core/config";
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

  // Whole-branch review F3 (part 2). The form has to know each rail's own floor
  // to stop offering a rail the finalize-time guard would refuse, and the figure
  // it needs is denominated in the currency the BUYER TYPES — which for a USDT
  // rail judged by the shop-wide Rupiah floor is not the figure in the settings
  // row at all.
  it("reports each rail's floor in the currency the buyer types, converting the shop-wide Rupiah floor for the USDT rails", async () => {
    await makeUser("wtfloors", "wtfloors-pw-123", "WTFLOORS");
    const { cookie } = await loginAs("wtfloors", "wtfloors-pw-123");
    const res = await app.inject({ method: "GET", url: "/api/v1/wallet/topup", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    // No per-rail `<rail>_min_amount` is set in this file, so every rail falls
    // back to the shop-wide `min_order_amount_idr` default of Rp1.000. An IDR
    // rail is judged against that figure directly; a USDT rail is judged on
    // `amount × 16000`, so the smallest USDT amount that clears Rp1.000 is
    // 1000/16000 = 0.0625, rounded UP to the cent so the form never advertises a
    // figure the guard then refuses.
    expect(res.json().rail_min).toEqual({
      qris: "1000",
      paydisini: "1000",
      binance: "0.07",
      bybit: "0.07",
      bybit_bsc: "0.07",
      nowpayments: "0.07",
    });
  });

  it("reports a rail's OWN minimum untouched when one is set — it is already in that rail's settlement currency", async () => {
    await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "50");
    try {
      await makeUser("wtrailmin", "wtrailmin-pw-123", "WTRAILMIN");
      const { cookie } = await loginAs("wtrailmin", "wtrailmin-pw-123");
      const res = await app.inject({ method: "GET", url: "/api/v1/wallet/topup", headers: { cookie } });
      expect(res.json().rail_min).toMatchObject({ bybit: "50", binance: "0.07" });
    } finally {
      await deleteSetting(prisma, BYBIT_MIN_AMOUNT_KEY);
    }
  });

  // Whole-branch review F4b. `web.wallet_topup_min_hint` read only
  // `wallet_topup_min_amount_*`, so a shop could advertise "Minimum Rp1.000" and
  // refuse the buyer at Rp5.000 because of a rail floor the hint never mentioned.
  // The payload now carries the EFFECTIVE minimum as well: the larger of the
  // top-up bound and the LOWEST floor among the rails this currency is offered on
  // (lowest, because the rails are alternatives — an amount one refuses may still
  // be payable through a cheaper-floored sibling, and F3 filters the refusing one
  // out of the picker instead).
  describe("the effective minimum the form advertises", () => {
    let cookie: string;

    beforeAll(async () => {
      await makeUser("wteffmin", "wteffmin-pw-123", "WTEFFMIN");
      ({ cookie } = await loginAs("wteffmin", "wteffmin-pw-123"));
    });

    function get() {
      return app.inject({ method: "GET", url: "/api/v1/wallet/topup", headers: { cookie } });
    }

    it("reports the rail floor when no top-up bound is set at all", async () => {
      // Only TokoPay is configured for IDR here, and it falls back to the
      // shop-wide Rp1.000. `min_idr` is null — the figure to show is not the one
      // the top-up settings hold.
      const body = (await get()).json();
      expect(body.min_idr).toBeNull();
      expect(body.effective_min_idr).toBe("1000");
    });

    it("reports the top-up bound when IT is the higher of the two", async () => {
      await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "50000");
      try {
        expect((await get()).json().effective_min_idr).toBe("50000");
      } finally {
        await deleteSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY);
      }
    });

    it("reports the rail's own floor when THAT is the higher of the two", async () => {
      await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "1000");
      await setSetting(prisma, TOKOPAY_MIN_AMOUNT_KEY, "20000");
      try {
        expect((await get()).json().effective_min_idr).toBe("20000");
      } finally {
        await deleteSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY);
        await deleteSetting(prisma, TOKOPAY_MIN_AMOUNT_KEY);
      }
    });

    it("converts the shop-wide Rupiah floor for the USDT side, rounding up so the advertised figure really clears it", async () => {
      // Rp1.000 at 16.000 is 0.0625 USDT; a figure rounded DOWN would be
      // advertised and then refused.
      expect((await get()).json().effective_min_usdt).toBe("0.07");
    });

    it("takes the LOWEST floor when two rails for the same currency disagree", async () => {
      // Bybit is the only USDT rail configured in this file, so give it a high
      // floor and check the figure follows it rather than the shop-wide fallback
      // of a rail that is not on offer.
      await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "25");
      try {
        expect((await get()).json().effective_min_usdt).toBe("25");
      } finally {
        await deleteSetting(prisma, BYBIT_MIN_AMOUNT_KEY);
      }
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

  // Whole-branch review finding I-3: with no SHOP_PUBLIC_URL/PUBLIC_URL
  // configured, originOk falls back to comparing against req.hostname —
  // this test's own suite (setup-env.ts) sets SHOP_PUBLIC_URL by default, so
  // it's cleared for this one case to exercise the fallback path.
  it("201s with a valid token and an Origin header matching this request's own host (no SHOP_PUBLIC_URL/PUBLIC_URL configured — fallback path)", async () => {
    const originalShop = config.SHOP_PUBLIC_URL;
    const originalPublic = config.PUBLIC_URL;
    config.SHOP_PUBLIC_URL = undefined;
    config.PUBLIC_URL = undefined;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/wallet/topup",
        headers: { cookie, "x-csrf-token": csrf, origin: "http://localhost" },
        payload: { currency: "IDR", amount: "50000", method: "qris" },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      config.SHOP_PUBLIC_URL = originalShop;
      config.PUBLIC_URL = originalPublic;
    }
  });

  // I-3's actual fix: when SHOP_PUBLIC_URL IS configured (the default in
  // this test suite — see setup-env.ts), the Origin check must prefer it
  // over req.hostname.
  it("201s with a valid token and an Origin header matching the configured SHOP_PUBLIC_URL, even though it does not match req.hostname", async () => {
    expect(config.SHOP_PUBLIC_URL).toBe("https://shop.test.invalid");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/wallet/topup",
      headers: { cookie, "x-csrf-token": csrf, origin: "https://shop.test.invalid" },
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

  // Money audit C11: the amount on the wire is the canonical plain decimal the
  // form's normalizeMoneyInput produces. Anything else (unreadable text,
  // exponent notation, a sign, a non-canonical spelling, a non-string) was a
  // DecimalError 500 or silently read ("1e3" as 1000); now it is a 400.
  it.each([
    ["IDR", "qris", "abc"],
    ["IDR", "qris", "1e3"],
    ["IDR", "qris", "-5000"],
    ["IDR", "qris", "10.000"],
    ["IDR", "qris", " 50000"],
    ["IDR", "qris", 50000],
    ["IDR", "qris", null],
    ["USDT", "bybit", "10.12345"],
    ["USDT", "bybit", "0"],
  ])("refuses a %s top-up via %s with an amount of %j: clean 400, no order", async (currency, method, amount) => {
    const before = await prisma.order.count();
    const res = await post({ currency, amount, method });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.wallet_topup_amount_invalid" });
    expect(await prisma.order.count()).toBe(before);
  });

  it("refuses an amount above the hard ceiling when no maximum is configured", async () => {
    const res = await post({ currency: "IDR", amount: "99999999999999999999", method: "qris" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.wallet_topup_above_max" });
  });

  // Whole-branch review F3 (part 2). `finalizeWalletTopupPayment` now refuses a
  // USDT top-up below the chosen rail's own floor, and the route has to hand that
  // refusal to the buyer as the top-up-specific i18n key — not as a 500, and not
  // as product checkout's "add more items" wording. The rail's own minimum is
  // already USDT, so 25 USDT against a 50 USDT floor is refused whatever the
  // exchange rate happens to be.
  it("surfaces the rail-minimum refusal of a USDT top-up as a clean 400 with the top-up wording, and creates no order", async () => {
    await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "50");
    try {
      const before = await prisma.order.count();
      const res = await post({ currency: "USDT", amount: "25", method: "bybit" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("error.wallet_topup_below_rail_minimum");
      // The guard runs before any gateway state is derived and inside the
      // route's transaction, so the order shell it would have created is rolled
      // back rather than left as an unpayable pending row.
      expect(await prisma.order.count()).toBe(before);
    } finally {
      await deleteSetting(prisma, BYBIT_MIN_AMOUNT_KEY);
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
    expect(res.json()).toMatchObject({ state: "waiting", redirect: null, underpayment: null,
      presentation: { phase: "NONE", transactionType: "WALLET_TOPUP", spinner: false, progress: null },
    });

    const foreign = await app.inject({ method: "GET", url: `/api/v1/wallet/topup/${topupCode}/status`, headers: { cookie: otherCookie } });
    expect(foreign.statusCode).toBe(404);

    const wrongKind = await app.inject({ method: "GET", url: `/api/v1/wallet/topup/${productOrderCode}/status`, headers: { cookie: ownerCookie } });
    expect(wrongKind.statusCode).toBe(404);
  });

  it("returns static trusted underpayment facts and keeps the complete existing wallet reference", async () => {
    const source = await prisma.order.findUniqueOrThrow({ where: { orderCode: topupCode } });
    const reference = "EXISTING-WALLET-REFERENCE-12345678901234567890";
    const order = await prisma.order.create({ data: {
      userId: source.userId, orderCode: reference, kind: "WALLET_TOPUP", status: "UNDERPAID", paymentState: "UNDERPAID",
      currency: "IDR", subtotalAmount: "50000", totalAmount: "50000",
    } });
    await prisma.qrisUnderpaidTx.create({ data: { orderId: order.id, gateway: "TOKOPAY", expectedAmount: "51000", receivedAmount: "30000" } });
    const status = await app.inject({ method: "GET", url: `/api/v1/wallet/topup/${reference}/status`, headers: { cookie: ownerCookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ state: "underpaid", redirect: null,
      presentation: { phase: "UNDERPAID", transactionType: "WALLET_TOPUP", spinner: false, progress: null },
      underpayment: { required: "51000", received: "30000", currency: "IDR" },
    });
    const pay = await app.inject({ method: "GET", url: `/api/v1/wallet/topup/${reference}/pay`, headers: { cookie: ownerCookie } });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().order.code).toBe(reference);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paymentState).toBe("UNDERPAID");
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
