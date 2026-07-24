// React-SPA JSON layer tests (/api/v1/pages, /api/v1/auth, cart/checkout/
// account twins) + the SPA shell wildcard. Pattern: api.test.ts — app.inject()
// against an isolated temp DB; the happy/auth-fail/bad-csrf trio per mutating
// endpoint (CLAUDE.md).
//
// NOTE: the shell tests read apps/storefront/static/shop-app/index.html — run
// `pnpm --filter @app/storefront-client build` first (same contract as the
// web-admin dashboard SPA).
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// PayDisini's createTransaction hits a real gateway HTTP endpoint — mock it
// for the PAYDISINI pay-view test below (mirrors the mock that lived in
// storefront.test.ts before the cluster-C cutover moved the checkout tests
// here). verifyCallback is left real/untouched — the webhook route is
// exercised separately in paydisini-webhook.test.ts.
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
// for the tagged-paymentRef caching test below. verifyIpn is left
// real/untouched (exercised separately in nowpayments-webhook.test.ts).
vi.mock("@app/core/payments/nowpayments", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/nowpayments")>()),
  createInvoice: vi.fn().mockResolvedValue({
    invoiceId: "NP-TEST-INV-1",
    invoiceUrl: "https://x/nowpayments-invoice",
  }),
}));
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  setSetting,
  deleteSetting,
  createCatalogProduct,
  createDenomination,
  createVoucher,
  upsertBulkPricing,
  deleteBulkPricing,
  addToCart,
  clearCart,
  getOrderByCode,
  updateDenomination,
  setFlashSale,
  clearFlashSale,
} from "@app/db";
import { DeliveryType, OrderStatus, VoucherType } from "@app/core/enums";
import { AdditionalFieldType, type AdditionalField } from "@app/core/deliveryFields";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let categorySlug: string;
let productSlug: string;
let denomId: number;

/** Sign in via the JSON endpoint, then scrape the CSRF token from the SPA
 * shell's <meta name="csrf-token"> — the exact wiring the React client uses. */
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

// 1x1 PNG, same constant as apps/web-admin/test/branding.test.ts.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Builds a multipart/form-data payload for app.inject — text fields plus
 * zero or more files (ticket attachments send several files all under the
 * "attachments" field name, so this takes an array rather than one file). */
function multipart(
  fields: Record<string, string>,
  files: Array<{ field: string; filename: string; contentType: string; content: Buffer }> = [],
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----vitest" + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
      ),
    );
    chunks.push(file.content, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Streaming", slug: "streaming", emoji: "🎬", sortOrder: 1 },
  });
  categorySlug = cat.slug;
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Netflix Premium" });
  productSlug = product.slug;
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "1 Month",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "40000",
  });
  denomId = denom.id;
  // Generous pool: checkout reserves stock atomically at order creation
  // (Checkout-2/Stock-1 fix), so every test in this file that completes a
  // real checkout against this shared product permanently consumes one row
  // (no per-test reset). The cluster-C cutover moved several real-checkout
  // tests here from storefront.test.ts, so 5 rows is no longer enough.
  await prisma.stockItem.createMany({
    data: Array.from({ length: 40 }, () => ({
      productId: denomId,
      credentials: "user@mail.com:pass",
      status: "AVAILABLE",
    })),
  });
  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "SPA Test Shop");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

// ---------------------------------------------------------------- SPA shell
describe("SPA shell wildcard", () => {
  it("serves the shell with an empty CSRF meta and the request language for anonymous visitors", async () => {
    const res = await app.inject({ method: "GET", url: "/spa-shell-probe" });
    expect(res.statusCode).toBe(404); // unknown path → real 404 status, SPA error visuals
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('name="csrf-token" content=""');
    expect(res.body).toContain('<html lang="en">');
    expect(res.body).toContain("<title>404 — SPA Test Shop</title>");
  });

  it("respects the shop_lang cookie in the <html lang> substitution", async () => {
    const res = await app.inject({ method: "GET", url: "/spa-shell-probe", headers: { cookie: "shop_lang=id" } });
    expect(res.body).toContain('<html lang="id">');
  });

  it("injects the session CSRF token for signed-in visitors", async () => {
    await makeUser("shelluser", "shell-pw-123", "SHELLREF");
    const { csrf } = await loginAs("shelluser", "shell-pw-123");
    expect(csrf.length).toBeGreaterThan(10);
  });

  it("404s /api/* misses as JSON, not the HTML shell", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/no-such-endpoint" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("returns a real 404 (with SPA error visuals) for an unknown category slug", async () => {
    const res = await app.inject({ method: "GET", url: "/c/no-such-category" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<title>404 — SPA Test Shop</title>");
  });

  it("returns a real 404 (with SPA error visuals) for an unknown product slug", async () => {
    const res = await app.inject({ method: "GET", url: "/p/no-such-product" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<title>404 — SPA Test Shop</title>");
  });

  it("200s a known product slug with the product name in <title> and an og:title meta", async () => {
    const res = await app.inject({ method: "GET", url: `/p/${productSlug}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<title>Netflix Premium — SPA Test Shop</title>");
    expect(res.body).toContain('<meta property="og:title" content="Netflix Premium">');
  });

  // The nav drawer's three browse-all shelves. These live in KNOWN_PATHS, so
  // the regression they guard against is a 404 on refresh: the React route
  // table alone doesn't make a URL real to the server.
  it("200s the browse-all shelves with an indexable heading, not a 404", async () => {
    for (const [path, heading] of [
      ["/products", "All products"],
      ["/categories", "Categories"],
      ["/flash", "Flash sale"],
    ] as const) {
      const res = await app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain(`<title>${heading} — SPA Test Shop</title>`);
      expect(res.body).toContain(`<h1>${heading}</h1>`);
    }
  });

  it("gives a crawler real links into the catalog from /products and /categories", async () => {
    const products = await app.inject({ method: "GET", url: "/products" });
    expect(products.body).toContain(`href="/p/${productSlug}"`);
    const categories = await app.inject({ method: "GET", url: "/categories" });
    expect(categories.body).toContain(`href="/c/${categorySlug}"`);
  });

  // Parity with the deleted base.njk, which rendered a <link rel="icon"> on
  // every page (web_favicon_url setting, default /static/favicon.svg —
  // shopContext() in ../src/shop.ts).
  it("injects the default favicon link when web_favicon_url is unset", async () => {
    const res = await app.inject({ method: "GET", url: "/spa-shell-probe" });
    expect(res.body).toContain('<link rel="icon" href="/static/favicon.svg">');
  });

  it("injects the configured favicon link when web_favicon_url is set", async () => {
    try {
      await setSetting(prisma, "web_favicon_url", "/uploads/branding/favicon-x.svg");
      const res = await app.inject({ method: "GET", url: "/spa-shell-probe" });
      expect(res.body).toContain('<link rel="icon" href="/uploads/branding/favicon-x.svg">');
    } finally {
      await deleteSetting(prisma, "web_favicon_url");
    }
  });

  // A shop_name containing a $-pattern (`$&`, `` $` ``, `$'`, ...) is
  // interpreted specially by String.replace's string-replacement form —
  // spaShell.ts must use the function form so the substitution is inserted
  // literally instead of corrupting the HTML (e.g. `$&` re-inserting the
  // matched placeholder, or `$'` duplicating everything after it).
  it("treats an admin-controlled shop_name containing $-pattern characters as a literal string", async () => {
    try {
      await setSetting(prisma, "shop_name", "Shop $& Corp");
      const res = await app.inject({ method: "GET", url: "/account" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("Shop $&amp; Corp"); // literal $&, & itself esc()'d
      expect((res.body.match(/<div id="root">/g) ?? []).length).toBe(1);
    } finally {
      await setSetting(prisma, "shop_name", "SPA Test Shop");
    }
  });

  // Auth cutover (docs/REACT_STOREFRONT_MIGRATION.md Phase 5): /login,
  // /register, /forgot, /reset/:token now fall to this same wildcard —
  // titles come from spaShell.ts's TITLE_KEYS table.
  it("200s GET /login with the login title", async () => {
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Sign in — SPA Test Shop</title>");
  });

  // STO-017: /search's <title> used to always show the generic placeholder
  // copy, ignoring ?q= — now it echoes the query, matching the in-page <h1>
  // (SearchPage.tsx's `web.search_results`).
  it("200s GET /search?q=netflix with the query echoed in <title>", async () => {
    const res = await app.inject({ method: "GET", url: "/search?q=netflix" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>Results for &quot;netflix&quot; — SPA Test Shop</title>');
  });

  it("200s GET /search with no q with the generic placeholder title", async () => {
    const res = await app.inject({ method: "GET", url: "/search" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Search products… — SPA Test Shop</title>");
  });

  // The single-use reset token rides in this page's own URL — the shell must
  // stop browsers leaking it via the Referer header (Storefront-1 fix,
  // security audit 2026-06-23), same guard as the deleted HTML route (and the
  // JSON twin, already covered above by the reset-invalid-token test).
  it("sets Referrer-Policy: no-referrer on GET /reset/:token", async () => {
    const res = await app.inject({ method: "GET", url: "/reset/some-token-value" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  // Checkout cutover (docs/REACT_STOREFRONT_MIGRATION.md Phase 6): /checkout
  // and /checkout/:code/pay now fall to this same wildcard — titles from
  // spaShell.ts's TITLE_KEYS table. Auth/ownership live in the JSON twins
  // (tested below), so the shell serves 200 even for anonymous visitors.
  it("200s GET /checkout with the checkout title", async () => {
    const res = await app.inject({ method: "GET", url: "/checkout" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Checkout — SPA Test Shop</title>");
  });

  it("200s GET /checkout/:code/pay with the payment title", async () => {
    const res = await app.inject({ method: "GET", url: "/checkout/SOMECODE/pay" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Payment — SPA Test Shop</title>");
  });

  // Account-area cutover (docs/REACT_STOREFRONT_MIGRATION.md Phase 7):
  // /account, its sub-pages, and /account/settings now fall to this same
  // wildcard — titles from spaShell.ts's TITLE_KEYS table. Auth/ownership
  // live in the JSON twins (tested above), so the shell serves 200 even for
  // anonymous visitors — the client-side AccountPage etc. redirect to
  // /login on the 401 JSON.
  it.each([
    ["/account", "My account"],
    ["/account/orders", "My orders"],
    ["/account/orders/SOMECODE", "My orders"], // order codes are private — generic title, no lookup
    ["/account/referral", "Referral"],
    ["/account/reviews", "My reviews"],
    ["/account/support", "Help &amp; support"], // esc()'d — the raw title has an ampersand
    ["/account/support/123", "Help &amp; support"],
    ["/account/settings", "Account settings"],
  ])("200s GET %s with the %s title", async (path, title) => {
    const res = await app.inject({ method: "GET", url: path });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`<title>${title} — SPA Test Shop</title>`);
  });

  // Group B (storefront SEO quick-wins): canonical <link> on every branch of
  // headInfo(), absolute via the same SHOP_PUBLIC_URL/PUBLIC_URL fallback
  // chain seo.ts uses — test env sets SHOP_PUBLIC_URL to shop.test.invalid.
  describe("canonical <link>", () => {
    it("is present and correct on /", async () => {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.body).toContain('<link rel="canonical" href="https://shop.test.invalid/">');
    });

    it("is present and correct on a product page", async () => {
      const res = await app.inject({ method: "GET", url: `/p/${productSlug}` });
      expect(res.body).toContain(`<link rel="canonical" href="https://shop.test.invalid/p/${productSlug}">`);
    });

    it("is present and correct on a category page", async () => {
      const res = await app.inject({ method: "GET", url: `/c/${categorySlug}` });
      expect(res.body).toContain(`<link rel="canonical" href="https://shop.test.invalid/c/${categorySlug}">`);
    });

    it("canonicalizes /search?q=foo to /search, dropping the query string", async () => {
      const res = await app.inject({ method: "GET", url: "/search?q=foo" });
      expect(res.body).toContain('<link rel="canonical" href="https://shop.test.invalid/search">');
      expect(res.body).not.toContain("q=foo");
    });

    // No public URL configured → omit the tag entirely rather than emit a
    // broken/relative href (same degrade-gracefully philosophy as seo.ts's
    // sitemap/robots routes for the same misconfiguration).
    it("is absent (not broken) when SHOP_PUBLIC_URL and PUBLIC_URL are both unset", async () => {
      const original = config.SHOP_PUBLIC_URL;
      config.SHOP_PUBLIC_URL = undefined;
      try {
        expect(config.PUBLIC_URL).toBeUndefined();
        const res = await app.inject({ method: "GET", url: "/" });
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain('rel="canonical"');
        expect(res.body).not.toContain("application/ld+json");
      } finally {
        config.SHOP_PUBLIC_URL = original;
      }
    });
  });

  // Group B: schema.org Product JSON-LD, product pages only.
  describe("Product JSON-LD", () => {
    /** Parses every application/ld+json block in the document. */
    function allJsonLd(html: string): Array<Record<string, unknown>> {
      return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
        (m) => JSON.parse(m[1]!) as Record<string, unknown>,
      );
    }

    /**
     * The one block of the given @type. A product page carries Product AND
     * BreadcrumbList, so the count is asserted per type rather than per
     * document — a `</script>` breakout would still show up as a parse failure
     * or a missing/duplicated block.
     */
    function extractJsonLd(html: string, type = "Product"): Record<string, unknown> {
      const blocks = allJsonLd(html).filter((b) => b["@type"] === type);
      expect(blocks).toHaveLength(1);
      return blocks[0]!;
    }

    it("is present on a product page with the correct name and price", async () => {
      const res = await app.inject({ method: "GET", url: `/p/${productSlug}` });
      expect(res.statusCode).toBe(200);
      const jsonLd = extractJsonLd(res.body);
      expect(jsonLd).toMatchObject({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Netflix Premium",
        offers: {
          "@type": "Offer",
          price: "40000",
          priceCurrency: "IDR",
          availability: "https://schema.org/InStock",
        },
      });
    });

    it("puts the product in a breadcrumb trail below its category", async () => {
      const res = await app.inject({ method: "GET", url: `/p/${productSlug}` });
      const crumbs = extractJsonLd(res.body, "BreadcrumbList");
      const items = crumbs.itemListElement as Array<Record<string, unknown>>;
      expect(items).toHaveLength(3);
      expect(items[2]).toMatchObject({ position: 3, name: "Netflix Premium" });
    });

    it("describes the shop itself on the home page, not a Product", async () => {
      const res = await app.inject({ method: "GET", url: "/" });
      const types = allJsonLd(res.body).map((b) => b["@type"]);
      expect(types).toContain("Organization");
      expect(types).toContain("WebSite");
      expect(types).not.toContain("Product");
    });

    // A product description containing the literal string `</script>` must
    // not be able to close the JSON-LD <script> tag early and inject
    // arbitrary markup — mirrors the $-pattern safety test above, for the
    // JSON-LD escaping path instead of the .replace() function-form path.
    it("escapes a </script>-breakout attempt in the product description", async () => {
      const evilCategory = await prisma.category.create({
        data: { name: "Evil Cat", slug: "evil-cat-jsonld", emoji: "😈", sortOrder: 99 },
      });
      const evilProduct = await createCatalogProduct(prisma, {
        categoryId: evilCategory.id,
        name: "Evil Product",
        description: '</script><script>alert(1)</script>',
      });
      await createDenomination(prisma, {
        productId: evilProduct.id,
        name: "1 Month",
        type: "SHARED",
        durationLabel: "1 Month",
        price: "10000",
      });

      const res = await app.inject({ method: "GET", url: `/p/${evilProduct.slug}` });
      expect(res.statusCode).toBe(200);
      // The raw, unescaped payload must never appear in the response body.
      expect(res.body).not.toContain('</script><script>alert(1)</script>');
      // Exactly one Product block that still parses — a successful breakout
      // would corrupt parsing or split it into extra <script> tags.
      const jsonLd = extractJsonLd(res.body);
      expect(jsonLd.description).toBe('</script><script>alert(1)</script>');
      // The escaped form (<\/script>) is what actually appears in the markup.
      expect(res.body).toContain('<\\/script><script>alert(1)<\\/script>');
    });
  });
});

// ------------------------------------------------------------- /pages reads
describe("GET /api/v1/pages/context", () => {
  it("returns the anonymous chrome context with the guest cart count", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/context" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shop_name).toBe("SPA Test Shop");
    expect(body.customer).toBeNull();
    expect(body.cart_count).toBe(0);
    expect(body.lang).toBe("en");
    expect(typeof body.tzname).toBe("string");
  });

  it("returns customer display fields when signed in — and never the CSRF token", async () => {
    await makeUser("ctxuser", "ctx-pw-12345", "CTXREF");
    const { cookie } = await loginAs("ctxuser", "ctx-pw-12345");
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/context", headers: { cookie } });
    const body = res.json();
    expect(body.customer).toMatchObject({ username: "ctxuser", telegram_linked: false });
    expect(JSON.stringify(body)).not.toContain("csrf");
  });

  // Migrated from storefront.test.ts's "shop logo" describe (dropped on the
  // account-area cutover, docs/REACT_STOREFRONT_MIGRATION.md Phase 7): the
  // header's logo image was last provable against the still-Nunjucks
  // /account/settings page — the React Layout component now reads logo_url
  // straight from this endpoint instead.
  it("returns the header logo URL from web_logo_url, falling back to empty string", async () => {
    await setSetting(prisma, "web_logo_url", "/uploads/branding/logo-abc123.png");
    const withLogo = await app.inject({ method: "GET", url: "/api/v1/pages/context" });
    expect(withLogo.json().logo_url).toBe("/uploads/branding/logo-abc123.png");
    await deleteSetting(prisma, "web_logo_url");

    const withoutLogo = await app.inject({ method: "GET", url: "/api/v1/pages/context" });
    expect(withoutLogo.json().logo_url).toBe("");
  });
});

describe("GET /api/v1/pages/*", () => {
  it("home returns cards + stats + categories", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/home" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.products.some((p: { slug: string }) => p.slug === productSlug)).toBe(true);
    expect(body.categories.some((c: { slug: string }) => c.slug === categorySlug)).toBe(true);
    expect(body.stats).toHaveProperty("has_data");
    expect(typeof body.low_threshold).toBe("number");
  });

  it("category returns cards; unknown slug 404s", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/v1/pages/category/${categorySlug}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().category.slug).toBe(categorySlug);
    const miss = await app.inject({ method: "GET", url: "/api/v1/pages/category/nope" });
    expect(miss.statusCode).toBe(404);
  });

  it("product returns denominations + restock default; unknown slug 404s", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/v1/pages/product/${productSlug}` });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.product.slug).toBe(productSlug);
    expect(body.denominations[0]).toMatchObject({ id: denomId, price: "40000", in_stock: true, delivery_type: "auto", additional_fields: [] });
    expect(body.default_restock_denomination_id).toBe(denomId);
    const miss = await app.inject({ method: "GET", url: "/api/v1/pages/product/nope" });
    expect(miss.statusCode).toBe(404);
  });

  // Bug A (Task 6): a manual_with_info denomination has no stock rows by
  // design (Task 2 skips stock reservation for non-auto lines), so
  // `available` is always 0 — the page payload must still carry
  // delivery_type + the parsed field spec so the client can gate
  // purchasability on delivery_type instead of stock (see ProductPage.tsx).
  it("product exposes delivery_type + parsed additional_fields for a manual_with_info denomination", async () => {
    const fields: AdditionalField[] = [
      { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: AdditionalFieldType.TEXT, required: true, options: [], placeholder: "" },
    ];
    const product = await createCatalogProduct(prisma, { categoryId: (await prisma.category.findFirstOrThrow()).id, name: `Info Product ${Math.random()}` });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "Info Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "50000",
    });
    await updateDenomination(prisma, denom.id, {
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      additionalFields: JSON.stringify(fields),
    });

    const res = await app.inject({ method: "GET", url: `/api/v1/pages/product/${product.slug}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const found = body.denominations.find((d: { id: number }) => d.id === denom.id);
    expect(found).toMatchObject({ available: 0, in_stock: false, delivery_type: "manual_with_info" });
    expect(found.additional_fields).toEqual(fields);
  });

  it("search returns matches for q", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/search?q=netflix" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.q).toBe("netflix");
    expect(body.products.some((p: { slug: string }) => p.slug === productSlug)).toBe(true);
  });

  // STO-007: sort dropdown on Category/Search — cheapest-first is the one
  // deterministic ordering that doesn't depend on review data or creation
  // timestamps, so it's the one asserted end-to-end here.
  it("category ?sort=cheapest orders products by starting price ascending", async () => {
    const cat = await prisma.category.create({
      data: { name: `Sort Test ${Math.random()}`, slug: `sort-test-${Math.random()}`, sortOrder: 99 },
    });
    const pricey = await createCatalogProduct(prisma, { categoryId: cat.id, name: `Pricey ${Math.random()}` });
    await createDenomination(prisma, { productId: pricey.id, name: "Plan", type: "SHARED", durationLabel: "1 Month", price: "500000" });
    const cheap = await createCatalogProduct(prisma, { categoryId: cat.id, name: `Cheap ${Math.random()}` });
    await createDenomination(prisma, { productId: cheap.id, name: "Plan", type: "SHARED", durationLabel: "1 Month", price: "10000" });

    const res = await app.inject({ method: "GET", url: `/api/v1/pages/category/${cat.slug}?sort=cheapest` });
    expect(res.statusCode).toBe(200);
    const slugs = res.json().products.map((p: { slug: string }) => p.slug);
    expect(slugs.indexOf(cheap.slug)).toBeLessThan(slugs.indexOf(pricey.slug));
  });

  // An unrecognized sort value must fall back to the default ordering
  // instead of 500ing or silently misbehaving.
  it("category ignores an unknown ?sort= value instead of erroring", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/pages/category/${categorySlug}?sort=bogus` });
    expect(res.statusCode).toBe(200);
    expect(res.json().products.some((p: { slug: string }) => p.slug === productSlug)).toBe(true);
  });

  // STO-011: "You might also like" — same category, current product excluded.
  it("product includes same-category related_products, excluding itself", async () => {
    const sibling = await createCatalogProduct(prisma, {
      categoryId: (await prisma.category.findUniqueOrThrow({ where: { slug: categorySlug } })).id,
      name: `Sibling ${Math.random()}`,
    });
    await createDenomination(prisma, { productId: sibling.id, name: "Plan", type: "SHARED", durationLabel: "1 Month", price: "60000" });

    const res = await app.inject({ method: "GET", url: `/api/v1/pages/product/${productSlug}` });
    expect(res.statusCode).toBe(200);
    const related = res.json().related_products;
    expect(related.some((p: { slug: string }) => p.slug === sibling.slug)).toBe(true);
    expect(related.some((p: { slug: string }) => p.slug === productSlug)).toBe(false);
  });
});

// ------------------------------------------------------------------- /auth
describe("/api/v1/auth", () => {
  it("login: wrong credentials get the generic 403 key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { identifier: "nobody", password: "wrong-password" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "web.login_failed" });
  });

  it("login: success sets the session cookie and returns a safe redirect", async () => {
    await makeUser("loginuser", "login-pw-1234", "LOGREF");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { identifier: "loginuser", password: "login-pw-1234", next: "https://evil.example/x" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().redirect).toBe("/"); // open-redirect guard
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("login merges the guest cart into the account", async () => {
    await makeUser("mergeuser", "merge-pw-1234", "MRGREF");
    const add = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      payload: { denomination_id: denomId, qty: 2 },
    });
    const guestCookie = (Array.isArray(add.headers["set-cookie"]) ? add.headers["set-cookie"] : [String(add.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { cookie: guestCookie },
      payload: { identifier: "mergeuser", password: "merge-pw-1234" },
    });
    expect(login.statusCode).toBe(200);
    const sessionCookie = (Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"] : [String(login.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");
    const cart = await app.inject({ method: "GET", url: "/api/v1/cart", headers: { cookie: sessionCookie } });
    expect(cart.json().items[0]).toMatchObject({ denomination_id: denomId, qty: 2 });
  });

  it("register: validation errors return i18n keys; success signs in", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "x", email: "not-an-email", password: "12345678", password2: "12345678" },
    });
    expect(bad.statusCode).toBe(400);
    expect(String(bad.json().error)).toMatch(/^web\./);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "reguser1", email: "reguser1@u.test", password: "register-pw-1", password2: "register-pw-1" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["set-cookie"]).toBeDefined();
  });

  it("logout rotates the jti so the old cookie stops working", async () => {
    await makeUser("logoutuser", "logout-pw-123", "OUTREF");
    const { cookie } = await loginAs("logoutuser", "logout-pw-123");
    const out = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ redirect: "/" });
    // The OLD cookie is dead server-side (jti rotated), not just cleared client-side.
    const after = await app.inject({ method: "GET", url: "/api/v1/account", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("reset: an invalid token gets web.reset_invalid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset/not-a-real-token",
      payload: { password: "new-password-1", password2: "new-password-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "web.reset_invalid" });
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("telegram-widget returns bot_username + a safe auth_url", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/telegram-widget?next=//evil&ref=ABC" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.auth_url).toContain("next=%2F"); // safeNext collapsed //evil → /
    expect(body.auth_url).toContain("ref=ABC");
  });
});

// -------------------------------------------------------------------- /cart
describe("/api/v1/cart twins", () => {
  it("guest: GET/update/remove work with no CSRF (SameSite=Lax is the guard)", async () => {
    const add = await app.inject({ method: "POST", url: "/api/v1/cart", payload: { denomination_id: denomId, qty: 2 } });
    const cookie = (Array.isArray(add.headers["set-cookie"]) ? add.headers["set-cookie"] : [String(add.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");

    const upd = await app.inject({
      method: "POST",
      url: "/api/v1/cart/update",
      headers: { cookie },
      payload: { key: denomId, qty: 5 },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().items[0]).toMatchObject({ qty: 5 });
    expect(upd.json().subtotal).toBe("200000");

    const updCookie = (Array.isArray(upd.headers["set-cookie"]) ? upd.headers["set-cookie"] : [String(upd.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");
    const rm = await app.inject({
      method: "POST",
      url: "/api/v1/cart/remove",
      headers: { cookie: updCookie },
      payload: { key: denomId },
    });
    expect(rm.statusCode).toBe(200);
    expect(rm.json().items).toHaveLength(0);
  });

  it("signed-in: update needs the x-csrf-token header (trio)", async () => {
    const uid = await makeUser("cartspauser", "cartspa-pw-12", "CSPREF");
    const { cookie, csrf } = await loginAs("cartspauser", "cartspa-pw-12");
    await addToCart(prisma, uid, denomId, 1);
    const rows = await prisma.cartItem.findMany({ where: { userId: uid } });
    const key = rows[0]!.id;

    const noToken = await app.inject({
      method: "POST",
      url: "/api/v1/cart/update",
      headers: { cookie },
      payload: { key, qty: 3 },
    });
    expect(noToken.statusCode).toBe(403);

    const badToken = await app.inject({
      method: "POST",
      url: "/api/v1/cart/update",
      headers: { cookie, "x-csrf-token": "bad" },
      payload: { key, qty: 3 },
    });
    expect(badToken.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/cart/update",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { key, qty: 3 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items[0]).toMatchObject({ qty: 3 });
  });

  it("signed-in: remove needs the x-csrf-token header (bad-CSRF case)", async () => {
    const uid = await makeUser("cartremoveuser", "cartrm-pw-123", "CRMREF");
    const { cookie } = await loginAs("cartremoveuser", "cartrm-pw-123");
    await addToCart(prisma, uid, denomId, 1);
    const rows = await prisma.cartItem.findMany({ where: { userId: uid } });
    const key = rows[0]!.id;

    const badToken = await app.inject({
      method: "POST",
      url: "/api/v1/cart/remove",
      headers: { cookie, "x-csrf-token": "bad" },
      payload: { key },
    });
    expect(badToken.statusCode).toBe(403);
    expect(badToken.json()).toEqual({ error: "csrf_failed" });
  });
});

// ---------------------------------------------------------------- /checkout
describe("/api/v1/checkout + orders", () => {
  it("GET /checkout 401s anonymously (JSON, not a redirect)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/checkout" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  describe("signed-in buyer", () => {
    let cookie: string;
    let csrf: string;
    let orderCode: string;

    beforeAll(async () => {
      const uid = await makeUser("spabuyer", "spabuyer-pw-1", "SPABUY");
      const session = await loginAs("spabuyer", "spabuyer-pw-1");
      cookie = session.cookie;
      csrf = session.csrf;
      await addToCart(prisma, uid, denomId, 1);
      await setSetting(prisma, "bybit_uid", "123456789");
      await setSetting(prisma, "bybit_api_key", "k");
      await setSetting(prisma, "bybit_api_secret", "s");
      await setSetting(prisma, "usd_idr_rate", "16000");
    });

    it("GET /checkout returns totals + method flags + wallet balances + per-item data", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items_empty).toBe(false);
      expect(body.subtotal).toBe("40000");
      expect(body.bybit_enabled).toBe(true);
      expect(body).toHaveProperty("wallet_idr");
      expect(body).toHaveProperty("wallet_usdt");
      // Per-item data (Task 6): the SPA's checkout info-collection step needs
      // delivery_type + the parsed field spec per cart line.
      expect(body.items).toEqual([
        { denomination_id: denomId, delivery_type: "auto", additional_fields: [], qty: 1, flash: null },
      ]);
    });

    // The summary's "flash sale price applied" marker reads these flags, so
    // they must ride on the same payload as the totals they annotate — and the
    // totals must already be the discounted ones.
    it("GET /checkout discounts the totals and flags the line while a flash sale runs", async () => {
      await setFlashSale(prisma, {
        denominationId: denomId,
        discountPercent: "25",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 3_600_000),
      });
      try {
        const body = (await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } })).json();
        expect(body.subtotal).toBe("30000"); // 40000 less 25%
        expect(body.items[0].flash).toEqual({
          discount_percent: "25",
          base_price: "40000",
          ends_at: expect.any(String),
        });
      } finally {
        await clearFlashSale(prisma, denomId);
      }
    });

    it("voucher preview: trio + unknown voucher key in error_key", async () => {
      const anon = await app.inject({ method: "POST", url: "/api/v1/checkout/voucher/preview", payload: { voucher_code: "X" } });
      expect(anon.statusCode).toBe(401);
      const bad = await app.inject({
        method: "POST",
        url: "/api/v1/checkout/voucher/preview",
        headers: { cookie, "x-csrf-token": "bad" },
        payload: { voucher_code: "X" },
      });
      expect(bad.statusCode).toBe(403);
      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/checkout/voucher/preview",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { voucher_code: "NOPE" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().error_key).toBe("error.voucher_not_found");
    });

    it("POST /api/v1/checkout (existing endpoint) creates the order", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { method: "bybit" },
      });
      expect(res.statusCode).toBe(201);
      orderCode = res.json().order_code;
    });

    it("GET /orders/:code/pay returns pay data for the owner; 404 for others", async () => {
      const res = await app.inject({ method: "GET", url: `/api/v1/orders/${orderCode}/pay`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.order.code).toBe(orderCode);
      expect(body.state).toBe("waiting");
      expect(body.is_bybit).toBe(true);
      expect(body.bybit_uid).toBe("123456789");

      await makeUser("otherbuyer", "otherbuyer-pw", "OTHBUY");
      const other = await loginAs("otherbuyer", "otherbuyer-pw");
      const probe = await app.inject({ method: "GET", url: `/api/v1/orders/${orderCode}/pay`, headers: { cookie: other.cookie } });
      expect(probe.statusCode).toBe(404); // ownership → 404, never 403
    });

    it("GET /orders/:code/status returns {state, redirect}", async () => {
      const res = await app.inject({ method: "GET", url: `/api/v1/orders/${orderCode}/status`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ state: "waiting", redirect: null });
    });

    it("POST /orders/:code/cancel: trio, then the order is closed", async () => {
      const anon = await app.inject({ method: "POST", url: `/api/v1/orders/${orderCode}/cancel` });
      expect(anon.statusCode).toBe(401);
      const bad = await app.inject({
        method: "POST",
        url: `/api/v1/orders/${orderCode}/cancel`,
        headers: { cookie, "x-csrf-token": "bad" },
      });
      expect(bad.statusCode).toBe(403);
      const ok = await app.inject({
        method: "POST",
        url: `/api/v1/orders/${orderCode}/cancel`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(ok.statusCode).toBe(200);
      const status = await app.inject({ method: "GET", url: `/api/v1/orders/${orderCode}/status`, headers: { cookie } });
      expect(status.json().state).toBe("closed");
    });
  });
});

// ---------------------------------------------------------------------------
// Cluster C cutover: business-logic tests migrated from storefront.test.ts's
// deleted "checkout — …" describe blocks (they used to drive the Nunjucks
// checkout/pay pages; the logic they pinned lives on in checkoutView /
// performCheckout / payView / payState, reached through the JSON twins here).
// Pure HTML/DOM rendering assertions from those blocks (default-checked radio
// cascade, hidden-method radios, the Enter-key voucher interceptor, translated
// error strings, QR <img> markup) moved to the client jsdom tests
// (CheckoutPage.test.tsx / PayPage.test.tsx).
// ---------------------------------------------------------------------------
describe("checkout business rules (migrated from the Nunjucks checkout tests)", () => {
  let buyerId: number;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    buyerId = await makeUser("cutoverbuyer", "cutover-pw-99", "CUTOVR");
    const session = await loginAs("cutoverbuyer", "cutover-pw-99");
    cookie = session.cookie;
    csrf = session.csrf;
  });

  /** Seed one cart line (each successful checkout consumes the cart). */
  async function seedCart() {
    await addToCart(prisma, buyerId, denomId, 1);
  }

  async function placeOrder(method: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method, ...extra },
    });
  }

  it("voucher preview applies a percent voucher to the totals but NEVER creates an order (Task 8 regression)", async () => {
    await createVoucher(prisma, { code: "SAVE10", type: VoucherType.PERCENT, value: "10" });
    await seedCart();
    const before = await prisma.order.count({ where: { userId: buyerId } });

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/voucher/preview",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { voucher_code: "SAVE10" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().voucher_discount).toBe("4000"); // 10% of the 40000 cart
    expect(ok.json().error_key).toBeNull();

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/voucher/preview",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { voucher_code: "NOPE-DOES-NOT-EXIST" },
    });
    expect(bad.statusCode).toBe(200); // inline error key, not an HTTP failure
    expect(bad.json().error_key).toBe("error.voucher_not_found");

    const after = await prisma.order.count({ where: { userId: buyerId } });
    expect(after).toBe(before); // <-- the actual Task 8 bug: this used to grow
  });

  // The preview and the order are two implementations of one price. They
  // disagreed whenever a cart carried BOTH a bulk rule and a percent voucher:
  // computeTotals capped the voucher against the gross subtotal while
  // createOrderFromCart capped it against the subtotal net of the bulk discount
  // (the Money-2 rule), so the page quoted a smaller total than checkout
  // charged. Assert they agree on the actual number, not just that both exist.
  it("quotes the same total it charges when a bulk discount and a voucher stack (math audit F1)", async () => {
    await createVoucher(prisma, { code: "STACK50", type: VoucherType.PERCENT, value: "50" });
    await upsertBulkPricing(prisma, { denominationId: denomId, minQuantity: 2, discountPercent: "25" });
    // QRIS/TokoPay so the order settles in IDR and its total is directly
    // comparable to the previewed IDR figure (a USDT rail would convert).
    await setSetting(prisma, "tokopay_merchant_id", "m-test");
    await setSetting(prisma, "tokopay_secret", "s-test");
    try {
      // Start from an empty cart: this buyer's cart is shared with the tests
      // around it, and a leftover line would silently change the subtotal the
      // arithmetic below is pinned to.
      await clearCart(prisma, buyerId);
      await addToCart(prisma, buyerId, denomId, 2); // 2 × 40000 = 80000 gross

      const preview = await app.inject({
        method: "POST",
        url: "/api/v1/checkout/voucher/preview",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { voucher_code: "STACK50" },
      });
      expect(preview.statusCode).toBe(200);
      const quoted = preview.json();
      expect(quoted.error_key).toBeNull();
      // 80000 − 25% bulk (20000) = 60000; the voucher takes 50% of THAT.
      expect(quoted.bulk_discount).toBe("20000");
      expect(quoted.voucher_discount).toBe("30000");
      expect(quoted.total).toBe("30000");

      const placed = await placeOrder("qris", { voucher_code: "STACK50" });
      expect(placed.statusCode).toBe(201);
      const order = await getOrderByCode(prisma, placed.json().order_code);
      // The charged figure, whole-rupiah for the IDR rail — byte-identical to
      // what the buyer was shown.
      expect(order!.totalAmount.toString()).toBe(quoted.total);
      expect(order!.bulkDiscountAmount.toString()).toBe(quoted.bulk_discount);
      expect(order!.discountAmount.toString()).toBe(quoted.voucher_discount);
    } finally {
      await deleteBulkPricing(prisma, denomId);
      await clearCart(prisma, buyerId);
      await deleteSetting(prisma, "tokopay_merchant_id");
      await deleteSetting(prisma, "tokopay_secret");
    }
  });

  it("rejects a disabled or unknown payment method with 400 web.pay_method_unavailable", async () => {
    await seedCart();
    // PayDisini creds are not configured at this point in the file.
    const disabled = await placeOrder("paydisini");
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json()).toEqual({ error: "web.pay_method_unavailable" });
    const unknown = await placeOrder("visa");
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: "web.pay_method_unavailable" });
  });

  it("rejects method=nowpayments when the USD/IDR rate is unset (USDT conversion needs it)", async () => {
    await setSetting(prisma, "nowpayments_api_key", "ak-test");
    await setSetting(prisma, "nowpayments_ipn_secret", "ipn-secret-test");
    await deleteSetting(prisma, "usd_idr_rate"); // creds present, but no rate
    try {
      await seedCart();
      const res = await placeOrder("nowpayments");
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "web.pay_method_unavailable" });
    } finally {
      await deleteSetting(prisma, "nowpayments_api_key");
      await deleteSetting(prisma, "nowpayments_ipn_secret");
      await setSetting(prisma, "usd_idr_rate", "16000"); // restore (set by the bybit fixture above)
    }
  });

  it("creates a PAYDISINI/IDR order (alongside TokoPay — additive flags) and returns the gateway payload on the pay view", async () => {
    await setSetting(prisma, "paydisini_userkey", "uk-test");
    await setSetting(prisma, "paydisini_apikey", "ak-test");
    await setSetting(prisma, "paydisini_default_channel", "QRIS");
    await setSetting(prisma, "tokopay_merchant_id", "m-test");
    await setSetting(prisma, "tokopay_secret", "s-test");
    try {
      await seedCart();
      // Both IDR rails are enabled at once — additive, not exclusive.
      const flags = await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } });
      expect(flags.json().idr_enabled).toBe(true);
      expect(flags.json().paydisini_enabled).toBe(true);

      const created = await placeOrder("paydisini");
      expect(created.statusCode).toBe(201);
      const code = created.json().order_code as string;
      const order = await getOrderByCode(prisma, code);
      expect(order!.paymentMethod).toBe("PAYDISINI");
      expect(order!.currency).toBe("IDR");

      // payView lazily creates the gateway transaction (mocked above).
      const pay = await app.inject({ method: "GET", url: `/api/v1/orders/${code}/pay`, headers: { cookie } });
      expect(pay.statusCode).toBe(200);
      const body = pay.json();
      expect(body.is_paydisini).toBe(true);
      expect(body.paydisini_gateway).toMatchObject({
        qrUrl: "https://x/paydisini-qr.png",
        checkoutUrl: "https://x/paydisini-checkout",
      });
      expect(body.paydisini_gateway_error).toBe(false);
    } finally {
      await deleteSetting(prisma, "paydisini_userkey");
      await deleteSetting(prisma, "paydisini_apikey");
      await deleteSetting(prisma, "paydisini_default_channel");
      await deleteSetting(prisma, "tokopay_merchant_id");
      await deleteSetting(prisma, "tokopay_secret");
    }
  });

  it("creates a NOWPAYMENTS/USDT order and caches the tagged paymentRef the bot's reconcile poller reads", async () => {
    await setSetting(prisma, "nowpayments_api_key", "ak-test");
    await setSetting(prisma, "nowpayments_ipn_secret", "ipn-secret-test");
    await setSetting(prisma, "nowpayments_pay_currency", "usdttrc20");
    await setSetting(prisma, "usd_idr_rate", "16000");
    try {
      await seedCart();
      const created = await placeOrder("nowpayments");
      expect(created.statusCode).toBe(201);
      const code = created.json().order_code as string;
      let order = await getOrderByCode(prisma, code);
      expect(order!.paymentMethod).toBe("NOWPAYMENTS");
      expect(order!.currency).toBe("USDT");

      const { createInvoice } = await import("@app/core/payments/nowpayments");
      const callsBefore = vi.mocked(createInvoice).mock.calls.length;
      const pay = await app.inject({ method: "GET", url: `/api/v1/orders/${code}/pay`, headers: { cookie } });
      expect(pay.statusCode).toBe(200);
      expect(pay.json().is_nowpayments).toBe(true);
      expect(pay.json().nowpayments_gateway).toEqual({
        invoiceId: "NP-TEST-INV-1",
        invoiceUrl: "https://x/nowpayments-invoice",
      });

      // The cached paymentRef MUST carry the gateway: "nowpayments"
      // discriminator tag — the bot's reconcile poller
      // (nowpaymentsReconcile.ts extractInvoiceId) reads this exact tagged
      // JSON to find the invoice id.
      order = await getOrderByCode(prisma, code);
      const cached = JSON.parse(order!.paymentRef!) as Record<string, unknown>;
      expect(cached.gateway).toBe("nowpayments");
      expect(cached.invoiceId).toBe("NP-TEST-INV-1");
      expect(cached.invoiceUrl).toBe("https://x/nowpayments-invoice");

      // A refresh reads the cache back instead of creating a second invoice.
      const again = await app.inject({ method: "GET", url: `/api/v1/orders/${code}/pay`, headers: { cookie } });
      expect(again.json().nowpayments_gateway).toEqual(pay.json().nowpayments_gateway);
      expect(vi.mocked(createInvoice).mock.calls.length).toBe(callsBefore + 1);
    } finally {
      await deleteSetting(prisma, "nowpayments_api_key");
      await deleteSetting(prisma, "nowpayments_ipn_secret");
      await deleteSetting(prisma, "nowpayments_pay_currency");
    }
  });

  describe("pay entirely with balance (wallet_idr / wallet_usdt)", () => {
    afterEach(async () => {
      await prisma.user.update({ where: { id: buyerId }, data: { walletBalance: "0", walletBalanceUsdt: "0" } });
      // A rejected checkout rolls back its own clearCart() along with the
      // order it failed to create, so a leftover cart item from a prior
      // failed-checkout test would otherwise stack onto the next seedCart().
      await clearCart(prisma, buyerId);
    });

    it("wallet_idr, sufficient balance: settles instantly with no gateway, debits exactly, credentials available", async () => {
      await prisma.user.update({ where: { id: buyerId }, data: { walletBalance: "40000" } });
      await seedCart();

      const res = await placeOrder("wallet_idr");
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.pay_url).toBe(`/account/orders/${body.order_code}`);

      const order = await getOrderByCode(prisma, body.order_code as string);
      expect(order!.paymentMethod).toBe("WALLET");
      expect(order!.currency).toBe("IDR");
      expect(order!.walletUsed.toString()).toBe("40000");
      expect(order!.totalAmount.toString()).toBe("0");
      expect(order!.status).toBe(OrderStatus.DELIVERED);

      const buyer = await prisma.user.findUniqueOrThrow({ where: { id: buyerId } });
      expect(buyer.walletBalance.toString()).toBe("0");

      const detail = await app.inject({
        method: "GET",
        url: `/api/v1/account/orders/${body.order_code}`,
        headers: { cookie },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().delivered).toBe(true);
      expect(detail.json().order.items[0].credentials).toBeTruthy();
    });

    it("wallet_idr, insufficient balance: 400 error.insufficient_wallet, no order created, wallet untouched", async () => {
      await prisma.user.update({ where: { id: buyerId }, data: { walletBalance: "100" } }); // less than 40000
      await seedCart();
      const before = await prisma.order.count({ where: { userId: buyerId } });

      const res = await placeOrder("wallet_idr");
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "error.insufficient_wallet" });

      const after = await prisma.order.count({ where: { userId: buyerId } });
      expect(after).toBe(before);
      const buyer = await prisma.user.findUniqueOrThrow({ where: { id: buyerId } });
      expect(buyer.walletBalance.toString()).toBe("100");
    });

    it("wallet_usdt, sufficient balance: settles instantly, currency USDT", async () => {
      await setSetting(prisma, "usd_idr_rate", "16000");
      await prisma.user.update({ where: { id: buyerId }, data: { walletBalanceUsdt: "2.5" } }); // 40000 / 16000
      await seedCart();

      const res = await placeOrder("wallet_usdt");
      expect(res.statusCode).toBe(201);
      const order = await getOrderByCode(prisma, res.json().order_code as string);
      expect(order!.paymentMethod).toBe("WALLET");
      expect(order!.currency).toBe("USDT");
      expect(order!.totalAmount.toString()).toBe("0");

      const buyer = await prisma.user.findUniqueOrThrow({ where: { id: buyerId } });
      expect(Number(buyer.walletBalanceUsdt)).toBeCloseTo(0);
    });

    it("wallet_usdt with no USD/IDR rate configured: 400 web.pay_method_unavailable", async () => {
      await deleteSetting(prisma, "usd_idr_rate");
      try {
        await prisma.user.update({ where: { id: buyerId }, data: { walletBalanceUsdt: "10" } });
        await seedCart();
        const res = await placeOrder("wallet_usdt");
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "web.pay_method_unavailable" });
      } finally {
        await setSetting(prisma, "usd_idr_rate", "16000");
      }
    });
  });

  describe("payState mapping on a BYBIT_BSC order (status poll)", () => {
    let code: string;

    beforeAll(async () => {
      await setSetting(prisma, "bybit_bsc_deposit_address", "0xMERCHANTADDR");
      await setSetting(prisma, "bybit_api_key", "k");
      await setSetting(prisma, "bybit_api_secret", "s");
      await setSetting(prisma, "usd_idr_rate", "16000");
      await seedCart();
      const created = await placeOrder("bybit_bsc");
      expect(created.statusCode).toBe(201);
      code = created.json().order_code as string;
    });

    afterAll(async () => {
      await deleteSetting(prisma, "bybit_bsc_deposit_address");
      await deleteSetting(prisma, "bybit_bsc_min_amount");
    });

    it("creates a BYBIT_BSC/USDT order whose pay view carries the deposit address + a min-amount note only when configured", async () => {
      const order = await getOrderByCode(prisma, code);
      expect(order!.paymentMethod).toBe("BYBIT_BSC");
      expect(order!.currency).toBe("USDT");

      await setSetting(prisma, "bybit_bsc_min_amount", "5");
      const withNote = await app.inject({ method: "GET", url: `/api/v1/orders/${code}/pay`, headers: { cookie } });
      expect(withNote.json().is_bybit_bsc).toBe(true);
      expect(withNote.json().bybit_bsc_address).toBe("0xMERCHANTADDR");
      expect(withNote.json().min_amount).toBeTruthy(); // pre-formatted server-side

      await deleteSetting(prisma, "bybit_bsc_min_amount");
      const withoutNote = await app.inject({ method: "GET", url: `/api/v1/orders/${code}/pay`, headers: { cookie } });
      expect(withoutNote.json().min_amount).toBeNull();
    });

    // Without the in-flight branches in payState, a live Bybit BSC order
    // would fall into the "closed" catch-all and render as dead the moment a
    // deposit is first detected.
    it.each([OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING, OrderStatus.CONFIRMED])(
      "status poll reports 'confirming', not 'closed', once the order is %s",
      async (status) => {
        await prisma.order.update({ where: { orderCode: code }, data: { status } });
        const res = await app.inject({ method: "GET", url: `/api/v1/orders/${code}/status`, headers: { cookie } });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ state: "confirming", redirect: null });
      },
    );

    it("status poll returns the credentials-page redirect once DELIVERED (JSON twin of the old HX-Redirect)", async () => {
      await prisma.order.update({ where: { orderCode: code }, data: { status: OrderStatus.DELIVERED } });
      const res = await app.inject({ method: "GET", url: `/api/v1/orders/${code}/status`, headers: { cookie } });
      expect(res.json()).toEqual({ state: "delivered", redirect: `/account/orders/${code}` });
    });
  });
});

// ---------------------------------------------------------------------------
// Task 6: server-side revalidation of manual_with_info customer_data. The
// client is never trusted — performCheckout re-validates against the
// denomination's real field spec before persisting, exactly mirroring
// validateCustomerData's contract (packages/core/src/deliveryFields.ts).
// ---------------------------------------------------------------------------
describe("POST /api/v1/checkout — manual_with_info customer_data revalidation", () => {
  let buyerId: number;
  let cookie: string;
  let csrf: string;
  let infoDenomId: number;
  const fields: AdditionalField[] = [
    { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: AdditionalFieldType.TEXT, required: true, options: [], placeholder: "" },
  ];

  beforeAll(async () => {
    buyerId = await makeUser("infobuyer", "infobuyer-pw-1", "INFOBUY");
    const session = await loginAs("infobuyer", "infobuyer-pw-1");
    cookie = session.cookie;
    csrf = session.csrf;

    const cat = await prisma.category.findFirstOrThrow();
    const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: `Info Checkout Product ${Math.random()}` });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "Info Checkout Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "25000",
    });
    infoDenomId = denom.id;
    await updateDenomination(prisma, infoDenomId, {
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      additionalFields: JSON.stringify(fields),
    });

    await setSetting(prisma, "bybit_uid", "123456789");
    await setSetting(prisma, "bybit_api_key", "k");
    await setSetting(prisma, "bybit_api_secret", "s");
    await setSetting(prisma, "usd_idr_rate", "16000");
  });

  it("GET /checkout reports the manual_with_info item + its field spec", async () => {
    await addToCart(prisma, buyerId, infoDenomId, 2);
    const res = await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } });
    expect(res.json().items).toEqual([
      {
        denomination_id: infoDenomId,
        delivery_type: "manual_with_info",
        additional_fields: fields,
        qty: 2,
        flash: null,
      },
    ]);
  });

  it("400s error.customer_data_incomplete when customer_data is missing entirely", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "bybit" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.customer_data_incomplete" });
    // No order was created on the rejected attempt.
    expect(await prisma.order.count({ where: { userId: buyerId } })).toBe(0);
  });

  it("400s error.field_required when a unit's required field is blank", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "bybit", customer_data: [{ game_id: "player1" }, { game_id: "" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.field_required" });
  });

  it("201s and persists the validated, normalized customer_data onto the order", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "bybit", customer_data: [{ game_id: "  player1  " }, { game_id: "player2" }] },
    });
    expect(res.statusCode).toBe(201);
    const order = await getOrderByCode(prisma, res.json().order_code);
    expect(JSON.parse(order!.customerData!)).toEqual([{ game_id: "player1" }, { game_id: "player2" }]);
  });

  // Final whole-branch review: POST /cart's homogeneity guard only fires on
  // the add-to-cart call itself — a cart can still end up mixed via a path
  // that bypasses that route entirely (the documented guest-cart-merge-on-
  // login gap in routes/auth.ts's establishSession, or a theoretical two-tab
  // race). performCheckout re-asserts homogeneity right before creating the
  // order, so a mixed cart is rejected here regardless of how it got mixed —
  // seed one directly via addToCart (bypassing the route guard on purpose,
  // simulating exactly that scenario) rather than going through POST /cart.
  it("400s error.cart_mixed_delivery when the cart is mixed via a path that bypassed the add-to-cart guard", async () => {
    const cat = await prisma.category.findFirstOrThrow();
    const autoProduct = await createCatalogProduct(prisma, { categoryId: cat.id, name: `Auto Mix Product ${Math.random()}` });
    const autoDenom = await createDenomination(prisma, {
      productId: autoProduct.id,
      name: "Auto Mix Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
    });
    await addToCart(prisma, buyerId, autoDenom.id, 1);
    await addToCart(prisma, buyerId, infoDenomId, 1);
    const ordersBefore = await prisma.order.count({ where: { userId: buyerId } });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "bybit", customer_data: [{ game_id: "player1" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.cart_mixed_delivery" });
    // No order was created on the rejected attempt.
    expect(await prisma.order.count({ where: { userId: buyerId } })).toBe(ordersBefore);
  });
});

// ----------------------------------------------------------------- /account
describe("/api/v1/account twins", () => {
  it("reads 401 anonymously", async () => {
    for (const url of ["/api/v1/account", "/api/v1/account/orders", "/api/v1/account/settings"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }
  });

  describe("signed in", () => {
    let cookie: string;
    let csrf: string;
    let buyerId: number;

    beforeAll(async () => {
      buyerId = await makeUser("accspauser", "accspa-pw-123", "ACCSPA");
      const session = await loginAs("accspauser", "accspa-pw-123");
      cookie = session.cookie;
      csrf = session.csrf;
    });

    it("GET /account returns the overview", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/account", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.referral_code).toBe("ACCSPA");
      expect(body.order_count).toBe(0);
    });

    // STO-002: a password-registered customer (no Telegram fullName/username,
    // only `loginUsername`) must not see a blank "Signed in as" name.
    it("GET /account falls back to loginUsername when no Telegram identity is linked", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/account", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe("accspauser");
    });

    it("support ticket: create (trio) → list → detail → reply", async () => {
      const anon = await app.inject({ method: "POST", url: "/api/v1/account/support", payload: { message: "help" } });
      expect(anon.statusCode).toBe(401);
      const bad = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": "bad" },
        payload: { message: "help" },
      });
      expect(bad.statusCode).toBe(403);
      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "help me please" },
      });
      expect(ok.statusCode).toBe(200);
      // STO-020: the client's "Ticket #N created" toast needs the new
      // ticket's id in the create response.
      expect(typeof ok.json().ticket_id).toBe("number");

      const list = await app.inject({ method: "GET", url: "/api/v1/account/support", headers: { cookie } });
      const ticket = list.json().tickets[0];
      expect(ticket.message).toBe("help me please");
      expect(typeof ticket.created_at_display).toBe("string");

      const detail = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticket.id}`, headers: { cookie } });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().ticket.id).toBe(ticket.id);

      const badReply = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticket.id}/reply`,
        headers: { cookie, "x-csrf-token": "bad" },
        payload: { message: "more details" },
      });
      expect(badReply.statusCode).toBe(403);
      expect(badReply.json()).toEqual({ error: "csrf_failed" });

      const reply = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticket.id}/reply`,
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "more details" },
      });
      expect(reply.statusCode).toBe(200);
      const detail2 = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticket.id}`, headers: { cookie } });
      expect(detail2.json().messages.some((m: { content: string }) => m.content === "more details")).toBe(true);
    });

    it("support ticket: create + reply with an image attachment (multipart), shown in list + detail", async () => {
      const mp = multipart({ message: "evidence attached" }, [
        { field: "attachments", filename: "proof.png", contentType: "image/png", content: PNG },
      ]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(200);
      const ticketId = res.json().ticket_id as number;

      const list = await app.inject({ method: "GET", url: "/api/v1/account/support", headers: { cookie } });
      const listed = list.json().tickets.find((tk: { id: number }) => tk.id === ticketId);
      expect(listed.attachments).toHaveLength(1);
      expect(listed.attachments[0]).toMatch(/^\/uploads\/tickets\/evidence-[0-9a-f]+\.png$/);

      const detail = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticketId}`, headers: { cookie } });
      expect(detail.json().ticket.attachments).toEqual(listed.attachments);

      const replyMp = multipart({ message: "here's another angle" }, [
        { field: "attachments", filename: "proof2.png", contentType: "image/png", content: PNG },
      ]);
      const reply = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/reply`,
        headers: { cookie, "x-csrf-token": csrf, ...replyMp.headers },
        payload: replyMp.payload,
      });
      expect(reply.statusCode).toBe(200);
      const detail2 = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticketId}`, headers: { cookie } });
      const msg = detail2
        .json()
        .messages.find((m: { content: string }) => m.content === "here's another angle");
      expect(msg.attachments).toHaveLength(1);
    });

    it("support ticket create rejects a bad file type, an oversized file, and too many files", async () => {
      const badType = multipart({ message: "bad type" }, [
        { field: "attachments", filename: "x.txt", contentType: "text/plain", content: Buffer.from("nope") },
      ]);
      const badTypeRes = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf, ...badType.headers },
        payload: badType.payload,
      });
      expect(badTypeRes.statusCode).toBe(400);
      expect(badTypeRes.json()).toEqual({ error: "web.support_attach_error_type" });

      const oversized = multipart({ message: "too big" }, [
        {
          field: "attachments",
          filename: "big.png",
          contentType: "image/png",
          content: Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]),
        },
      ]);
      const oversizedRes = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf, ...oversized.headers },
        payload: oversized.payload,
      });
      expect(oversizedRes.statusCode).toBe(400);
      expect(oversizedRes.json()).toEqual({ error: "web.support_attach_error_size" });

      const tooMany = multipart(
        { message: "too many" },
        Array.from({ length: 4 }, (_, i) => ({
          field: "attachments",
          filename: `p${i}.png`,
          contentType: "image/png",
          content: PNG,
        })),
      );
      const tooManyRes = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf, ...tooMany.headers },
        payload: tooMany.payload,
      });
      expect(tooManyRes.statusCode).toBe(400);
      expect(tooManyRes.json()).toEqual({ error: "web.support_attach_error_count" });
    });

    it("another user's ticket 404s (never 403)", async () => {
      const list = await app.inject({ method: "GET", url: "/api/v1/account/support", headers: { cookie } });
      const ticketId = list.json().tickets[0].id;
      await makeUser("noseyuser", "nosey-pw-1234", "NOSEY1");
      const other = await loginAs("noseyuser", "nosey-pw-1234");
      const probe = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticketId}`, headers: { cookie: other.cookie } });
      expect(probe.statusCode).toBe(404);
    });

    it("support ticket: create with an order_code links it; GET :id returns the order summary", async () => {
      const stock = await prisma.stockItem.create({
        data: { productId: denomId, credentials: "tick-order@mail.com:pw", status: "SOLD" },
      });
      const order = await prisma.order.create({
        data: {
          orderCode: `ORD-TICKORD-${Math.random()}`,
          userId: buyerId,
          subtotalAmount: "40000",
          totalAmount: "40000",
          status: OrderStatus.DELIVERED,
          paidAt: new Date(),
          deliveredAt: new Date(),
        },
      });
      await prisma.orderItem.create({
        data: { orderId: order.id, productId: denomId, stockItemId: stock.id, unitPrice: "40000", warrantyDaysSnapshot: 30 },
      });

      const create = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "issue with this order", order_code: order.orderCode },
      });
      expect(create.statusCode).toBe(200);
      const ticketId = create.json().ticket_id as number;

      const detail = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticketId}`, headers: { cookie } });
      expect(detail.statusCode).toBe(200);
      const body = detail.json();
      expect(body.order.code).toBe(order.orderCode);
      expect(body.order.delivered).toBe(true);
      expect(body.order.items).toHaveLength(1);
      expect(body.order.items[0].warranty_days).toBe(30);
      expect(body.order.items[0].warranty_active).toBe(true);
    });

    it("support ticket: create with an order_code belonging to someone else is rejected", async () => {
      await makeUser("ticketorderthief", "thief-pw-1234", "TICKTHIEF");
      const other = await loginAs("ticketorderthief", "thief-pw-1234");
      const otherOrder = await prisma.order.create({
        data: {
          orderCode: `ORD-NOTMINE-${Math.random()}`,
          userId: buyerId, // belongs to buyerId, not the "other" session below
          subtotalAmount: "1000",
          totalAmount: "1000",
          status: OrderStatus.DELIVERED,
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie: other.cookie, "x-csrf-token": other.csrf },
        payload: { message: "not my order", order_code: otherOrder.orderCode },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "error.order_not_found" });
    });

    it("support ticket without an order_code still creates fine, GET :id returns order: null", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "general question, no order" },
      });
      expect(create.statusCode).toBe(200);
      const ticketId = create.json().ticket_id as number;
      const detail = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticketId}`, headers: { cookie } });
      expect(detail.json().order).toBeNull();
    });

    it("close (trio) then GET :id shows closed + reopenable; reopen (trio) flips it back to open", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "will self-close this one" },
      });
      const ticketId = create.json().ticket_id as number;

      const anonClose = await app.inject({ method: "POST", url: `/api/v1/account/support/${ticketId}/close` });
      expect(anonClose.statusCode).toBe(401);
      const badClose = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/close`,
        headers: { cookie, "x-csrf-token": "bad" },
      });
      expect(badClose.statusCode).toBe(403);
      const okClose = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/close`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(okClose.statusCode).toBe(200);

      const afterClose = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticketId}`, headers: { cookie } });
      expect(afterClose.json().ticket.closed).toBe(true);
      expect(afterClose.json().ticket.reopenable).toBe(true);

      const secondClose = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/close`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(secondClose.statusCode).toBe(409);

      const anonReopen = await app.inject({ method: "POST", url: `/api/v1/account/support/${ticketId}/reopen` });
      expect(anonReopen.statusCode).toBe(401);
      const badReopen = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/reopen`,
        headers: { cookie, "x-csrf-token": "bad" },
      });
      expect(badReopen.statusCode).toBe(403);
      const okReopen = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/reopen`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(okReopen.statusCode).toBe(200);

      const afterReopen = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticketId}`, headers: { cookie } });
      expect(afterReopen.json().ticket.status.toLowerCase()).toBe("open");
      expect(afterReopen.json().ticket.closed).toBe(false);
    });

    it("reopen past the window returns 400 error.ticket_reopen_expired", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "will expire" },
      });
      const ticketId = create.json().ticket_id as number;
      await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/close`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      await prisma.supportTicket.update({
        where: { id: ticketId },
        data: { closedAt: new Date(Date.now() - 8 * 86_400_000) },
      });
      const reopen = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/reopen`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(reopen.statusCode).toBe(400);
      expect(reopen.json()).toEqual({ error: "error.ticket_reopen_expired" });
    });

    it("close/reopen on another user's ticket 404s (never 403)", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "mine" },
      });
      const ticketId = create.json().ticket_id as number;
      await makeUser("ticketclosethief", "closethief-pw1", "TICKCLOSE1");
      const other = await loginAs("ticketclosethief", "closethief-pw1");
      const probe = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/close`,
        headers: { cookie: other.cookie, "x-csrf-token": other.csrf },
      });
      expect(probe.statusCode).toBe(404);
    });

    it("restock subscribe returns the product redirect (trio-lite)", async () => {
      const anon = await app.inject({ method: "POST", url: `/api/v1/restock/${denomId}` });
      expect(anon.statusCode).toBe(401);
      const badToken = await app.inject({
        method: "POST",
        url: `/api/v1/restock/${denomId}`,
        headers: { cookie, "x-csrf-token": "bad" },
      });
      expect(badToken.statusCode).toBe(403);
      expect(badToken.json()).toEqual({ error: "csrf_failed" });
      const ok = await app.inject({
        method: "POST",
        url: `/api/v1/restock/${denomId}`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().redirect).toBe(`/p/${productSlug}`);
    });

    // Migrated from the deleted account.ts (docs/REACT_STOREFRONT_MIGRATION.md
    // Phase 7) — never had a Nunjucks-era HTTP test of its own (checked the
    // full git history), so this is new server-level coverage for logic that
    // otherwise only ran through mocked-fetch client jsdom tests
    // (OrderDetailPage.test.tsx).
    it("GET /account/orders/:code shows credentials only when DELIVERED; a non-owner gets 404 (never 403)", async () => {
      const stock = await prisma.stockItem.create({
        data: { productId: denomId, credentials: "acc-orderdetail@mail.com:pw", status: "SOLD" },
      });
      const order = await prisma.order.create({
        data: {
          orderCode: `ORD-ACCSPA-${Math.random()}`,
          userId: buyerId,
          subtotalAmount: "40000",
          totalAmount: "40000",
          status: OrderStatus.PENDING_PAYMENT,
        },
      });
      await prisma.orderItem.create({
        data: { orderId: order.id, productId: denomId, stockItemId: stock.id, unitPrice: "40000", warrantyDaysSnapshot: 30 },
      });

      const pending = await app.inject({ method: "GET", url: `/api/v1/account/orders/${order.orderCode}`, headers: { cookie } });
      expect(pending.statusCode).toBe(200);
      expect(pending.json().delivered).toBe(false);
      expect(pending.json().pending_payment).toBe(true);
      expect(pending.json().processing).toBe(false);
      expect(pending.json().order.items[0].credentials).toBeNull();
      // Task 10: an ordinary (auto-delivery) order has no manual_with_info
      // fields and no admin-typed delivered_content.
      expect(pending.json().order.customer_data_fields).toEqual([]);
      expect(pending.json().order.customer_data).toEqual([]);
      expect(pending.json().order.delivered_content).toBeNull();

      await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.DELIVERED } });
      const delivered = await app.inject({ method: "GET", url: `/api/v1/account/orders/${order.orderCode}`, headers: { cookie } });
      expect(delivered.json().delivered).toBe(true);
      expect(delivered.json().processing).toBe(false);
      expect(delivered.json().order.items[0].credentials).toBe("acc-orderdetail@mail.com:pw");

      await makeUser("orderpeeker", "orderpeeker-pw1", "OPEEK1");
      const peeker = await loginAs("orderpeeker", "orderpeeker-pw1");
      const probe = await app.inject({
        method: "GET",
        url: `/api/v1/account/orders/${order.orderCode}`,
        headers: { cookie: peeker.cookie },
      });
      expect(probe.statusCode).toBe(404);
    });

    // Migrated from the deleted account.ts — same "never had a Nunjucks-era
    // HTTP test" gap as the order-detail test above.
    it("reviews: create, then a dupe or a bad order_id swallow silently (matches the deleted HTML handler 1:1)", async () => {
      const stock = await prisma.stockItem.create({ data: { productId: denomId, credentials: "x", status: "SOLD" } });
      const order = await prisma.order.create({
        data: {
          orderCode: `ORD-REV-${Math.random()}`,
          userId: buyerId,
          subtotalAmount: "40000",
          totalAmount: "40000",
          status: OrderStatus.DELIVERED,
        },
      });
      await prisma.orderItem.create({
        data: { orderId: order.id, productId: denomId, stockItemId: stock.id, unitPrice: "40000", warrantyDaysSnapshot: 30 },
      });

      const anon = await app.inject({
        method: "POST",
        url: "/api/v1/account/reviews",
        payload: { order_id: order.id, product_id: denomId, rating: 5 },
      });
      expect(anon.statusCode).toBe(401);

      const badToken = await app.inject({
        method: "POST",
        url: "/api/v1/account/reviews",
        headers: { cookie, "x-csrf-token": "bad" },
        payload: { order_id: order.id, product_id: denomId, rating: 5 },
      });
      expect(badToken.statusCode).toBe(403);
      expect(badToken.json()).toEqual({ error: "csrf_failed" });

      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/account/reviews",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { order_id: order.id, product_id: denomId, rating: 4, comment: "great" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ok: true });
      const stored = await prisma.review.findFirst({ where: { orderId: order.id } });
      expect(stored).toMatchObject({ rating: 4, comment: "great" });

      // Dupe (unique userId+orderId) and a bad order_id both throw
      // ValidationError inside createReview — the route just swallows it and
      // reports ok:true either way (bounce-back UX, not a real error).
      const dupe = await app.inject({
        method: "POST",
        url: "/api/v1/account/reviews",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { order_id: order.id, product_id: denomId, rating: 2 },
      });
      expect(dupe.statusCode).toBe(200);
      expect(await prisma.review.count({ where: { orderId: order.id } })).toBe(1); // no 2nd row

      const badOrder = await app.inject({
        method: "POST",
        url: "/api/v1/account/reviews",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { order_id: 999999, product_id: denomId, rating: 3 },
      });
      expect(badOrder.statusCode).toBe(200);
      expect(badOrder.json()).toEqual({ ok: true });
    });

    // Migrated from the deleted account.ts — same "never had a Nunjucks-era
    // HTTP test" gap as above. BOT_USERNAME="TestBot" (setup-env.ts); the
    // .env.example placeholder ("YourBot") is filtered to "" by
    // resolveBotUsername (see the "bot_username resolution" describe in
    // storefront.test.ts for the same fixture on the home payload).
    it("GET /account/referral returns the code + bot-linked URL, and null with no usable bot username", async () => {
      const withBot = await app.inject({ method: "GET", url: "/api/v1/account/referral", headers: { cookie } });
      expect(withBot.statusCode).toBe(200);
      expect(withBot.json()).toEqual({
        referral_code: "ACCSPA",
        referral_link: "https://t.me/TestBot?start=ref_ACCSPA",
      });

      await setSetting(prisma, "bot_username", "YourBot");
      try {
        const noBot = await app.inject({ method: "GET", url: "/api/v1/account/referral", headers: { cookie } });
        expect(noBot.json().referral_link).toBeNull();
      } finally {
        await deleteSetting(prisma, "bot_username");
      }
    });

    // Storefront-3 (security audit, 2026-06-23): email/username are the
    // account-recovery anchor — changing them must require re-auth too, not
    // just password changes. Migrated from storefront.test.ts's deleted
    // "account settings" describe.
    it("settings credentials: rejects missing CSRF; requires current_password to change email too", async () => {
      const noCsrf = await app.inject({
        method: "POST",
        url: "/api/v1/account/settings/credentials",
        headers: { cookie },
        payload: { email: "evil@u.test" },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.json()).toEqual({ error: "csrf_failed" });

      const badEmail = await app.inject({
        method: "POST",
        url: "/api/v1/account/settings/credentials",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { email: "attacker-controlled@evil.test", current_password: "WRONG" },
      });
      expect(badEmail.statusCode).toBe(400);
      expect(badEmail.json()).toEqual({ error: "web.settings_wrong_password" });
      const rowAfterBadEmail = await prisma.user.findUnique({ where: { id: buyerId } });
      expect(rowAfterBadEmail!.email).not.toBe("attacker-controlled@evil.test");

      const okEmail = await app.inject({
        method: "POST",
        url: "/api/v1/account/settings/credentials",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { email: "accspa-new@u.test", current_password: "accspa-pw-123" },
      });
      expect(okEmail.statusCode).toBe(200);
      const rowAfterEmail = await prisma.user.findUnique({ where: { id: buyerId } });
      expect(rowAfterEmail!.email).toBe("accspa-new@u.test");
    });

    it("settings credentials: wrong current_password 400s; correct one saves, reports password_changed, and rotates the session (Storefront-2 fix)", async () => {
      const wrong = await app.inject({
        method: "POST",
        url: "/api/v1/account/settings/credentials",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { new_password: "brand-new-pw-1", current_password: "not-my-password" },
      });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json()).toEqual({ error: "web.settings_wrong_password" });

      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/account/settings/credentials",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { new_password: "brand-new-pw-1", current_password: "accspa-pw-123" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ok: true, password_changed: true });
      // The response refreshed OUR cookie (rotated jti) — the old cookie string
      // is stale now; other sessions are invalidated.
      expect(ok.headers["set-cookie"]).toBeDefined();

      // The OLD cookie's jti was just rotated server-side — it must no
      // longer authenticate (any session active before this password change
      // is dead). Migrated from storefront.test.ts's deleted
      // "account settings" describe, which proved this against the HTML
      // /account/settings route.
      const staleCheck = await app.inject({ method: "GET", url: "/api/v1/account", headers: { cookie } });
      expect(staleCheck.statusCode).toBe(401);
    });
  });
});

// Task 10: PROCESSING-stage order-detail UX — the storefront twin of the
// bot's editCustomerInfoConversation (Task 9). Mirrors the "POST
// /api/v1/checkout — manual_with_info customer_data revalidation" describe
// above (own buyer + manual_with_info denom) rather than reusing the shared
// top-level `denomId` (an ordinary auto-delivery SKU).
describe("GET/PATCH /api/v1/account/orders/:code (Task 10: PROCESSING info edit + delivered_content)", () => {
  let buyerId: number;
  let cookie: string;
  let csrf: string;
  let infoDenomId: number;
  const fields: AdditionalField[] = [
    { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: AdditionalFieldType.TEXT, required: true, options: [], placeholder: "" },
  ];

  beforeAll(async () => {
    buyerId = await makeUser("editinfobuyer", "editinfo-pw-1", "EDITINFO");
    const session = await loginAs("editinfobuyer", "editinfo-pw-1");
    cookie = session.cookie;
    csrf = session.csrf;

    const cat = await prisma.category.findFirstOrThrow();
    const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: `Edit Info Product ${Math.random()}` });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "Edit Info Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "25000",
    });
    infoDenomId = denom.id;
    await updateDenomination(prisma, infoDenomId, {
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      additionalFields: JSON.stringify(fields),
    });
  });

  async function makeProcessingOrder(answers: Array<Record<string, string>>): Promise<string> {
    const orderCode = `ORD-EDITINFO-${Math.random()}`;
    const order = await prisma.order.create({
      data: {
        orderCode,
        userId: buyerId,
        subtotalAmount: "25000",
        totalAmount: "25000",
        status: OrderStatus.PROCESSING,
        customerData: JSON.stringify(answers),
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: infoDenomId, unitPrice: "25000", warrantyDaysSnapshot: 30 },
    });
    return orderCode;
  }

  it("GET reports processing:true, the field spec, and the buyer's current answers", async () => {
    const orderCode = await makeProcessingOrder([{ game_id: "player1" }]);
    const res = await app.inject({ method: "GET", url: `/api/v1/account/orders/${orderCode}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processing).toBe(true);
    expect(body.delivered).toBe(false);
    expect(body.order.customer_data_fields).toEqual(fields);
    expect(body.order.customer_data).toEqual([{ game_id: "player1" }]);
    expect(body.order.delivered_content).toBeNull();
  });

  it("GET returns delivered_content once DELIVERED (manual fulfilment)", async () => {
    const orderCode = await makeProcessingOrder([{ game_id: "player1" }]);
    await prisma.order.update({
      where: { orderCode },
      data: { status: OrderStatus.DELIVERED, deliveredContent: "user: netflix1\npass: hunter2" },
    });
    const res = await app.inject({ method: "GET", url: `/api/v1/account/orders/${orderCode}`, headers: { cookie } });
    expect(res.json().delivered).toBe(true);
    expect(res.json().processing).toBe(false);
    expect(res.json().order.delivered_content).toBe("user: netflix1\npass: hunter2");
  });

  it("PATCH info: anonymous 401s, wrong CSRF 403s", async () => {
    const orderCode = await makeProcessingOrder([{ game_id: "player1" }]);
    const anon = await app.inject({
      method: "PATCH",
      url: `/api/v1/account/orders/${orderCode}/info`,
      payload: { customer_data: [{ game_id: "new" }] },
    });
    expect(anon.statusCode).toBe(401);

    const badCsrf = await app.inject({
      method: "PATCH",
      url: `/api/v1/account/orders/${orderCode}/info`,
      headers: { cookie, "x-csrf-token": "bad" },
      payload: { customer_data: [{ game_id: "new" }] },
    });
    expect(badCsrf.statusCode).toBe(403);
    expect(badCsrf.json()).toEqual({ error: "csrf_failed" });
  });

  it("PATCH info: another user's order 404s (never 403), and their answers stay untouched", async () => {
    const orderCode = await makeProcessingOrder([{ game_id: "player1" }]);
    await makeUser("editinfopeeker", "editinfopeeker-pw1", "EDITPEEK1");
    const peeker = await loginAs("editinfopeeker", "editinfopeeker-pw1");
    const probe = await app.inject({
      method: "PATCH",
      url: `/api/v1/account/orders/${orderCode}/info`,
      headers: { cookie: peeker.cookie, "x-csrf-token": peeker.csrf },
      payload: { customer_data: [{ game_id: "hijacked" }] },
    });
    expect(probe.statusCode).toBe(404);
    const check = await app.inject({ method: "GET", url: `/api/v1/account/orders/${orderCode}`, headers: { cookie } });
    expect(check.json().order.customer_data).toEqual([{ game_id: "player1" }]);
  });

  it("PATCH info: bad customer_data shape 400s error.customer_data_incomplete", async () => {
    const orderCode = await makeProcessingOrder([{ game_id: "player1" }]);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/account/orders/${orderCode}/info`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.customer_data_incomplete" });
  });

  it("PATCH info: happy path persists the normalized answers, then GET reflects them", async () => {
    const orderCode = await makeProcessingOrder([{ game_id: "player1" }]);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/account/orders/${orderCode}/info`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { customer_data: [{ game_id: "  corrected-id  " }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const check = await app.inject({ method: "GET", url: `/api/v1/account/orders/${orderCode}`, headers: { cookie } });
    expect(check.json().order.customer_data).toEqual([{ game_id: "corrected-id" }]);
  });

  it("PATCH info: the mid-edit race — an order that left PROCESSING 400s error.order_not_processing", async () => {
    const orderCode = await makeProcessingOrder([{ game_id: "player1" }]);
    await prisma.order.update({ where: { orderCode }, data: { status: OrderStatus.DELIVERED } });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/account/orders/${orderCode}/info`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { customer_data: [{ game_id: "too-late" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.order_not_processing" });
  });
});
