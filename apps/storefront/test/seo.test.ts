// Group A of the storefront SEO quick-wins plan: GET /sitemap.xml and
// GET /robots.txt. Pattern: app.inject() against an isolated temp DB, same
// house style as storefront.test.ts / spa-api.test.ts.
import "./setup-env"; // FIRST import — sets env (incl. SHOP_PUBLIC_URL) before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import { prisma, initDb, setSetting, createCatalogProduct, createDenomination } from "@app/db";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let activeCategorySlug: string;
let activeProductSlug: string;
let inactiveCategorySlug: string;
let inactiveProductSlug: string;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await setSetting(prisma, "setup_completed", "true");

  const activeCat = await prisma.category.create({
    data: { name: "Streaming", slug: "streaming-seo", emoji: "🎬", sortOrder: 1, isActive: true },
  });
  activeCategorySlug = activeCat.slug;
  const activeProduct = await createCatalogProduct(prisma, {
    categoryId: activeCat.id,
    name: "Netflix Premium SEO",
    isActive: true,
    whatYouGet: "Private account, 1 device",
    terms: "Do not change the account email.",
    warrantyNote: "Full 30-day warranty.",
  });
  activeProductSlug = activeProduct.slug;
  await createDenomination(prisma, {
    productId: activeProduct.id,
    name: "1 Month",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "40000",
    isActive: true,
  });

  const inactiveCat = await prisma.category.create({
    data: { name: "Retired Category", slug: "retired-cat-seo", sortOrder: 2, isActive: false },
  });
  inactiveCategorySlug = inactiveCat.slug;
  const inactiveProduct = await createCatalogProduct(prisma, {
    categoryId: activeCat.id,
    name: "Retired Product SEO",
    isActive: false,
  });
  inactiveProductSlug = inactiveProduct.slug;
  await createDenomination(prisma, {
    productId: inactiveProduct.id,
    name: "1 Month",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "40000",
    isActive: true,
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

describe("GET /sitemap.xml", () => {
  it("includes active category/product URLs and excludes inactive ones", async () => {
    const res = await app.inject({ method: "GET", url: "/sitemap.xml" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/xml; charset=utf-8");
    expect(res.body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(res.body).toContain(`<loc>https://shop.test.invalid/c/${activeCategorySlug}</loc>`);
    expect(res.body).toContain(`<loc>https://shop.test.invalid/p/${activeProductSlug}</loc>`);
    expect(res.body).not.toContain(`/c/${inactiveCategorySlug}`);
    expect(res.body).not.toContain(`/p/${inactiveProductSlug}`);
    // Active product URL carries a <lastmod> (Product.createdAt, no updatedAt in schema).
    expect(res.body).toMatch(
      new RegExp(`<url><loc>https://shop\\.test\\.invalid/p/${activeProductSlug}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod></url>`),
    );
  });
});

describe("GET /robots.txt", () => {
  it("emits the expected Allow/Disallow lines and the Sitemap line", async () => {
    const res = await app.inject({ method: "GET", url: "/robots.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.body).toContain("Allow: /");
    expect(res.body).toContain("Allow: /p/");
    expect(res.body).toContain("Allow: /c/");
    expect(res.body).toContain("Allow: /search");
    expect(res.body).toContain("Disallow: /account");
    expect(res.body).toContain("Disallow: /cart");
    expect(res.body).toContain("Disallow: /checkout");
    expect(res.body).toContain("Disallow: /api/");
    expect(res.body).toContain("Sitemap: https://shop.test.invalid/sitemap.xml");
  });
});

/**
 * The storefront is a client-rendered SPA, so before seoShell() the server sent
 * a body containing nothing but `<div id="root">`. An SEO audit crawling it
 * without JavaScript reported "0 words on this page", "no H1 heading", "no
 * headings specified" and "only very few links were found" — all one bug.
 * These tests pin the crawler's view of the page.
 */
describe("crawler-visible SEO body (no JavaScript)", () => {
  it("gives the home page an H1, a paragraph and internal catalog links", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="seo-shell">');
    // Exactly one H1 — a second one is its own SEO finding.
    expect(res.body.match(/<h1>/g)).toHaveLength(1);
    expect(res.body).toMatch(/<p>[^<]+<\/p>/);
    expect(res.body).toContain(`href="/c/${activeCategorySlug}"`);
    expect(res.body).toContain(`href="/p/${activeProductSlug}"`);
    // Inactive catalog rows stay out of the crawler's link graph too.
    expect(res.body).not.toContain(`href="/c/${inactiveCategorySlug}"`);
    expect(res.body).not.toContain(`href="/p/${inactiveProductSlug}"`);
  });

  it("names the product in the H1 and links back to its category", async () => {
    const res = await app.inject({ method: "GET", url: `/p/${activeProductSlug}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<h1>Netflix Premium SEO</h1>");
    expect(res.body).toContain(`href="/c/${activeCategorySlug}"`);
    // The denomination list is the page's substance, priced as the shop shows it.
    expect(res.body).toContain("Rp40.000");
  });

  it("names the category in the H1 and lists its active products", async () => {
    const res = await app.inject({ method: "GET", url: `/c/${activeCategorySlug}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<h1>Streaming</h1>");
    expect(res.body).toContain(`href="/p/${activeProductSlug}"`);
    expect(res.body).not.toContain(`href="/p/${inactiveProductSlug}"`);
  });

  it("still returns 404 — with no SEO body — for an unknown product slug", async () => {
    const res = await app.inject({ method: "GET", url: "/p/does-not-exist-at-all" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<div id="seo-shell">');
  });

  it("omits the SEO body on private screens that robots.txt disallows", async () => {
    for (const url of ["/cart", "/account", "/checkout"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body).not.toContain('<div id="seo-shell">');
    }
  });

  it("spells the charset out in the Content-Type header, not just the meta tag", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.headers["content-type"]).toContain("charset=utf-8");
  });

  it("escapes admin-entered product text instead of injecting markup", async () => {
    const cat = await prisma.category.findFirst({ where: { slug: activeCategorySlug } });
    const nasty = await createCatalogProduct(prisma, {
      categoryId: cat!.id,
      name: 'Evil </script><img src=x onerror=alert(1)> "quoted"',
      isActive: true,
    });
    await createDenomination(prisma, {
      productId: nasty.id,
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      isActive: true,
    });
    const res = await app.inject({ method: "GET", url: `/p/${nasty.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(res.body).toContain("&quot;quoted&quot;");
    // The name also rides inside the JSON-LD payload, where it is inert: that
    // script's content isn't parsed as HTML, and `</` is escaped to `<\/` so
    // the tag can't be closed early. Strip that block out and require the rest
    // of the document — the part a browser DOES parse as HTML — to be clean.
    const parsedAsHtml = res.body.replace(
      /<script type="application\/ld\+json">[\s\S]*?<\/script>/g,
      "",
    );
    expect(parsedAsHtml).not.toContain("<img src=x onerror=alert(1)>");
  });
});

describe("metadata for search results and social previews", () => {
  it("gives the home page a title that says what the shop sells", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    // The audit flagged the old title ("Trustance") as one word / far too
    // short, so the tagline now rides along with the shop name.
    const title = /<title>([^<]*)<\/title>/.exec(res.body)?.[1] ?? "";
    expect(title).toContain("Toko Digital");
    expect(title.split(/\s+/).length).toBeGreaterThan(3);
  });

  it("emits Open Graph and Twitter tags with an absolute URL", async () => {
    const res = await app.inject({ method: "GET", url: `/p/${activeProductSlug}` });
    expect(res.body).toContain('<meta property="og:site_name"');
    expect(res.body).toContain('<meta property="og:description"');
    expect(res.body).toContain('<meta property="og:url" content="https://shop.test.invalid/p/');
    expect(res.body).toContain('<meta property="og:type" content="product">');
    expect(res.body).toContain('<meta name="twitter:card"');
  });

  it("gives every public page a meta description", async () => {
    for (const url of ["/", `/p/${activeProductSlug}`, `/c/${activeCategorySlug}`, "/search"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body, `missing description on ${url}`).toContain('<meta name="description"');
    }
  });

  it("keeps the home meta description inside a search snippet, independent of the hero copy", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    const desc = /<meta name="description" content="([^"]*)">/.exec(res.body)?.[1] ?? "";
    // Its own key (web.home_meta_description), not the hero subtitle — page
    // copy is free to grow, a snippet is not.
    expect(desc.length).toBeGreaterThan(50);
    expect(desc.length).toBeLessThanOrEqual(160);
    expect(desc).not.toBe("");
  });

  it("puts the home page's prose sections in the crawler shell, not just product links", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    const shell = /<div id="seo-shell">([\s\S]*?)<\/div>/.exec(res.body)?.[1] ?? "";
    expect(shell).toContain("Four steps, done");
    expect(shell).toContain("Why buying here is safe");
    // Whatever the shell claims must also be on the rendered page — anything
    // written only for crawlers is cloaking.
    expect(shell).toContain("Pick a product &amp; plan");
  });

  it("serves the informational pages as real, indexable pages with crawler-visible prose", async () => {
    for (const url of ["/about", "/how-to-order", "/terms", "/privacy", "/refund"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} should not 404`).toBe(200);
      expect(res.body, `${url} needs an <h1>`).toMatch(/<div id="seo-shell">[\s\S]*<h1>/);
      expect(res.body, `${url} needs a description`).toContain('<meta name="description"');
      // These exist to be found — a noindex here would defeat the point.
      expect(res.body, `${url} must stay indexable`).not.toContain("noindex");
      expect(res.body).toContain('<link rel="canonical" href="https://shop.test.invalid' + url + '"');
    }
  });

  it("puts the product's detail blocks in the crawler shell and its structured data", async () => {
    const res = await app.inject({ method: "GET", url: `/p/${activeProductSlug}` });
    const shell = /<div id="seo-shell">([\s\S]*?)<\/div>/.exec(res.body)?.[1] ?? "";
    expect(shell).toContain("Private account, 1 device");
    expect(shell).toContain("Do not change the account email.");
    expect(shell).toContain("Full 30-day warranty.");
    // "What you get" is often the only statement of what's in the box, so it
    // rides along in the Product schema description too.
    const ld = /"@type":"Product"[\s\S]*?<\/script>/.exec(res.body)?.[0] ?? "";
    expect(ld).toContain("Private account, 1 device");
  });

  it("lists the home and informational pages in the sitemap", async () => {
    const res = await app.inject({ method: "GET", url: "/sitemap.xml" });
    for (const p of ["/", "/about", "/how-to-order", "/terms", "/privacy", "/refund"]) {
      expect(res.body, `sitemap missing ${p}`).toContain(`<loc>https://shop.test.invalid${p}</loc>`);
    }
  });

  it("only claims analytics on the privacy page when the shop actually loads it", async () => {
    // web_analytics_id is unset in this fixture shop, so the section that
    // describes Google Analytics must not appear.
    const res = await app.inject({ method: "GET", url: "/privacy" });
    expect(res.body).not.toContain("Google Analytics");
    expect(res.body).toContain("What we store");
  });

  it("marks private screens noindex so a pasted link can't be indexed", async () => {
    for (const url of ["/cart", "/account", "/login"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body, `missing noindex on ${url}`).toContain('content="noindex, nofollow"');
    }
    // ...and never marks a page we DO want indexed.
    const home = await app.inject({ method: "GET", url: "/" });
    expect(home.body).not.toContain("noindex");
  });

  it("declares an apple-touch-icon for iOS home-screen shortcuts", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain('rel="apple-touch-icon"');
  });
});

describe("optional Google Analytics", () => {
  it("ships no analytics and no third-party request when unset", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).not.toContain("googletagmanager");
  });

  it("loads GA4 once a measurement ID is configured", async () => {
    await setSetting(prisma, "web_analytics_id", "G-ABC1234XYZ");
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.body).toContain("googletagmanager.com/gtag/js?id=G-ABC1234XYZ");
      expect(res.body).toContain("gtag('config','G-ABC1234XYZ')");
    } finally {
      await setSetting(prisma, "web_analytics_id", "");
    }
  });

  it("drops a malformed ID rather than injecting it into a script tag", async () => {
    await setSetting(prisma, "web_analytics_id", "G-X');alert(1);//");
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      // No loader, and no trace of the payload — the ID is dropped, not escaped.
      expect(res.body).not.toContain("googletagmanager");
      expect(res.body).not.toContain("gtag(");
      expect(res.body).not.toContain("');alert(1);//");
    } finally {
      await setSetting(prisma, "web_analytics_id", "");
    }
  });
});
