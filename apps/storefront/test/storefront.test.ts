// Storefront smoke tests — drives the Fastify app with app.inject() against
// an isolated temp DB (pattern: apps/web-admin/test/web.test.ts). Cluster A
// (home/category/product/search/cart) cut over to the React SPA
// (docs/REACT_STOREFRONT_MIGRATION.md); this file now hits their JSON data
// twins (/api/v1/pages/*, /api/v1/cart/*) for that surface and still drives
// the Nunjucks pages directly (login/register/forgot/account/settings/
// checkout) for everything that hasn't cut over yet.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@app/core/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
// PayDisini's createTransaction hits a real gateway HTTP endpoint — mock it
// for the "pay page renders the QR" checkout test below (mirrors
// apps/order-bot/test/handlers.test.ts's TokoPay mock). verifyCallback is left
// real/untouched since this file doesn't exercise the webhook route.
vi.mock("@app/core/payments/paydisini", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/paydisini")>()),
  createTransaction: vi.fn().mockResolvedValue({
    trxId: "PD-TEST",
    qrString: "000",
    qrUrl: "https://x/paydisini-qr.png",
    checkoutUrl: "https://x/paydisini-checkout",
    totalBayar: "100",
  }),
}));
// NOWPayments' createInvoice hits a real gateway HTTP endpoint too — mock it
// for the "pay page redirects to the hosted invoice" checkout test below.
// verifyIpn is left real/untouched (exercised separately in
// nowpayments-webhook.test.ts).
vi.mock("@app/core/payments/nowpayments", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/nowpayments")>()),
  createInvoice: vi.fn().mockResolvedValue({
    invoiceId: "NP-TEST-INV-1",
    invoiceUrl: "https://x/nowpayments-invoice",
  }),
}));
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  setSetting,
  deleteSetting,
  addToCart,
  getOrderByCode,
  createCatalogProduct,
  createDenomination,
} from "@app/db";
import { OrderStatus } from "@app/core/enums";
import { buildApp } from "../src/server";
import { verifyTelegramLoginResult } from "../src/auth";
import { resetLoginAttempts } from "../src/rateLimit";

/** Seed a mid-tier Product with N denominations (the 3-tier shape). */
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
        productId: product.id, name: d.name, type: "SHARED", durationLabel: d.duration ?? "1 Month", price: d.price,
      }),
    );
  }
  return { product, members };
}

/** Seed a single-denomination product. */
async function seedLoose(categoryId: number, name: string, price: string, duration = "1 month") {
  const parent = await createCatalogProduct(prisma, { categoryId, name });
  const denom = await createDenomination(prisma, { productId: parent.id, name, type: "SHARED", durationLabel: duration, price });
  return { parent, denom };
}

let app: FastifyInstance;
let productId: number; // denomination id of the Netflix SKU
let productSlug: string; // parent product slug for /p/:slug
let categoryId: number;
let categorySlug: string;
let emptyProductId: number; // denomination id of the Spotify SKU
let emptyProductSlug: string; // its parent product slug

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Streaming", slug: "streaming", emoji: "🎬", sortOrder: 1 },
  });
  categoryId = cat.id;
  categorySlug = cat.slug;
  const netflixParent = await createCatalogProduct(prisma, {
    categoryId: cat.id,
    name: "Netflix Premium 1 Bulan",
    description: "Profil sharing, garansi penuh.",
  });
  productSlug = netflixParent.slug;
  const prod = await createDenomination(prisma, {
    productId: netflixParent.id,
    name: "Netflix Premium 1 Bulan",
    type: "SHARED",
    durationLabel: "1 month",
    price: "40000", // IDR central price (plan.md §15)
    warrantyDays: 30,
  });
  productId = prod.id;
  // Generous pool: checkout now reserves stock atomically at creation
  // (Checkout-2/Stock-1 fix), so every test in this file that completes a
  // real checkout against this shared product permanently consumes one row
  // (no per-test reset). 5 was enough when checkout only counted stock
  // without reserving it; it is not anymore.
  await prisma.stockItem.createMany({
    data: Array.from({ length: 100 }, () => ({
      productId: prod.id,
      credentials: "user@mail.com:pass",
      status: "AVAILABLE",
    })),
  });
  const empty = await seedLoose(cat.id, "Spotify Family", "25000");
  emptyProductId = empty.denom.id;
  emptyProductSlug = empty.parent.slug;
  // Storefront tests model a live shop — keep the setup gate open.
  await setSetting(prisma, "setup_completed", "true");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

// The login rate limiter is an in-process Map shared across this whole file's
// app.inject() calls (all default to the same 127.0.0.1 "IP"). This suite logs
// in far more than WEB_LOGIN_RATE_LIMIT_MAX times across its many checkout
// fixtures, so clear the IP bucket between tests (mirrors
// apps/web-admin/test/web.test.ts's beforeEach: resetLoginAttempts("127.0.0.1")).
beforeEach(() => {
  resetLoginAttempts("127.0.0.1");
});

// Auth cutover (docs/REACT_STOREFRONT_MIGRATION.md Phase 5): the HTML POST
// /login form is gone — sign in via the JSON twin instead (same
// establishSession() tail, so the Set-Cookie header is identical either way).
async function loginAs(identifier: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  const c = res.headers["set-cookie"];
  return Array.isArray(c) ? c.join("; ") : String(c);
}

function csrfFrom(html: string): string {
  return /name="csrf_token" value="([^"]+)"/.exec(html)![1]!;
}

// ---------------------------------------------------------------------------
// Cluster A cutover (docs/REACT_STOREFRONT_MIGRATION.md): GET /, /c/:slug,
// /p/:slug, /search and /cart now fall through to the React SPA shell
// (routes/spaShell.ts — its HTTP surface, incl. unknown-slug 404s, is tested
// in spa-api.test.ts and NOT duplicated here). The business logic that used
// to be proven by scraping the deleted Nunjucks pages (3-tier product/denom
// shaping, cross-denomination review/rating aggregation, stock/restock
// defaults, the guest-cart cookie contract) still lives server-side in
// pageData.ts / cart.ts, so it's re-asserted here against their JSON twins
// instead. Pure HTML/CSS rendering (price formatting, button/badge text,
// "not a denomination row" link-shape checks) is a client concern now, and is
// covered by the client jsdom tests under apps/storefront/client/src.
// ---------------------------------------------------------------------------

describe("GET /api/v1/pages/home", () => {
  it("returns the product card with its price, and its category", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/home" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.products.find((p: { slug: string }) => p.slug === productSlug)).toMatchObject({
      from_price: "40000",
    });
    expect(body.categories.some((c: { slug: string }) => c.slug === categorySlug)).toBe(true);
  });

  it("shows a multi-plan product as the product card, never its denominations flat", async () => {
    const { product, members } = await seedProduct(categoryId, "HomeBrand", [
      { name: "HomeBrand 7 day", price: "9000", duration: "7 day" },
      { name: "HomeBrand 1 Month", price: "29000", duration: "1 Month" },
    ]);
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/home" });
    const slugs = res.json().products.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain(product.slug);
    for (const d of members) expect(slugs).not.toContain(String(d.id));
  });
});

describe("GET /api/v1/pages/category/:slug — product cards only", () => {
  it("lists a category's products", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/pages/category/${categorySlug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().products.some((p: { slug: string }) => p.slug === productSlug)).toBe(true);
  });

  // Core 3-tier rule: a multi-plan product is ONE card, priced at its
  // cheapest denomination — the denominations are never their own cards.
  it("shows ONE card for a multi-plan product, priced at its cheapest denomination", async () => {
    const cat = await prisma.category.create({ data: { name: "Editing", slug: "editing-cat", sortOrder: 9 } });
    const { product } = await seedProduct(cat.id, "CapCut Pro", [
      { name: "1 Week", price: "10000", duration: "1 Week" },
      { name: "1 Month", price: "30000", duration: "1 Month" },
    ]);

    const res = await app.inject({ method: "GET", url: `/api/v1/pages/category/${cat.slug}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.products).toHaveLength(1);
    expect(body.products[0]).toMatchObject({ slug: product.slug, from_price: "10000" });
  });

  it("aggregates the grid-card rating across every denomination, not just the cheapest", async () => {
    const cat = await prisma.category.create({ data: { name: "RatingCat", slug: "rating-cat", sortOrder: 6 } });
    const { members } = await seedProduct(cat.id, "Rated Product", [
      { name: "1 Week", price: "11000", duration: "1 Week" }, // cheapest — zero reviews
      { name: "1 Month", price: "31000", duration: "1 Month" }, // both reviews live here
    ]);
    const [, monthPlan] = members;
    // Two reviews (4★ + 5★ → avg 4.5) on the non-cheapest plan only. A
    // fractional average makes this unambiguous — an exact 5 could also come
    // from the old cheapest-plan-only bug.
    for (const rating of [4, 5]) {
      const user = await prisma.user.create({
        data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
      });
      const order = await prisma.order.create({
        data: { orderCode: `ORD-${Math.random()}`, userId: user.id, subtotalAmount: "31000", totalAmount: "31000", status: "DELIVERED" },
      });
      await prisma.review.create({
        data: { userId: user.id, orderId: order.id, productId: monthPlan!.id, rating, hidden: false, comment: null },
      });
    }

    const res = await app.inject({ method: "GET", url: `/api/v1/pages/category/${cat.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().products[0]).toMatchObject({ rating: 4.5, rating_count: 2 });
  });
});

describe("GET /api/v1/pages/product/:slug", () => {
  it("returns the parent category name and real stock counts; 404s an unknown slug", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/pages/product/${productSlug}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.product.category_name).toBe("Streaming");
    expect(body.denominations[0]).toMatchObject({ available: 100, in_stock: true });

    const miss = await app.inject({ method: "GET", url: "/api/v1/pages/product/no-such-product" });
    expect(miss.statusCode).toBe(404);
  });

  // Distinct 404 path from "unknown slug" — an existing-but-deactivated product.
  it("404s an inactive product", async () => {
    await prisma.product.update({ where: { slug: emptyProductSlug }, data: { isActive: false } });
    const res = await app.inject({ method: "GET", url: `/api/v1/pages/product/${emptyProductSlug}` });
    expect(res.statusCode).toBe(404);
    await prisma.product.update({ where: { slug: emptyProductSlug }, data: { isActive: true } });
  });

  it("reports zero stock and the default restock denomination id for an empty product (Task 10 fix)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/pages/product/${emptyProductSlug}` });
    const body = res.json();
    expect(body.denominations[0]).toMatchObject({ available: 0, in_stock: false });
    expect(body.default_restock_denomination_id).toBe(emptyProductId);
  });

  it("shows one denomination entry per plan for a multi-plan product", async () => {
    const cat = await prisma.category.create({ data: { name: "DetailCat", slug: "detail-cat", sortOrder: 8 } });
    const { product, members } = await seedProduct(cat.id, "Detail Product", [
      { name: "1 Week", price: "12000", duration: "1 Week" },
      { name: "1 Month", price: "32000", duration: "1 Month" },
    ]);
    const [wk, mo] = members;
    await prisma.stockItem.create({ data: { productId: wk!.id, credentials: "a@b:c", status: "AVAILABLE" } });

    const res = await app.inject({ method: "GET", url: `/api/v1/pages/product/${product.slug}` });
    const body = res.json();
    expect(body.product.category_name).toBe("DetailCat");
    expect(body.denominations).toMatchObject([
      { id: wk!.id, name: "1 Week", price: "12000" },
      { id: mo!.id, name: "1 Month", price: "32000" },
    ]);
  });

  // Regression: reviews are keyed by denomination, but the product page must
  // aggregate across every plan — a review left on a non-cheapest denomination
  // must still surface here.
  it("returns reviews left on ANY denomination, not just the cheapest", async () => {
    const cat = await prisma.category.create({ data: { name: "ReviewCat", slug: "review-cat", sortOrder: 7 } });
    const { product, members } = await seedProduct(cat.id, "Reviewed Product", [
      { name: "1 Week", price: "11000", duration: "1 Week" }, // cheapest — zero reviews
      { name: "1 Month", price: "31000", duration: "1 Month" }, // has the only review
    ]);
    const [, monthPlan] = members;
    const user = await prisma.user.create({
      data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
    });
    const order = await prisma.order.create({
      data: { orderCode: `ORD-${Math.random()}`, userId: user.id, subtotalAmount: "31000", totalAmount: "31000", status: "DELIVERED" },
    });
    await prisma.review.create({
      data: { userId: user.id, orderId: order.id, productId: monthPlan!.id, rating: 5, hidden: false, comment: "great-1-month-plan" },
    });

    const res = await app.inject({ method: "GET", url: `/api/v1/pages/product/${product.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().reviews.some((r: { comment: string | null }) => r.comment === "great-1-month-plan")).toBe(true);
  });
});

describe("GET /api/v1/pages/search", () => {
  it("finds products by name, including a partial substring match", async () => {
    const full = await app.inject({ method: "GET", url: "/api/v1/pages/search?q=netflix" });
    expect(full.statusCode).toBe(200);
    expect(full.json().products.some((p: { slug: string }) => p.slug === productSlug)).toBe(true);

    // F-01 (execution/10): searchCatalog uses a `contains` LIKE.
    const partial = await app.inject({ method: "GET", url: "/api/v1/pages/search?q=remium 1 Bul" });
    expect(partial.json().products.some((p: { slug: string }) => p.slug === productSlug)).toBe(true);
  });

  it("returns an empty product list for no hits", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/search?q=zzz-nope" });
    expect(res.statusCode).toBe(200);
    expect(res.json().products).toHaveLength(0);
  });

  // 3-tier rule: search returns PRODUCTS, never their plans.
  it("returns products (not denominations/plans) in search results", async () => {
    const { product, members } = await seedProduct(categoryId, "CapCut Search", [
      { name: "1 Week Plan", price: "9000", duration: "1 Week" },
      { name: "1 Month Plan", price: "29000", duration: "1 Month" },
    ]);
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/search?q=CapCut Search" });
    const slugs = res.json().products.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain(product.slug);
    for (const d of members) expect(slugs).not.toContain(String(d.id));
  });
});

describe("language", () => {
  it("/lang sets the shop_lang cookie, reflected in the JSON chrome context", async () => {
    const sw = await app.inject({ method: "GET", url: "/lang?to=id&back=/" });
    expect(sw.statusCode).toBe(303);
    const cookie = sw.headers["set-cookie"];
    const cookieStr = Array.isArray(cookie) ? cookie.join("; ") : String(cookie);
    const ctx = await app.inject({ method: "GET", url: "/api/v1/pages/context", headers: { cookie: cookieStr } });
    expect(ctx.json().lang).toBe("id");
  });

  it("rejects an absolute redirect target on /lang", async () => {
    const sw = await app.inject({ method: "GET", url: "/lang?to=id&back=https://evil.example" });
    expect(sw.statusCode).toBe(303);
    expect(sw.headers.location).toBe("/");
  });
});

describe("/api/v1/cart — guest line label + cookie versioning", () => {
  // spa-api.test.ts already covers the guest add/update/remove happy path and
  // the signed-in CSRF trio; the scenarios below (the `Product - Denomination`
  // line label, legacy-cookie invalidation, version-envelope handling) are
  // unique to this file and not duplicated there.
  it("renders the cart line as `Product - Denomination` and sets shop_cart_v2", async () => {
    const cat = await prisma.category.create({ data: { name: "CartCat", slug: "cart-cat", sortOrder: 7 } });
    const { members } = await seedProduct(cat.id, "CapCut Pro", [{ name: "1 Month", price: "30000", duration: "1 Month" }]);
    const denomId = members[0]!.id;

    const add = await app.inject({ method: "POST", url: "/api/v1/cart", payload: { denomination_id: denomId, qty: 1 } });
    expect(add.statusCode).toBe(200);
    const setCookie = add.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie);
    // New versioned cookie name; old name not (re)written.
    expect(cookieStr).toContain("shop_cart_v2=");

    const cart = await app.inject({ method: "GET", url: "/api/v1/cart", headers: { cookie: cookieStr } });
    expect(cart.statusCode).toBe(200);
    expect(cart.json().items[0]).toMatchObject({ name: "CapCut Pro - 1 Month" }); // Product - Denomination label
  });

  // Cutover hazard: a stale pre-rename `shop_cart` cookie (bare array, no
  // version) MUST be ignored — it can never resolve to a denomination row.
  it("ignores a legacy shop_cart cookie (no version envelope)", async () => {
    const legacy = "shop_cart=" + encodeURIComponent(JSON.stringify([{ p: productId, q: 3 }]));
    const cart = await app.inject({ method: "GET", url: "/api/v1/cart", headers: { cookie: legacy } });
    expect(cart.statusCode).toBe(200);
    expect(cart.json().items).toHaveLength(0);
  });

  // A wrong-version envelope (e.g. a future {v:99,...}) is also ignored.
  it("ignores a cart cookie whose version != current", async () => {
    const badVer = "shop_cart_v2=" + encodeURIComponent(JSON.stringify({ v: 99, items: [{ p: productId, q: 2 }] }));
    const cart = await app.inject({ method: "GET", url: "/api/v1/cart", headers: { cookie: badVer } });
    expect(cart.statusCode).toBe(200);
    expect(cart.json().items).toHaveLength(0);
  });

  // The current v2 envelope resolves correctly.
  it("reads a current v2 cart cookie", async () => {
    const ok = "shop_cart_v2=" + encodeURIComponent(JSON.stringify({ v: 2, items: [{ p: productId, q: 2 }] }));
    const cart = await app.inject({ method: "GET", url: "/api/v1/cart", headers: { cookie: ok } });
    expect(cart.statusCode).toBe(200);
    expect(cart.json().items[0]).toMatchObject({ denomination_id: productId, qty: 2 });
  });
});

// favicon_url is shared shopContext() chrome (views/base.njk <head>), still
// rendered by every Nunjucks page that hasn't cut over — /login (chromeless
// body, but the <head> is shared) is a convenient one to prove the setting
// still flows through correctly now that GET / serves the React SPA shell
// instead (which doesn't yet apply favicon_url dynamically — see the
// migration report's Concerns).
// favicon coverage (default + web_favicon_url override) moved to
// spa-api.test.ts's "SPA shell wildcard" describe when /login cut over to the
// SPA shell (docs/REACT_STOREFRONT_MIGRATION.md Phase 5) — the shell injects
// the same <link rel="icon"> on every path, so those tests hit
// /spa-shell-probe instead of a specific page.

// logo_url renders in the shared header (base.njk's `nav` block) — /login
// overrides that block to a chromeless auth screen, so this needs a
// still-Nunjucks page that keeps the default header: /account/settings.
describe("shop logo", () => {
  let cookie: string;
  beforeAll(async () => {
    const { hashPassword } = await import("@app/core/password");
    await prisma.user.create({
      data: {
        loginUsername: "logochromeuser",
        email: "logochrome@u.test",
        passwordHash: hashPassword("logochrome-pw1"),
        referralCode: "LOGOCHR",
      },
    });
    cookie = await loginAs("logochromeuser", "logochrome-pw1");
  });

  it("renders the logo image in the header when web_logo_url is set", async () => {
    await setSetting(prisma, "web_logo_url", "/uploads/branding/logo-abc123.png");
    const res = await app.inject({ method: "GET", url: "/account/settings", headers: { cookie } });
    expect(res.body).toContain("/uploads/branding/logo-abc123.png");
    await deleteSetting(prisma, "web_logo_url");
  });

  it("falls back to the store icon when no logo is set", async () => {
    const res = await app.inject({ method: "GET", url: "/account/settings", headers: { cookie } });
    expect(res.body).not.toContain("/uploads/branding/logo-");
    expect(res.body).toContain('data-lucide="store"');
  });
});

describe("password login", () => {
  let pwUserId: number;
  beforeAll(async () => {
    const { hashPassword } = await import("@app/core/password");
    const u = await prisma.user.create({
      data: {
        telegramId: null,
        loginUsername: "webbuyer",
        email: "web@buyer.test",
        passwordHash: hashPassword("hunter2-ok"),
        referralCode: "WEBB01",
      },
    });
    pwUserId = u.id;
  });

  // Login mechanics themselves (wrong password / unknown identifier → the
  // SAME generic 403) are proven once against the JSON endpoint in
  // spa-api.test.ts ("login: wrong credentials get the generic 403 key");
  // this keeps only what that test doesn't cover: case-insensitive identifier
  // matching, and that the resulting session cookie actually works against a
  // still-Nunjucks page.
  it("signs in with a mixed-case identifier and reaches /account", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { identifier: "WebBuyer", password: "hunter2-ok", next: "/account" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().redirect).toBe("/account");
    const cookie = res.headers["set-cookie"];
    const acc = await app.inject({
      method: "GET",
      url: "/account",
      headers: { cookie: Array.isArray(cookie) ? cookie.join("; ") : String(cookie) },
    });
    expect(acc.statusCode).toBe(200);
    expect(acc.body).toContain("WEBB01");
  });

  // Not covered by spa-api.test.ts's login tests (which only exercise
  // wrong-password / unknown-identifier) — banned accounts get the same
  // generic failure so a ban can't be enumerated from the login response.
  it("rejects a banned user with the same generic failure", async () => {
    await prisma.user.update({ where: { id: pwUserId }, data: { banned: true } });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { identifier: "webbuyer", password: "hunter2-ok" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "web.login_failed" });
    await prisma.user.update({ where: { id: pwUserId }, data: { banned: false } });
  });
});

describe("telegram login is lookup-only", () => {
  function signedTgParams(id: number): Record<string, string> {
    const { createHash, createHmac } = require("node:crypto") as typeof import("node:crypto");
    const fields: Record<string, string> = {
      id: String(id),
      first_name: "Tg",
      auth_date: String(Math.floor(Date.now() / 1000)),
    };
    const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const secretKey = createHash("sha256").update(process.env.BOT_TOKEN!).digest();
    const hash = createHmac("sha256", secretKey).update(checkString).digest("hex");
    return { ...fields, hash };
  }

  it("signs in an existing bot member", async () => {
    await prisma.user.create({
      data: { telegramId: 424242n, referralCode: "TGOK42" },
    });
    const params = new URLSearchParams({ ...signedTgParams(424242), next: "/account" });
    const res = await app.inject({ method: "GET", url: `/auth/telegram?${params}` });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/account");
  });

  it("does NOT create an account for an unknown telegram id, and redirects to the React login page with err=tg_unlinked", async () => {
    const before = await prisma.user.count();
    const params = new URLSearchParams(signedTgParams(999999111));
    const res = await app.inject({ method: "GET", url: `/auth/telegram?${params}` });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login?next=%2F&err=tg_unlinked");
    expect(await prisma.user.count()).toBe(before);
  });

  // The login uses the LIVE bot token (DB `bot_token` setting wins). A payload
  // signed by a DIFFERENT bot than the one we verify with fails as "bad_hash" —
  // this is the real-world cause of a 403 after the widget bot username and the
  // configured bot token belong to different bots.
  it("accepts a payload signed with the live DB bot_token and rejects a mismatched bot", async () => {
    const { createHash, createHmac } = require("node:crypto") as typeof import("node:crypto");
    const LIVE_TOKEN = "987654:LIVE_BOT_TOKEN_xyz"; // different from env BOT_TOKEN
    const sign = (token: string) => {
      const fields: Record<string, string> = { id: "770077", first_name: "Tg", auth_date: String(Math.floor(Date.now() / 1000)) };
      const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
      const hash = createHmac("sha256", createHash("sha256").update(token).digest()).update(checkString).digest("hex");
      return { ...fields, hash };
    };
    await prisma.user.create({ data: { telegramId: 770077n, referralCode: "TGLIVE7" } });
    await setSetting(prisma, "bot_token", LIVE_TOKEN);
    try {
      // Signed by the live bot → verification (which now reads the live token) passes.
      const ok = await app.inject({ method: "GET", url: `/auth/telegram?${new URLSearchParams({ ...sign(LIVE_TOKEN), next: "/account" })}` });
      expect(ok.statusCode).toBe(303);
      expect(ok.headers.location).toBe("/account");
      // Signed by a different bot (the env token) → bad hash → redirected to
      // the React login page with err=tg_failed.
      const bad = await app.inject({ method: "GET", url: `/auth/telegram?${new URLSearchParams(sign(process.env.BOT_TOKEN!))}` });
      expect(bad.statusCode).toBe(303);
      expect(bad.headers.location).toBe("/login?next=%2F&err=tg_failed");
    } finally {
      await deleteSetting(prisma, "bot_token"); // don't leak into later tests
    }
  });

  // The rejection reason is now explicit (was an ambiguous "bad hash or stale").
  describe("verifyTelegramLoginResult reports a precise reason", () => {
    const { createHash, createHmac } = require("node:crypto") as typeof import("node:crypto");
    const TOKEN_A = "111111:botA";
    const sign = (token: string, authDateSec = Math.floor(Date.now() / 1000)) => {
      const fields: Record<string, string> = { id: "555", first_name: "Tg", auth_date: String(authDateSec) };
      const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
      const hash = createHmac("sha256", createHash("sha256").update(token).digest()).update(checkString).digest("hex");
      return { ...fields, hash };
    };
    it("ok with the matching token", () => {
      expect(verifyTelegramLoginResult(sign(TOKEN_A), TOKEN_A).ok).toBe(true);
    });
    it("bad_hash with a different bot token", () => {
      expect(verifyTelegramLoginResult(sign(TOKEN_A), "222222:botB")).toEqual({ ok: false, reason: "bad_hash" });
    });
    it("stale when auth_date is past the freshness window", () => {
      const old = Math.floor(Date.now() / 1000) - 16 * 60; // > 15 min
      expect(verifyTelegramLoginResult(sign(TOKEN_A, old), TOKEN_A)).toEqual({ ok: false, reason: "stale" });
    });
    it("malformed when required fields are missing", () => {
      expect(verifyTelegramLoginResult({ hash: "x" }, TOKEN_A)).toEqual({ ok: false, reason: "malformed" });
    });
    it("no_bot_token when no token is configured", () => {
      // Pass "" (not undefined — that would trigger the runtime-token default).
      expect(verifyTelegramLoginResult(sign(TOKEN_A), "")).toEqual({ ok: false, reason: "no_bot_token" });
    });
  });
});

// The old "login widget — live bot username, placeholder filtered" describe
// block scraped GET /login's rendered <script data-telegram-login> — dropped
// on the auth cutover (docs/REACT_STOREFRONT_MIGRATION.md Phase 5) as fully
// redundant: resolveBotUsername()'s placeholder-filtering is the SAME
// function asserted right below against /api/v1/pages/home's `bot_username`
// field, and the widget-script-presence rendering itself (script only when
// bot_username is non-empty) is covered by
// client/src/pages/LoginPage.test.tsx ("renders the telegram widget script
// only when bot_username is non-empty" / "omits the telegram widget script
// when bot_username is empty").

// Task 9 fix: HomePage.tsx only renders the Telegram contact card/link when
// `bot_username` is truthy (`{bot_username && (...)}`) — this asserts the data
// side (the .env.example placeholder resolves to "") that fix depends on. The
// rendering itself (dead-link hiding, the 1-column contact grid when both WA
// and Telegram are absent) has no dedicated client jsdom test yet — see the
// migration report's Concerns section.
describe("GET /api/v1/pages/home — bot_username resolution (Task 9 fix)", () => {
  it("resolves to an empty string when the DB setting is the .env.example placeholder", async () => {
    await setSetting(prisma, "bot_username", "YourBot");
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/home" });
    expect(res.json().bot_username).toBe("");
    await deleteSetting(prisma, "bot_username");
  });

  it("resolves to the real value when a bot username is configured", async () => {
    await setSetting(prisma, "bot_username", "realtoko_bot");
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/home" });
    expect(res.json().bot_username).toBe("realtoko_bot");
    await deleteSetting(prisma, "bot_username");
  });
});

// GET /register's form-render test was dropped on the auth cutover
// (docs/REACT_STOREFRONT_MIGRATION.md Phase 5): /register now falls to the
// SPA shell, and RegisterPage.test.tsx ("renders username/email/password/
// password2 fields") already proves the client renders the form.
describe("register", () => {
  // Not covered by spa-api.test.ts's own register test (which only checks
  // that validation failures return SOME i18n key and success signs in) —
  // referral attribution is genuine business logic, kept in full.
  it("creates an account, signs in, and attributes a referral", async () => {
    await prisma.user.create({ data: { telegramId: 515151n, referralCode: "REFREG" } });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "Newbie_1",
        email: "new@user.test",
        password: "longenough",
        password2: "longenough",
        ref: "refreg",
        next: "/account",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().redirect).toBe("/account");
    const row = await prisma.user.findFirst({ where: { loginUsername: "newbie_1" } });
    expect(row).not.toBeNull();
    expect(row!.telegramId).toBeNull();
    expect(row!.email).toBe("new@user.test");
    const referrer = await prisma.user.findUnique({ where: { referralCode: "REFREG" } });
    expect(row!.referredById).toBe(referrer!.id);
  });

  // spa-api.test.ts's register test only exercises ONE validation branch
  // (username too short) — the other three checks (email format, password
  // length, password confirmation mismatch) have no JSON-layer equivalent
  // elsewhere, so this stays as a full field-by-field trace, asserting the
  // specific i18n error KEY each branch returns instead of scraping rendered
  // English copy.
  it("rejects bad input field by field", async () => {
    const bad = async (payload: Record<string, string>, errorKey: string) => {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: errorKey });
    };
    await bad(
      { username: "x", email: "a@b.c", password: "longenough", password2: "longenough" },
      "web.register_username_invalid",
    );
    await bad(
      { username: "okname", email: "not-an-email", password: "longenough", password2: "longenough" },
      "web.register_email_invalid",
    );
    await bad(
      { username: "okname", email: "a@b.c", password: "short", password2: "short" },
      "web.register_password_short",
    );
    await bad(
      { username: "okname", email: "a@b.c", password: "longenough", password2: "different1" },
      "web.register_password_mismatch",
    );
  });

  // Unique: the ValidationError → field-error mapping (mapUniqueViolation in
  // packages/db/src/crud/webauth.ts) isn't exercised anywhere else.
  it("rejects a duplicate username with a 409-style field error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "newbie_1", email: "other@user.test", password: "longenough", password2: "longenough" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "web.register_username_taken" });
  });
});

describe("forgot + reset password", () => {
  it("always claims success, and mails only real accounts", async () => {
    const { sendMail } = await import("@app/core/mailer");
    const { hashPassword } = await import("@app/core/password");
    vi.clearAllMocks();
    await prisma.user.create({
      data: {
        loginUsername: "forgetful",
        email: "forget@me.test",
        passwordHash: hashPassword("oldpass-123"),
        referralCode: "FORG01",
      },
    });

    const real = await app.inject({ method: "POST", url: "/api/v1/auth/forgot", payload: { email: "forget@me.test" } });
    expect(real.statusCode).toBe(200);
    expect(real.json()).toEqual({ sent: true, unavailable: false });

    const fake = await app.inject({ method: "POST", url: "/api/v1/auth/forgot", payload: { email: "ghost@no.test" } });
    expect(fake.statusCode).toBe(200);
    expect(fake.json()).toEqual({ sent: true, unavailable: false });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const text = (sendMail as ReturnType<typeof vi.fn>).mock.calls[0]![0].text as string;
    expect(text).toMatch(/\/reset\/[A-Za-z0-9_-]{40,}/);
  });

  // The route's own happy-path wiring (consumePasswordResetToken →
  // setLoginCredentials → JSON redirect body) isn't exercised by
  // spa-api.test.ts (which only covers the invalid-token 400 case). Reuse
  // prevention and expired-token rejection are dropped here as redundant:
  // both are already proven directly against consumePasswordResetToken in
  // packages/db/src/crud/webauth.test.ts ("issues a token and consumes it
  // exactly once" / "rejects expired and unknown tokens") — this route is a
  // thin wrapper over that same function, and spa-api.test.ts's
  // invalid-token test proves the route maps its `null` return to the same
  // generic 400.
  it("resets the password with a valid token", async () => {
    const { createPasswordResetToken } = await import("@app/db");
    const { verifyPassword } = await import("@app/core/password");
    const user = (await prisma.user.findFirst({ where: { email: "forget@me.test" } }))!;
    const { token } = await createPasswordResetToken(prisma, user.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/auth/reset/${token}`,
      payload: { password: "brandnew-99", password2: "brandnew-99" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ redirect: "/login?reset=1" });
    const updated = (await prisma.user.findUnique({ where: { id: user.id } }))!;
    expect(verifyPassword("brandnew-99", updated.passwordHash!)).toBe(true);
  });
});

describe("account settings", () => {
  let cookie: string;
  let csrf: string;
  beforeAll(async () => {
    const { hashPassword } = await import("@app/core/password");
    await prisma.user.create({
      data: {
        loginUsername: "settingsuser",
        email: "settings@u.test",
        passwordHash: hashPassword("original-pw"),
        referralCode: "SETT01",
      },
    });
    cookie = await loginAs("settingsuser", "original-pw");
    const page = await app.inject({ method: "GET", url: "/account/settings", headers: { cookie } });
    expect(page.statusCode).toBe(200);
    csrf = csrfFrom(page.body);
  });

  it("redirects anonymous visitors to /login", async () => {
    const res = await app.inject({ method: "GET", url: "/account/settings" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("/login");
  });

  it("rejects a credentials change without CSRF", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/account/settings/credentials",
      headers: { cookie },
      payload: { email: "evil@u.test" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("changes the password when the current password is right, and rotates the session (Storefront-2 fix)", async () => {
    const { verifyPassword } = await import("@app/core/password");
    const res = await app.inject({
      method: "POST",
      url: "/account/settings/credentials",
      headers: { cookie },
      payload: {
        csrf_token: csrf,
        username: "settingsuser",
        email: "settings@u.test",
        current_password: "original-pw",
        new_password: "second-pw-99",
      },
    });
    expect(res.statusCode).toBe(303);
    const row = (await prisma.user.findFirst({ where: { loginUsername: "settingsuser" } }))!;
    expect(verifyPassword("second-pw-99", row.passwordHash!)).toBe(true);

    // The OLD cookie's jti was just rotated server-side — it must no longer
    // authenticate (any session active before this password change is dead).
    const staleCheck = await app.inject({ method: "GET", url: "/account/settings", headers: { cookie } });
    expect(staleCheck.statusCode).toBe(303);
    expect(staleCheck.headers.location).toContain("/login");

    // The response set a FRESH cookie for this same request/device, so the
    // user who just changed their own password isn't logged out by it.
    const setCookie = res.headers["set-cookie"];
    cookie = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie);
    const freshPage = await app.inject({ method: "GET", url: "/account/settings", headers: { cookie } });
    expect(freshPage.statusCode).toBe(200);
    csrf = csrfFrom(freshPage.body);
  });

  it("refuses a password change with the wrong current password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/account/settings/credentials",
      headers: { cookie },
      payload: {
        csrf_token: csrf,
        username: "settingsuser",
        email: "settings@u.test",
        current_password: "WRONG",
        new_password: "hacked-pw-99",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Current password is wrong");
  });

  // Storefront-3 (security audit, 2026-06-23): email/username are the
  // account-recovery anchor — changing them must require re-auth too, not
  // just password changes.
  it("refuses an email change without the correct current_password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/account/settings/credentials",
      headers: { cookie },
      payload: {
        csrf_token: csrf,
        username: "settingsuser",
        email: "attacker-controlled@evil.test",
        current_password: "WRONG",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Current password is wrong");
    const row = (await prisma.user.findFirst({ where: { loginUsername: "settingsuser" } }))!;
    expect(row.email).not.toBe("attacker-controlled@evil.test");
  });

  it("allows an email change with the correct current_password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/account/settings/credentials",
      headers: { cookie },
      payload: {
        csrf_token: csrf,
        username: "settingsuser",
        email: "settings-new@u.test",
        current_password: "second-pw-99",
      },
    });
    expect(res.statusCode).toBe(303);
    const row = (await prisma.user.findFirst({ where: { loginUsername: "settingsuser" } }))!;
    expect(row.email).toBe("settings-new@u.test");
  });

  it("links a Telegram account via signed widget params", async () => {
    const { createHash, createHmac } = await import("node:crypto");
    const fields: Record<string, string> = {
      id: "636363",
      first_name: "Linked",
      username: "linkedtg",
      auth_date: String(Math.floor(Date.now() / 1000)),
    };
    const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const secretKey = createHash("sha256").update(process.env.BOT_TOKEN!).digest();
    const hash = createHmac("sha256", secretKey).update(checkString).digest("hex");
    const params = new URLSearchParams({ ...fields, hash });

    const res = await app.inject({
      method: "GET",
      url: `/account/settings/link-telegram?${params}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(303);
    const row = (await prisma.user.findFirst({ where: { loginUsername: "settingsuser" } }))!;
    expect(row.telegramId).toBe(636363n);
  });

  it("refuses linking a telegramId owned by another account", async () => {
    await prisma.user.create({ data: { telegramId: 737373n, referralCode: "TAKEN7" } });
    const { createHash, createHmac } = await import("node:crypto");
    const fields: Record<string, string> = {
      id: "737373",
      auth_date: String(Math.floor(Date.now() / 1000)),
    };
    const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const secretKey = createHash("sha256").update(process.env.BOT_TOKEN!).digest();
    const hash = createHmac("sha256", secretKey).update(checkString).digest("hex");
    const params = new URLSearchParams({ ...fields, hash });
    const res = await app.inject({
      method: "GET",
      url: `/account/settings/link-telegram?${params}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(303);
    const follow = await app.inject({ method: "GET", url: res.headers.location as string, headers: { cookie } });
    expect(follow.body).toContain("already linked to another member");
    const row = (await prisma.user.findFirst({ where: { loginUsername: "settingsuser" } }))!;
    expect(row.telegramId).toBe(636363n); // unchanged
  });
});

describe("checkout — Bybit option", () => {
  let buyerId: number;
  beforeAll(async () => {
    const { hashPassword } = await import("@app/core/password");
    const u = await prisma.user.create({
      data: {
        loginUsername: "bybitbuyer",
        email: "bybit@buyer.test",
        passwordHash: hashPassword("bybit-pass-99"),
        referralCode: "BYBT01",
      },
    });
    buyerId = u.id;
  });

  async function enableBybit() {
    await setSetting(prisma, "bybit_uid", "123456789");
    await setSetting(prisma, "bybit_api_key", "k");
    await setSetting(prisma, "bybit_api_secret", "s");
    await setSetting(prisma, "usd_idr_rate", "16000");
  }
  async function disableBybit() {
    await deleteSetting(prisma, "bybit_uid");
    await deleteSetting(prisma, "bybit_api_key");
    await deleteSetting(prisma, "bybit_api_secret");
    await deleteSetting(prisma, "usd_idr_rate");
  }

  // Mirrors the storefront checkout flow: login → seed the cart → read CSRF from
  // the checkout page. Returns { cookie, csrf } with a non-empty cart.
  async function checkoutSession() {
    const cookie = await loginAs("bybitbuyer", "bybit-pass-99");
    await addToCart(prisma, buyerId, productId, 1);
    const page = await app.inject({ method: "GET", url: "/checkout", headers: { cookie } });
    return { cookie, csrf: csrfFrom(page.body) };
  }

  it("creates a BYBIT/USDT order when method=bybit and Bybit is enabled", async () => {
    await enableBybit();
    const { cookie, csrf } = await checkoutSession();
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "bybit", csrf_token: csrf }).toString(),
    });
    expect([302, 303]).toContain(res.statusCode);
    const code = res.headers.location!.split("/")[2]!; // /checkout/<code>/pay
    const order = await getOrderByCode(prisma, code);
    expect(order!.paymentMethod).toBe("BYBIT");
    expect(order!.currency).toBe("USDT");
  });

  it("pay page for a BYBIT order shows the deposit UID + USDT amount", async () => {
    await enableBybit();
    const { cookie, csrf } = await checkoutSession();
    const created = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "bybit", csrf_token: csrf }).toString(),
    });
    const code = created.headers.location!.split("/")[2]!; // /checkout/<code>/pay
    const res = await app.inject({ method: "GET", url: `/checkout/${code}/pay`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("123456789");
    expect(res.body).toContain("$"); // USDT amount shown on the Bybit card
  });

  it("rejects method=bybit when Bybit is disabled", async () => {
    await disableBybit();
    const { cookie, csrf } = await checkoutSession(); // Bybit NOT enabled here
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "bybit", csrf_token: csrf }).toString(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("checkout — Bybit BSC on-chain option (2nd Bybit method, alongside Internal Transfer)", () => {
  let buyerId: number;
  beforeAll(async () => {
    const { hashPassword } = await import("@app/core/password");
    const u = await prisma.user.create({
      data: {
        loginUsername: "bybitbscbuyer",
        email: "bybitbsc@buyer.test",
        passwordHash: hashPassword("bybitbsc-pass-99"),
        referralCode: "BYBC01",
      },
    });
    buyerId = u.id;
  });

  async function enableBybitBsc() {
    await setSetting(prisma, "bybit_bsc_deposit_address", "0xMERCHANTADDR");
    await setSetting(prisma, "bybit_api_key", "k");
    await setSetting(prisma, "bybit_api_secret", "s");
    await setSetting(prisma, "usd_idr_rate", "16000");
  }
  async function disableBybitBsc() {
    await deleteSetting(prisma, "bybit_bsc_deposit_address");
    await deleteSetting(prisma, "bybit_api_key");
    await deleteSetting(prisma, "bybit_api_secret");
    await deleteSetting(prisma, "usd_idr_rate");
    await deleteSetting(prisma, "bybit_bsc_min_amount");
  }

  async function checkoutSession() {
    const cookie = await loginAs("bybitbscbuyer", "bybitbsc-pass-99");
    await addToCart(prisma, buyerId, productId, 1);
    const page = await app.inject({ method: "GET", url: "/checkout", headers: { cookie } });
    return { cookie, csrf: csrfFrom(page.body) };
  }

  it("creates a BYBIT_BSC/USDT order when method=bybit_bsc and Bybit BSC is enabled", async () => {
    await enableBybitBsc();
    const { cookie, csrf } = await checkoutSession();
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "bybit_bsc", csrf_token: csrf }).toString(),
    });
    expect([302, 303]).toContain(res.statusCode);
    const code = res.headers.location!.split("/")[2]!; // /checkout/<code>/pay
    const order = await getOrderByCode(prisma, code);
    expect(order!.paymentMethod).toBe("BYBIT_BSC");
    expect(order!.currency).toBe("USDT");
  });

  it("pay page for a BYBIT_BSC order shows the deposit address + USDT amount + chain warning", async () => {
    await enableBybitBsc();
    const { cookie, csrf } = await checkoutSession();
    const created = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "bybit_bsc", csrf_token: csrf }).toString(),
    });
    const code = created.headers.location!.split("/")[2]!; // /checkout/<code>/pay
    const res = await app.inject({ method: "GET", url: `/checkout/${code}/pay`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("0xMERCHANTADDR");
    expect(res.body).toContain("$"); // USDT amount shown on the Bybit BSC card
  });

  it("rejects method=bybit_bsc when Bybit BSC is disabled", async () => {
    await disableBybitBsc();
    const { cookie, csrf } = await checkoutSession(); // Bybit BSC NOT enabled here
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "bybit_bsc", csrf_token: csrf }).toString(),
    });
    expect(res.statusCode).toBe(400);
  });

  it("shows the minimum-amount note on the pay page once configured, hides it when blank", async () => {
    await enableBybitBsc();
    await setSetting(prisma, "bybit_bsc_min_amount", "5");
    const { cookie, csrf } = await checkoutSession();
    const created = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "bybit_bsc", csrf_token: csrf }).toString(),
    });
    const code = created.headers.location!.split("/")[2]!;
    const withNote = await app.inject({ method: "GET", url: `/checkout/${code}/pay`, headers: { cookie } });
    expect(withNote.body).toContain("Minimum payment");

    await deleteSetting(prisma, "bybit_bsc_min_amount");
    const withoutNote = await app.inject({ method: "GET", url: `/checkout/${code}/pay`, headers: { cookie } });
    expect(withoutNote.body).not.toContain("Minimum payment");

    // Leave Bybit BSC disabled afterward — later describe blocks in this file
    // (e.g. "hides a disabled payment method") assume every USDT rail is off
    // by default, the same convention the "Bybit option" block above follows.
    await disableBybitBsc();
  });

  it.each([OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING, OrderStatus.CONFIRMED])(
    "polling partial shows 'confirming', not 'closed', once a BYBIT_BSC order is %s",
    async (status) => {
      await enableBybitBsc();
      const { cookie, csrf } = await checkoutSession();
      const created = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ method: "bybit_bsc", csrf_token: csrf }).toString(),
      });
      const code = created.headers.location!.split("/")[2]!;
      await prisma.order.update({ where: { orderCode: code }, data: { status } });

      const res = await app.inject({ method: "GET", url: `/checkout/${code}/status`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("bg-pine-tint"); // "confirming" chip styling
      expect(res.body).not.toContain("bg-sand"); // would mean it fell into the "closed" catch-all

      await disableBybitBsc();
    },
  );
});

describe("checkout — voucher preview does not create an order (Task 8 fix)", () => {
  let voucherBuyerId: number;
  let voucherCode: string;

  beforeAll(async () => {
    const { hashPassword } = await import("@app/core/password");
    const { createVoucher } = await import("@app/db");
    const { VoucherType } = await import("@app/core/enums");
    const u = await prisma.user.create({
      data: {
        loginUsername: "voucherbuyer",
        email: "voucher@buyer.test",
        passwordHash: hashPassword("voucher-pass-99"),
        referralCode: "VCHR001",
      },
    });
    voucherBuyerId = u.id;
    const v = await createVoucher(prisma, { code: "SAVE10", type: VoucherType.PERCENT, value: "10" });
    voucherCode = v.code;
  });

  async function voucherSession() {
    const cookie = await loginAs("voucherbuyer", "voucher-pass-99");
    await addToCart(prisma, voucherBuyerId, productId, 1);
    const page = await app.inject({ method: "GET", url: "/checkout", headers: { cookie } });
    return { cookie, csrf: csrfFrom(page.body) };
  }

  it("POST /checkout/voucher/preview recomputes totals but never creates an order", async () => {
    const { cookie, csrf } = await voucherSession();
    const before = await prisma.order.count({ where: { userId: voucherBuyerId } });

    const res = await app.inject({
      method: "POST",
      url: "/checkout/voucher/preview",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ voucher_code: voucherCode, csrf_token: csrf }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Voucher"); // web.voucher_discount label, applied 10% off
    const after = await prisma.order.count({ where: { userId: voucherBuyerId } });
    expect(after).toBe(before); // <-- the actual bug: this used to be before + 1
  });

  it("shows an inline error for an unknown voucher code, still without creating an order", async () => {
    const { cookie, csrf } = await voucherSession();
    const before = await prisma.order.count({ where: { userId: voucherBuyerId } });

    const res = await app.inject({
      method: "POST",
      url: "/checkout/voucher/preview",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ voucher_code: "NOPE-DOES-NOT-EXIST", csrf_token: csrf }).toString(),
    });

    expect(res.statusCode).toBe(200);
    const after = await prisma.order.count({ where: { userId: voucherBuyerId } });
    expect(after).toBe(before);
  });

  it("rejects the preview request without a valid CSRF token", async () => {
    const { cookie } = await voucherSession();
    const res = await app.inject({
      method: "POST",
      url: "/checkout/voucher/preview",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ voucher_code: voucherCode, csrf_token: "wrong" }).toString(),
    });
    expect(res.statusCode).toBe(403);
  });

  // Regression for the reviewer finding on Task 8: once Apply became
  // type="button", "Place Order" is the checkout <form>'s ONLY type="submit"
  // control, so implicit HTML form submission (pressing Enter while focused in
  // #voucher_code) would silently submit it and create a real order. Fastify's
  // .inject() can't simulate a browser's native implicit-submission or a real
  // keydown event, so this asserts the structural/JS properties that make that
  // impossible instead: exactly one type="submit" control on the page (so if
  // implicit submission ever fired, it could ONLY reach Place Order — proving
  // the DOM claim in the fix's reasoning), and that #voucher_code has a keydown
  // interceptor wired to the SAME element (#voucher_apply) that issues the
  // htmx preview request, so Enter is redirected to Apply's behavior instead.
  it("GET /checkout ships an Enter-key interceptor on #voucher_code, with Place Order as the page's only submit control", async () => {
    const { cookie } = await voucherSession();
    const res = await app.inject({ method: "GET", url: "/checkout", headers: { cookie } });
    expect(res.statusCode).toBe(200);

    const submitCount = (res.body.match(/type="submit"/g) ?? []).length;
    expect(submitCount).toBe(1); // Place Order — the only real submit button on the page

    expect(res.body).toContain('id="voucher_code"');
    expect(res.body).toContain('id="voucher_apply"');
    expect(res.body).toContain('<button type="button" id="voucher_apply"'); // Apply is never a submit button

    // The keydown interceptor: prevents native Enter-submission and re-fires
    // Apply's own htmx request instead of letting Enter reach Place Order.
    expect(res.body).toContain("getElementById('voucher_code')");
    expect(res.body).toContain("getElementById('voucher_apply')");
    expect(res.body).toContain("e.key !== 'Enter'");
    expect(res.body).toContain("e.preventDefault()");
    expect(res.body).toContain("htmx.trigger(applyBtn, 'click')");
  });
});

describe("checkout — PayDisini option (2nd IDR method, alongside TokoPay)", () => {
  let buyerId: number;
  beforeAll(async () => {
    const { hashPassword } = await import("@app/core/password");
    const u = await prisma.user.create({
      data: {
        loginUsername: "paydisinibuyer",
        email: "paydisini@buyer.test",
        passwordHash: hashPassword("paydisini-pass-99"),
        referralCode: "PYDS01",
      },
    });
    buyerId = u.id;
  });

  async function enablePaydisini() {
    await setSetting(prisma, "paydisini_userkey", "uk-test");
    await setSetting(prisma, "paydisini_apikey", "ak-test");
    await setSetting(prisma, "paydisini_default_channel", "QRIS");
  }
  async function disablePaydisini() {
    await deleteSetting(prisma, "paydisini_userkey");
    await deleteSetting(prisma, "paydisini_apikey");
    await deleteSetting(prisma, "paydisini_default_channel");
  }

  // Mirrors the storefront checkout flow: login → seed the cart → read CSRF from
  // the checkout page. Returns { cookie, csrf } with a non-empty cart.
  async function checkoutSession() {
    const cookie = await loginAs("paydisinibuyer", "paydisini-pass-99");
    await addToCart(prisma, buyerId, productId, 1);
    const page = await app.inject({ method: "GET", url: "/checkout", headers: { cookie } });
    return { cookie, csrf: csrfFrom(page.body) };
  }

  it("creates a PAYDISINI/IDR order when method=paydisini and PayDisini is enabled", async () => {
    await enablePaydisini();
    const { cookie, csrf } = await checkoutSession();
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "paydisini", csrf_token: csrf }).toString(),
    });
    expect([302, 303]).toContain(res.statusCode);
    const code = res.headers.location!.split("/")[2]!; // /checkout/<code>/pay
    const order = await getOrderByCode(prisma, code);
    expect(order!.paymentMethod).toBe("PAYDISINI");
    expect(order!.currency).toBe("IDR");
  });

  it("pay page for a PAYDISINI order renders the QR code", async () => {
    await enablePaydisini();
    const { cookie, csrf } = await checkoutSession();
    const created = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "paydisini", csrf_token: csrf }).toString(),
    });
    const code = created.headers.location!.split("/")[2]!; // /checkout/<code>/pay
    const res = await app.inject({ method: "GET", url: `/checkout/${code}/pay`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("https://x/paydisini-qr.png"); // QR image from the mocked gateway
    expect(res.body).toContain("https://x/paydisini-checkout"); // pay/checkout link

    // The TokoPay (QRIS) option remains available too — additive, not exclusive.
    // The cart is now empty (the order above consumed it), so re-seed one item
    // before re-checking the checkout page (an empty cart 303-redirects to /cart).
    // A disabled method is now HIDDEN (not greyed), so enable TokoPay to assert
    // it shows alongside PayDisini, then clean up so later tests see IDR off.
    await addToCart(prisma, buyerId, productId, 1);
    await setSetting(prisma, "tokopay_merchant_id", "m-test");
    await setSetting(prisma, "tokopay_secret", "s-test");
    try {
      const checkoutPage = await app.inject({ method: "GET", url: "/checkout", headers: { cookie } });
      expect(checkoutPage.body).toContain('value="qris"');
      expect(checkoutPage.body).toContain('value="paydisini"');
    } finally {
      await deleteSetting(prisma, "tokopay_merchant_id");
      await deleteSetting(prisma, "tokopay_secret");
    }
  });

  it("hides a disabled payment method from /checkout entirely (not greyed out)", async () => {
    // Nothing configured here → PayDisini off, TokoPay off, all USDT rails off.
    await disablePaydisini();
    const cookie = await loginAs("paydisinibuyer", "paydisini-pass-99");
    await addToCart(prisma, buyerId, productId, 1);
    const res = await app.inject({ method: "GET", url: "/checkout", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    // The radios for disabled methods must not be in the DOM at all.
    expect(res.body).not.toContain('value="paydisini"');
    expect(res.body).not.toContain('value="qris"');
    // …and the "no methods available" notice is shown instead.
    expect(res.body).toContain("No payment methods are available");
  });

  it("rejects method=paydisini when PayDisini is disabled", async () => {
    await disablePaydisini();
    const { cookie, csrf } = await checkoutSession(); // PayDisini NOT enabled here
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "paydisini", csrf_token: csrf }).toString(),
    });
    expect(res.statusCode).toBe(400);
    // The rendered page shows the TRANSLATED string for web.pay_method_unavailable,
    // not the literal key (the key only round-trips as-is for keys that are NOT
    // yet defined — see web.pay_paydisini_* above, which IS asserted literally).
    expect(res.body).toContain("isn&#39;t available right now");
  });

  // Regression for the "exactly one checked radio" cascade in checkout.njk.
  // File order (= priority, confirmed by reading the existing fallthrough
  // conditions top to bottom) is: qris/idr > paydisini > binance > bybit.
  // idr off, binance off, bybit ON, paydisini ON: PayDisini outranks Bybit, so
  // PayDisini must be the one checked — and Bybit must NOT also be checked
  // (two `checked` radios in one `name="method"` group is invalid). Before the
  // fix, bybit's condition was `not idr_enabled and not binance_enabled` (it
  // didn't exclude paydisini_enabled), so BOTH radios ended up checked here.
  it("checks exactly one radio (paydisini, not bybit) when bybit and paydisini are both enabled but idr/binance are not", async () => {
    await enablePaydisini();
    await setSetting(prisma, "bybit_uid", "123456789");
    await setSetting(prisma, "bybit_api_key", "k");
    await setSetting(prisma, "bybit_api_secret", "s");
    await setSetting(prisma, "usd_idr_rate", "16000");
    try {
      const cookie = await loginAs("paydisinibuyer", "paydisini-pass-99");
      await addToCart(prisma, buyerId, productId, 1);
      const res = await app.inject({ method: "GET", url: "/checkout", headers: { cookie } });
      expect(res.statusCode).toBe(200);

      const bybitInput = res.body.match(/<input type="radio" name="method" value="bybit"[^>]*>/)?.[0];
      const paydisiniInput = res.body.match(/<input type="radio" name="method" value="paydisini"[^>]*>/)?.[0];
      expect(bybitInput).toBeTruthy();
      expect(paydisiniInput).toBeTruthy();
      expect(paydisiniInput).toContain("checked");
      expect(bybitInput).not.toContain("checked");

      // Belt-and-suspenders: exactly one `checked` radio across the whole group.
      const checkedCount = (res.body.match(/<input type="radio" name="method"[^>]*\bchecked\b[^>]*>/g) ?? []).length;
      expect(checkedCount).toBe(1);
    } finally {
      await deleteSetting(prisma, "bybit_uid");
      await deleteSetting(prisma, "bybit_api_key");
      await deleteSetting(prisma, "bybit_api_secret");
      await deleteSetting(prisma, "usd_idr_rate");
    }
  });
});

describe("checkout — NOWPayments option (USDT hosted invoice, redirect-UX)", () => {
  let buyerId: number;
  beforeAll(async () => {
    const { hashPassword } = await import("@app/core/password");
    const u = await prisma.user.create({
      data: {
        loginUsername: "nowpaymentsbuyer",
        email: "nowpayments@buyer.test",
        passwordHash: hashPassword("nowpayments-pass-99"),
        referralCode: "NOWP01",
      },
    });
    buyerId = u.id;
  });

  async function enableNowpayments() {
    await setSetting(prisma, "nowpayments_api_key", "ak-test");
    await setSetting(prisma, "nowpayments_ipn_secret", "ipn-secret-test");
    await setSetting(prisma, "nowpayments_pay_currency", "usdttrc20");
    await setSetting(prisma, "usd_idr_rate", "16000");
  }
  async function disableNowpayments() {
    await deleteSetting(prisma, "nowpayments_api_key");
    await deleteSetting(prisma, "nowpayments_ipn_secret");
    await deleteSetting(prisma, "nowpayments_pay_currency");
    await deleteSetting(prisma, "usd_idr_rate");
  }

  // Mirrors the storefront checkout flow: login → seed the cart → read CSRF from
  // the checkout page. Returns { cookie, csrf } with a non-empty cart.
  async function checkoutSession() {
    const cookie = await loginAs("nowpaymentsbuyer", "nowpayments-pass-99");
    await addToCart(prisma, buyerId, productId, 1);
    const page = await app.inject({ method: "GET", url: "/checkout", headers: { cookie } });
    return { cookie, csrf: csrfFrom(page.body) };
  }

  it("creates a NOWPAYMENTS/USDT order when method=nowpayments and NOWPayments is enabled", async () => {
    await enableNowpayments();
    const { cookie, csrf } = await checkoutSession();
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "nowpayments", csrf_token: csrf }).toString(),
    });
    expect([302, 303]).toContain(res.statusCode);
    const code = res.headers.location!.split("/")[2]!; // /checkout/<code>/pay
    const order = await getOrderByCode(prisma, code);
    expect(order!.paymentMethod).toBe("NOWPAYMENTS");
    expect(order!.currency).toBe("USDT");
  });

  it("pay page for a NOWPAYMENTS order redirects to the hosted invoice + caches the tagged paymentRef", async () => {
    await enableNowpayments();
    const { cookie, csrf } = await checkoutSession();
    const created = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "nowpayments", csrf_token: csrf }).toString(),
    });
    const code = created.headers.location!.split("/")[2]!; // /checkout/<code>/pay
    const res = await app.inject({ method: "GET", url: `/checkout/${code}/pay`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("https://x/nowpayments-invoice"); // hosted invoice link from the mocked gateway

    // The cached paymentRef MUST carry the gateway: "nowpayments" discriminator
    // tag — the bot's reconcile poller (nowpaymentsReconcile.ts extractInvoiceId)
    // reads this exact tagged JSON to find the invoice id.
    const order = await getOrderByCode(prisma, code);
    const cached = JSON.parse(order!.paymentRef!) as Record<string, unknown>;
    expect(cached.gateway).toBe("nowpayments");
    expect(cached.invoiceId).toBe("NP-TEST-INV-1");
    expect(cached.invoiceUrl).toBe("https://x/nowpayments-invoice");
  });

  it("rejects method=nowpayments when NOWPayments is disabled", async () => {
    await disableNowpayments();
    const { cookie, csrf } = await checkoutSession(); // NOWPayments NOT enabled here
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "nowpayments", csrf_token: csrf }).toString(),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects method=nowpayments when the USD/IDR rate is unset (USDT conversion needs it)", async () => {
    await enableNowpayments();
    await deleteSetting(prisma, "usd_idr_rate"); // creds present, but no rate
    const { cookie, csrf } = await checkoutSession();
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ method: "nowpayments", csrf_token: csrf }).toString(),
    });
    expect(res.statusCode).toBe(400);
  });
});

// Rendering (a custom <img> vs. the brand-gradient fallback) is a client
// concern in HomePage.tsx — its jsdom test only covers hero_image: null, so
// the truthy branch isn't independently rendering-tested (see the migration
// report's Concerns section). Only the data pass-through is asserted here.
describe("GET /api/v1/pages/home — hero image", () => {
  it("returns the configured hero image url, or null when unset", async () => {
    await setSetting(prisma, "web_hero_url", "/uploads/branding/hero-cafe01.jpg");
    const withHero = await app.inject({ method: "GET", url: "/api/v1/pages/home" });
    expect(withHero.json().hero_image).toBe("/uploads/branding/hero-cafe01.jpg");
    await deleteSetting(prisma, "web_hero_url");

    const withoutHero = await app.inject({ method: "GET", url: "/api/v1/pages/home" });
    expect(withoutHero.json().hero_image).toBeNull();
  });
});

describe("storefront setup gate", () => {
  it("shows a 'shop not active yet' page while setup is pending", async () => {
    await deleteSetting(prisma, "setup_completed"); // no admin password in this DB
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain("belum aktif");
    } finally {
      await setSetting(prisma, "setup_completed", "true"); // restore for other tests
    }
  });

  it("still serves /healthz while setup is pending", async () => {
    await deleteSetting(prisma, "setup_completed");
    try {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
    } finally {
      await setSetting(prisma, "setup_completed", "true");
    }
  });
});
