// Storefront smoke tests — drives the Fastify app with app.inject() against
// an isolated temp DB (pattern: apps/web-admin/test/web.test.ts). Clusters A-C
// (home/category/product/search/cart, auth, checkout/pay) cut over to the
// React SPA (docs/REACT_STOREFRONT_MIGRATION.md); this file now hits their
// JSON data twins (/api/v1/*) for that surface and still drives the Nunjucks
// pages directly (account/settings/orders) for everything that hasn't cut
// over yet.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@app/core/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  setSetting,
  deleteSetting,
  createCatalogProduct,
  createDenomination,
  setFlashSale,
} from "@app/db";
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

// The three browse-all shelves the mobile nav drawer links to. They share the
// card shaper with home/category/search, so what's asserted here is the
// selection each one makes — not the card shape, which is proven above.
describe("GET /api/v1/pages/products, /categories and /flash", () => {
  it("lists the whole catalog on /products, as product cards", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/products" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.products.some((p: { slug: string }) => p.slug === productSlug)).toBe(true);
    expect(body).toHaveProperty("low_threshold");
  });

  it("lists the active categories on /categories", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/categories" });
    expect(res.statusCode).toBe(200);
    expect(res.json().categories.some((c: { slug: string }) => c.slug === categorySlug)).toBe(true);
  });

  it("returns only products on sale from /flash, and flags the context while one runs", async () => {
    // No sale seeded yet: the shelf is empty and the drawer's entry stays hidden.
    const before = await app.inject({ method: "GET", url: "/api/v1/pages/flash" });
    expect(before.statusCode).toBe(200);
    expect(before.json().products).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/v1/pages/context" })).json().flash_active).toBe(false);

    const cat = await prisma.category.create({ data: { name: "FlashCat", slug: "flash-cat", sortOrder: 12 } });
    const { product, members } = await seedProduct(cat.id, "Flash Product", [
      { name: "1 Month", price: "50000", duration: "1 Month" },
    ]);
    await setFlashSale(prisma, {
      denominationId: members[0]!.id,
      discountPercent: "25",
      startsAt: new Date(Date.now() - 3600_000),
      endsAt: new Date(Date.now() + 3600_000),
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/pages/flash" });
    const slugs = res.json().products.map((p: { slug: string }) => p.slug);
    expect(slugs).toEqual([product.slug]);
    // Not everything in the catalog — only what's actually discounted.
    expect(slugs).not.toContain(productSlug);
    expect((await app.inject({ method: "GET", url: "/api/v1/pages/context" })).json().flash_active).toBe(true);
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

describe("static assets — cache headers + compression (Group C, SEO plan)", () => {
  // STATIC_DIR only (server.ts) — Vite content-hashes the built SPA's asset
  // filenames, so a 1-year immutable cache is safe; UPLOADS_DIR deliberately
  // gets none of this (product photos are admin-replaceable at a stable URL).
  it("serves a /static/* asset with a 1-year immutable cache-control header", async () => {
    const res = await app.inject({ method: "GET", url: "/static/favicon.svg" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.headers["cache-control"]).toContain("max-age=31536000");
  });

  // @fastify/compress only engages above its default 1024-byte threshold, so
  // this hits static/app.css (6.6KB, a real committed file — not the
  // content-hashed shop-app/assets/* whose filenames change every build) to
  // stay above that floor. Confirmed empirically against light-my-request:
  // app.inject() does exercise the real compress hook (verified against
  // @fastify/compress's own test suite, which asserts the same way).
  it("compresses a large static response when the client sends Accept-Encoding: gzip", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/static/app.css",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
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

// logo_url used to render in the shared Nunjucks header (base.njk's `nav`
// block); /account/settings was the last still-Nunjucks page that kept the
// default header, and it fell to the SPA shell on the account-area cutover
// (docs/REACT_STOREFRONT_MIGRATION.md Phase 7). The React Layout component
// now reads logo_url from GET /api/v1/pages/context instead of the server
// rendering it into HTML — see that describe block in spa-api.test.ts for
// the migrated setting-flows-through / fallback-to-empty-string coverage.
// (The <img>-vs-store-icon rendering choice itself is a client concern with
// no dedicated Layout jsdom test yet — same kind of gap already called out
// for HomePage's hero image, see the "hero image" describe below.)

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
  // matching, and that the resulting session cookie actually authenticates.
  // Used to follow up with GET /account (still-Nunjucks at the time) and
  // scrape the rendered referral code; /account fell to the SPA shell on the
  // account-area cutover (docs/REACT_STOREFRONT_MIGRATION.md Phase 7), so
  // this now proves the cookie works against its JSON twin instead.
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
      url: "/api/v1/account",
      headers: { cookie: Array.isArray(cookie) ? cookie.join("; ") : String(cookie) },
    });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().referral_code).toBe("WEBB01");
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
        fullName: "Newbie One",
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
    expect(row!.fullName).toBe("Newbie One");
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
    await bad(
      { username: "okname", email: "a@b.c", password: "longenough", password2: "longenough" },
      "web.register_fullname_invalid",
    );
  });

  // Unique: the ValidationError → field-error mapping (mapUniqueViolation in
  // packages/db/src/crud/webauth.ts) isn't exercised anywhere else.
  it("rejects a duplicate username with a 409-style field error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "newbie_1",
        email: "other@user.test",
        password: "longenough",
        password2: "longenough",
        fullName: "Other Person",
      },
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
    const call = (sendMail as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { text: string; html: string };
    expect(call.text).toMatch(/\/reset\/[A-Za-z0-9_-]{40,}/);
    // The visual HTML upgrade (packages/core/src/email) rides alongside the
    // bilingual plain-text fallback, not instead of it — sendMail always gets
    // both.
    expect(call.html).toEqual(expect.any(String));
    expect(call.html.length).toBeGreaterThan(0);
  });

  it("doesn't crash when the request carries no User-Agent header", async () => {
    const { sendMail } = await import("@app/core/mailer");
    vi.clearAllMocks();

    // light-my-request defaults to a synthetic "lightMyRequest" User-Agent
    // unless the header is explicitly set to `undefined` — do that here so
    // req.headers["user-agent"] is genuinely undefined, exercising the same
    // path a client that strips the header hits.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot",
      payload: { email: "forget@me.test" },
      headers: { "user-agent": undefined },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true, unavailable: false });
    expect(sendMail).toHaveBeenCalledTimes(1);
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

// Account-area cutover (docs/REACT_STOREFRONT_MIGRATION.md Phase 7): every
// account.ts/settings.ts HTML handler except GET /account/settings/
// link-telegram is gone (that one survives — the Telegram widget redirects
// the whole page, so it can't be an XHR). The dropped tests below are all
// redundant with existing coverage:
//   - "redirects anonymous visitors to /login" → spa-api.test.ts's
//     "/api/v1/account twins" > "reads 401 anonymously" already loops over
//     /api/v1/account/settings.
//   - "rejects a credentials change without CSRF" / the wrong-current-
//     password / correct-password-changes-and-rotates-session tests →
//     spa-api.test.ts's "settings credentials: ..." test (extended below
//     with the missing-CSRF case and the stale-old-cookie-401 assertion
//     this file used to make).
//   - the email-change-requires-reauth pair (Storefront-3 fix) → migrated
//     verbatim (as JSON assertions) into the same spa-api.test.ts test.
describe("account settings — link-telegram (survives the cutover)", () => {
  let cookie: string;
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
    expect(res.headers.location).toBe("/account/settings?linked=1");
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
    // Used to follow the redirect and scrape settings.njk's rendered English
    // copy; that page is now the SPA shell, and the client-side flash from
    // ?err=tg_taken is proven in SettingsPage.test.tsx ("shows the tg_taken
    // error for ?err=tg_taken") — assert the redirect contract itself here.
    expect(res.headers.location).toBe("/account/settings?err=tg_taken");
    const row = (await prisma.user.findFirst({ where: { loginUsername: "settingsuser" } }))!;
    expect(row.telegramId).toBe(636363n); // unchanged
  });
});

// Cluster C cutover (docs/REACT_STOREFRONT_MIGRATION.md): the HTML/HTMX
// checkout + pay pages are gone (GET/POST /checkout, POST
// /checkout/voucher/preview, GET /checkout/:code/pay, GET
// /checkout/:code/status, POST /checkout/:code/cancel). The five describe
// blocks that used to drive them ("checkout — Bybit option", "... Bybit BSC
// ...", "... voucher preview does not create an order (Task 8 fix)", "...
// PayDisini option ...", "... NOWPayments option ...") were migrated to
// spa-api.test.ts's "/api/v1/checkout + orders" section (business-logic/data
// assertions against the JSON twins) or to CheckoutPage.test.tsx/
// PayPage.test.tsx (pure HTML/DOM rendering, e.g. which radio is checked by
// default, the Enter-key voucher interceptor, translated error strings) — see
// .superpowers/sdd/spa-c2-report.md's per-test table for the full mapping.
// The three payment webhooks (routes/checkout.ts) and their test files are
// untouched by this cutover.

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
      // The React SetupPendingPage renders client-side; the server response is the
      // SPA shell with a `setup-pending` meta tag (main.tsx reads it to mount the
      // page directly) plus a server-rendered seo-shell body for crawlers/no-JS —
      // no `shop_lang` cookie is set here, so it's in the default (English) locale.
      expect(res.body).toContain('<meta name="setup-pending" content="true">');
      expect(res.body).toContain("Shop not active yet");
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
