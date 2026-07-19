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
