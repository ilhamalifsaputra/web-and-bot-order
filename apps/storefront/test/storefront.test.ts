// Storefront catalog smoke tests — drives the Fastify app with app.inject()
// against an isolated temp DB (pattern: apps/web-admin/test/web.test.ts).
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { buildApp } from "../src/server";

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
  await prisma.stockItem.createMany({
    data: Array.from({ length: 5 }, () => ({
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

async function loginAs(identifier: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/login", payload: { identifier, password } });
  const c = res.headers["set-cookie"];
  return Array.isArray(c) ? c.join("; ") : String(c);
}

function csrfFrom(html: string): string {
  return /name="csrf_token" value="([^"]+)"/.exec(html)![1]!;
}

describe("home", () => {
  it("renders the catalog with IDR prices", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Netflix Premium 1 Bulan");
    expect(res.body).toContain("Rp40.000");
    expect(res.body).toContain("Streaming");
  });

  it("hides the USDT info when usd_idr_rate is unset", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).not.toContain("≈ $");
  });

  it("shows the derived USDT beside the IDR price once a rate is set", async () => {
    await setSetting(prisma, "usd_idr_rate", "16000");
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain("Rp40.000");
    expect(res.body).toContain("≈ $2.5"); // 40000/16000 = 2.5 (nearest 0.1)
  });
});

describe("category page — product cards only", () => {
  it("lists category products on slug URLs", async () => {
    const res = await app.inject({ method: "GET", url: `/c/${categorySlug}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Netflix Premium 1 Bulan");
    expect(res.body).toContain(`/p/${productSlug}`); // product card link
  });

  it("404s an unknown category slug", async () => {
    const res = await app.inject({ method: "GET", url: "/c/no-such-category" });
    expect(res.statusCode).toBe(404);
  });

  // Core 3-tier rule: the category grid shows PRODUCT cards (link /p/:slug,
  // starting price) and NEVER denomination rows. A multi-plan product appears
  // as ONE card; its denominations are not linked from the grid.
  it("shows product cards (not denomination rows) for a multi-plan product", async () => {
    const cat = await prisma.category.create({ data: { name: "Editing", slug: "editing-cat", sortOrder: 9 } });
    const { product, members } = await seedProduct(cat.id, "CapCut Pro", [
      { name: "1 Week", price: "10000", duration: "1 Week" },
      { name: "1 Month", price: "30000", duration: "1 Month" },
    ]);
    const [m1, m2] = members;

    const res = await app.inject({ method: "GET", url: `/c/${cat.slug}` });
    expect(res.statusCode).toBe(200);
    // One product card linking to product detail, showing the starting price.
    expect(res.body).toContain(`/p/${product.slug}`);
    expect(res.body).toContain("CapCut Pro");
    expect(res.body).toContain("Rp10.000"); // starting price = cheapest denomination
    // Denominations must NOT be rendered as their own grid cards/rows. There is
    // no denomination URL surface on a grid; the leaf is reached via /p/:slug.
    expect(res.body).not.toContain(`>1 Week<`);
    expect(res.body).not.toContain(`>1 Month<`);
    // Sanity: the denomination ids never appear as product-detail links.
    expect(res.body).not.toContain(`/p/${m1!.id}"`);
    expect(res.body).not.toContain(`/p/${m2!.id}"`);
  });

  it("renders product detail with denomination cards + Buy Now / Add To Cart", async () => {
    const cat = await prisma.category.create({ data: { name: "DetailCat", slug: "detail-cat", sortOrder: 8 } });
    const { product, members } = await seedProduct(cat.id, "Detail Product", [
      { name: "1 Week", price: "12000", duration: "1 Week" },
      { name: "1 Month", price: "32000", duration: "1 Month" },
    ]);
    const [wk, mo] = members;
    // Give the cheaper plan stock so it's selectable.
    await prisma.stockItem.create({ data: { productId: wk!.id, credentials: "a@b:c", status: "AVAILABLE" } });

    const res = await app.inject({ method: "GET", url: `/p/${product.slug}` });
    expect(res.statusCode).toBe(200);
    // Breadcrumb Home > Category > Product.
    expect(res.body).toContain("DetailCat");
    expect(res.body).toContain("Detail Product");
    // Denomination cards (radios), one per plan — NOT a dropdown.
    expect(res.body).toContain(`name="denomination_id" value="${wk!.id}"`);
    expect(res.body).toContain(`name="denomination_id" value="${mo!.id}"`);
    expect(res.body).toContain("1 Week");
    expect(res.body).toContain("1 Month");
    // Buy Now + Add To Cart buttons.
    expect(res.body).toContain("Add to cart");
    expect(res.body).toContain("Buy now");
  });

  it("renders reviews left on ANY denomination, not just the cheapest", async () => {
    // Regression: reviews are keyed by denomination, but the product detail
    // page must aggregate across every plan — a review left on a non-lead
    // (non-cheapest) denomination must still surface here.
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

    const res = await app.inject({ method: "GET", url: `/p/${product.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("great-1-month-plan");
  });

  it("aggregates the grid-card rating across every denomination, not just the cheapest", async () => {
    const cat = await prisma.category.create({ data: { name: "RatingCat", slug: "rating-cat", sortOrder: 6 } });
    const { product, members } = await seedProduct(cat.id, "Rated Product", [
      { name: "1 Week", price: "11000", duration: "1 Week" }, // cheapest — zero reviews
      { name: "1 Month", price: "31000", duration: "1 Month" }, // both reviews live here
    ]);
    const [, monthPlan] = members;
    // Two reviews (4★ + 5★ → avg 4.5) on the non-cheapest plan only. A
    // fractional average makes the rendered text unambiguous (an exact 5
    // would round-trip through the `round(1)` template filter as plain "5",
    // not "5.0", which would make this assertion pass even on the old bug —
    // ANY single review on the lead/cheapest plan would also show "5").
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

    const res = await app.inject({ method: "GET", url: `/c/${cat.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(product.name);
    // The card must show the aggregated rating (4.5, 2 reviews) rather than
    // the cheapest plan's empty (rating_count = 0) summary.
    expect(res.body).toContain("4.5");
  });

  it("renders product detail stock badge for the Netflix product", async () => {
    const res = await app.inject({ method: "GET", url: `/p/${productSlug}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Netflix Premium 1 Bulan");
    expect(res.body).toContain("Available"); // 5 > LOW_STOCK_THRESHOLD(3)
  });

  it("shows out-of-stock + restock CTA when no stock", async () => {
    const res = await app.inject({ method: "GET", url: `/p/${emptyProductSlug}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Out of stock");
    expect(res.body).toContain("Notify me when ready");
  });

  it("404s an inactive product", async () => {
    await prisma.product.update({ where: { slug: emptyProductSlug }, data: { isActive: false } });
    const res = await app.inject({ method: "GET", url: `/p/${emptyProductSlug}` });
    expect(res.statusCode).toBe(404);
    await prisma.product.update({ where: { slug: emptyProductSlug }, data: { isActive: true } });
  });

  it("404s an unknown product slug", async () => {
    const res = await app.inject({ method: "GET", url: "/p/no-such-product" });
    expect(res.statusCode).toBe(404);
  });

  it("home 'latest' shows the product card, never denominations flat", async () => {
    const { product, members } = await seedProduct(categoryId, "HomeBrand", [
      { name: "HomeBrand 7 day", price: "9000", duration: "7 day" },
      { name: "HomeBrand 1 Month", price: "29000", duration: "1 Month" },
    ]);
    const [d1, d2] = members;

    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`/p/${product.slug}`); // product card present
    expect(res.body).toContain("HomeBrand");
    expect(res.body).not.toContain(`/p/${d1!.id}"`);  // denominations not flat on home
    expect(res.body).not.toContain(`/p/${d2!.id}"`);
  });
});

describe("search + language", () => {
  it("finds products by name", async () => {
    const res = await app.inject({ method: "GET", url: "/search?q=netflix" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Netflix Premium 1 Bulan");
  });

  it("shows the empty state for no hits", async () => {
    const res = await app.inject({ method: "GET", url: "/search?q=zzz-nope" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Nothing found");
  });

  // F-01 (execution/10): a partial substring (not the whole product name) still
  // matches — searchCatalog uses a `contains` LIKE.
  it("matches a partial substring of the product name", async () => {
    const res = await app.inject({ method: "GET", url: "/search?q=remium 1 Bul" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Netflix Premium 1 Bulan");
  });

  it("switches to Indonesian via the lang cookie", async () => {
    const sw = await app.inject({ method: "GET", url: "/lang?to=id&back=/" });
    expect(sw.statusCode).toBe(303);
    const cookie = sw.headers["set-cookie"];
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { cookie: Array.isArray(cookie) ? cookie.join("; ") : String(cookie) },
    });
    expect(res.body).toContain("Produk terbaru"); // web.new_arrivals (id)
  });

  it("rejects an absolute redirect target on /lang", async () => {
    const sw = await app.inject({ method: "GET", url: "/lang?to=id&back=https://evil.example" });
    expect(sw.statusCode).toBe(303);
    expect(sw.headers.location).toBe("/");
  });

  // 3-tier rule: search returns PRODUCTS, never their plans. Searching the
  // product name yields the product card; the denominations are not surfaced.
  it("returns products (not denominations/plans) in search results", async () => {
    const { product, members } = await seedProduct(categoryId, "CapCut Search", [
      { name: "1 Week Plan", price: "9000", duration: "1 Week" },
      { name: "1 Month Plan", price: "29000", duration: "1 Month" },
    ]);
    const [d1, d2] = members;

    // Searching the product name returns the product card…
    const res = await app.inject({ method: "GET", url: "/search?q=CapCut Search" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`/p/${product.slug}`);
    expect(res.body).toContain("CapCut Search");
    // …but the denomination ids are never linked as their own results.
    expect(res.body).not.toContain(`/p/${d1!.id}"`);
    expect(res.body).not.toContain(`/p/${d2!.id}"`);
  });
});

describe("guest cart — line label + cookie versioning", () => {
  // Add a denomination to the guest cart; the cart line must read
  // `Product - Denomination ×qty` and the cookie must be the versioned v2.
  it("renders the cart line as `Product - Denomination` and sets shop_cart_v2", async () => {
    const cat = await prisma.category.create({ data: { name: "CartCat", slug: "cart-cat", sortOrder: 7 } });
    const { members } = await seedProduct(cat.id, "CapCut Pro", [{ name: "1 Month", price: "30000", duration: "1 Month" }]);
    const denomId = members[0]!.id;

    const add = await app.inject({
      method: "POST",
      url: "/cart/add",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ denomination_id: String(denomId), qty: "1" }).toString(),
    });
    expect(add.statusCode).toBe(303);
    const setCookie = add.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie);
    // New versioned cookie name; old name not (re)written.
    expect(cookieStr).toContain("shop_cart_v2=");

    const cart = await app.inject({ method: "GET", url: "/cart", headers: { cookie: cookieStr } });
    expect(cart.statusCode).toBe(200);
    expect(cart.body).toContain("CapCut Pro - 1 Month"); // Product - Denomination label
  });

  // Cutover hazard: a stale pre-rename `shop_cart` cookie (bare array, no
  // version) MUST be ignored — it can never resolve to a denomination row.
  it("ignores a legacy shop_cart cookie (no version envelope)", async () => {
    const legacy = "shop_cart=" + encodeURIComponent(JSON.stringify([{ p: productId, q: 3 }]));
    const cart = await app.inject({ method: "GET", url: "/cart", headers: { cookie: legacy } });
    expect(cart.statusCode).toBe(200);
    // The stale cookie resolved to nothing → empty cart.
    expect(cart.body).toContain("Your cart is empty");
    expect(cart.body).not.toContain("Netflix Premium 1 Bulan");
  });

  // A wrong-version envelope (e.g. a future {v:99,...}) is also ignored.
  it("ignores a cart cookie whose version != current", async () => {
    const badVer = "shop_cart_v2=" + encodeURIComponent(JSON.stringify({ v: 99, items: [{ p: productId, q: 2 }] }));
    const cart = await app.inject({ method: "GET", url: "/cart", headers: { cookie: badVer } });
    expect(cart.statusCode).toBe(200);
    expect(cart.body).toContain("Your cart is empty");
  });

  // The current v2 envelope resolves correctly.
  it("reads a current v2 cart cookie", async () => {
    const ok = "shop_cart_v2=" + encodeURIComponent(JSON.stringify({ v: 2, items: [{ p: productId, q: 2 }] }));
    const cart = await app.inject({ method: "GET", url: "/cart", headers: { cookie: ok } });
    expect(cart.statusCode).toBe(200);
    expect(cart.body).toContain("Netflix Premium 1 Bulan");
  });
});

describe("errors", () => {
  it("renders a friendly 404 page", async () => {
    const res = await app.inject({ method: "GET", url: "/definitely-not-a-page" });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("404");
  });
});

describe("favicon", () => {
  it("renders the default favicon link when none is configured", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain('rel="icon"');
    expect(res.body).toContain("/static/favicon.svg");
  });

  it("renders the configured favicon when web_favicon_url is set", async () => {
    await setSetting(prisma, "web_favicon_url", "/uploads/branding/favicon-deadbeef.png");
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain("/uploads/branding/favicon-deadbeef.png");
    await deleteSetting(prisma, "web_favicon_url");
  });
});

describe("shop logo", () => {
  it("renders the logo image in the header when web_logo_url is set", async () => {
    await setSetting(prisma, "web_logo_url", "/uploads/branding/logo-abc123.png");
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain("/uploads/branding/logo-abc123.png");
    await deleteSetting(prisma, "web_logo_url");
  });

  it("falls back to the store icon when no logo is set", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
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

  it("signs in with username + password and reaches /account", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { identifier: "WebBuyer", password: "hunter2-ok", next: "/account" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/account");
    const cookie = res.headers["set-cookie"];
    const acc = await app.inject({
      method: "GET",
      url: "/account",
      headers: { cookie: Array.isArray(cookie) ? cookie.join("; ") : String(cookie) },
    });
    expect(acc.statusCode).toBe(200);
    expect(acc.body).toContain("WEBB01");
  });

  it("rejects a wrong password with the generic message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { identifier: "webbuyer", password: "nope" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Wrong username or password");
  });

  it("rejects an unknown identifier with the SAME generic message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { identifier: "ghost", password: "nope" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Wrong username or password");
  });

  it("rejects a banned user", async () => {
    await prisma.user.update({ where: { id: pwUserId }, data: { banned: true } });
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { identifier: "webbuyer", password: "hunter2-ok" },
    });
    expect(res.statusCode).toBe(403);
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

  it("does NOT create an account for an unknown telegram id", async () => {
    const before = await prisma.user.count();
    const params = new URLSearchParams(signedTgParams(999999111));
    const res = await app.inject({ method: "GET", url: `/auth/telegram?${params}` });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("isn&#39;t registered yet");
    expect(await prisma.user.count()).toBe(before);
  });
});

describe("register", () => {
  it("renders the form", async () => {
    const res = await app.inject({ method: "GET", url: "/register" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Create account");
  });

  it("creates an account, signs in, and attributes a referral", async () => {
    await prisma.user.create({ data: { telegramId: 515151n, referralCode: "REFREG" } });
    const res = await app.inject({
      method: "POST",
      url: "/register",
      payload: {
        username: "Newbie_1",
        email: "new@user.test",
        password: "longenough",
        password2: "longenough",
        ref: "refreg",
        next: "/account",
      },
    });
    expect(res.statusCode).toBe(303);
    const row = await prisma.user.findFirst({ where: { loginUsername: "newbie_1" } });
    expect(row).not.toBeNull();
    expect(row!.telegramId).toBeNull();
    expect(row!.email).toBe("new@user.test");
    const referrer = await prisma.user.findUnique({ where: { referralCode: "REFREG" } });
    expect(row!.referredById).toBe(referrer!.id);
  });

  it("rejects bad input field by field", async () => {
    const bad = async (payload: Record<string, string>, msg: string) => {
      const res = await app.inject({ method: "POST", url: "/register", payload });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(msg);
    };
    await bad({ username: "x", email: "a@b.c", password: "longenough", password2: "longenough" }, "3");
    await bad({ username: "okname", email: "not-an-email", password: "longenough", password2: "longenough" }, "valid email");
    await bad({ username: "okname", email: "a@b.c", password: "short", password2: "short" }, "at least 8");
    await bad({ username: "okname", email: "a@b.c", password: "longenough", password2: "different1" }, "don");
  });

  it("rejects a duplicate username with a 409-style field error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/register",
      payload: { username: "newbie_1", email: "other@user.test", password: "longenough", password2: "longenough" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("taken");
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

    const real = await app.inject({ method: "POST", url: "/forgot", payload: { email: "forget@me.test" } });
    expect(real.statusCode).toBe(200);
    expect(real.body).toContain("on its way");

    const fake = await app.inject({ method: "POST", url: "/forgot", payload: { email: "ghost@no.test" } });
    expect(fake.statusCode).toBe(200);
    expect(fake.body).toContain("on its way");

    expect(sendMail).toHaveBeenCalledTimes(1);
    const text = (sendMail as ReturnType<typeof vi.fn>).mock.calls[0]![0].text as string;
    expect(text).toMatch(/\/reset\/[A-Za-z0-9_-]{40,}/);
  });

  it("resets the password with a valid token, once, and invalidates sessions", async () => {
    const { createPasswordResetToken } = await import("@app/db");
    const { verifyPassword } = await import("@app/core/password");
    const user = (await prisma.user.findFirst({ where: { email: "forget@me.test" } }))!;
    const { token } = await createPasswordResetToken(prisma, user.id);

    const form = await app.inject({ method: "GET", url: `/reset/${token}` });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain("new password");

    const res = await app.inject({
      method: "POST",
      url: `/reset/${token}`,
      payload: { password: "brandnew-99", password2: "brandnew-99" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login?reset=1");
    const updated = (await prisma.user.findUnique({ where: { id: user.id } }))!;
    expect(verifyPassword("brandnew-99", updated.passwordHash!)).toBe(true);

    const again = await app.inject({
      method: "POST",
      url: `/reset/${token}`,
      payload: { password: "another-99", password2: "another-99" },
    });
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain("invalid or has expired");
  });

  it("rejects an expired token", async () => {
    const { createPasswordResetToken } = await import("@app/db");
    const user = (await prisma.user.findFirst({ where: { email: "forget@me.test" } }))!;
    const { token } = await createPasswordResetToken(prisma, user.id, -1);
    const res = await app.inject({
      method: "POST",
      url: `/reset/${token}`,
      payload: { password: "whatever-99", password2: "whatever-99" },
    });
    expect(res.statusCode).toBe(400);
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

  it("changes the password when the current password is right", async () => {
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
    await setSetting(prisma, "bybit_deposit_address", "0xDEADBEEF00000000000000000000000000000000");
    await setSetting(prisma, "bybit_api_key", "k");
    await setSetting(prisma, "bybit_api_secret", "s");
    await setSetting(prisma, "usd_idr_rate", "16000");
  }
  async function disableBybit() {
    await deleteSetting(prisma, "bybit_deposit_address");
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

  it("pay page for a BYBIT order shows the deposit address + USDT amount", async () => {
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
    expect(res.body).toContain("0xDEADBEEF00000000000000000000000000000000");
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
    await addToCart(prisma, buyerId, productId, 1);
    const checkoutPage = await app.inject({ method: "GET", url: "/checkout", headers: { cookie } });
    expect(checkoutPage.body).toContain('value="qris"');
    expect(checkoutPage.body).toContain('value="paydisini"');
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
    await setSetting(prisma, "bybit_deposit_address", "0xDEADBEEF00000000000000000000000000000000");
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
      await deleteSetting(prisma, "bybit_deposit_address");
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

describe("hero image", () => {
  it("uses the configured hero when web_hero_url is set", async () => {
    await setSetting(prisma, "web_hero_url", "/uploads/branding/hero-cafe01.jpg");
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain("/uploads/branding/hero-cafe01.jpg");
    await deleteSetting(prisma, "web_hero_url");
  });

  it("falls back to the default hero when unset", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain("images.unsplash.com");
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
