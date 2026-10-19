import "./setup-env";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, initDb, createCatalogProduct, createDenomination, setSetting, deleteSetting, createWebUser } from "@app/db";
import { hashPassword } from "@app/core/password";
import { CanonicalProductSchema } from "@app/core/canonicalProduct";
import { productPageData } from "../src/pageData";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let slug: string;
let id: number;
beforeAll(async () => {
  await initDb();
  await setSetting(prisma, "setup_completed", "true");
  app = await buildApp();
  const category = await prisma.category.create({ data: { name: "Canonical", slug: "canonical-fixture" } });
  const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Mobile Legends", gameRegion: "Indonesia" });
  slug = product.slug;
  const denomination = await createDenomination(prisma, { productId: product.id, name: "86 Diamonds + 8 Bonus Global", durationLabel: "86 Diamonds + 8 Bonus Global", type: "SHARED", price: "21000.1254", deliveryType: "manual" });
  id = denomination.id;
  await prisma.denomination.update({ where: { id }, data: { supplierRawName: "Mobile Legends 86 Diamonds + 8 Bonus Global", supplierSku: "synthetic-86", resellerPrice: "20000.1234" } });
});
afterAll(async () => { await app?.close(); await prisma.$disconnect(); });

describe("canonical API contract", () => {
  it.each(["/pages/product/", "/products/"])("provides validated exact semantic data on %s detail", async (prefix) => {
    const res = await app.inject({ url: `/api/v1${prefix}${slug}`, headers: { cookie: "shop_lang=id; shop_currency=IDR" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("private");
    const body = res.json();
    const d = (body.denominations ?? body.product.denominations)[0];
    const canonical = CanonicalProductSchema.parse(d.canonical);
    expect(canonical).toMatchObject({ id, supplierSku: "synthetic-86", displayName: "86 Diamonds + 8 Bonus Global", formattedPrice: "Rp21.000", availability: { purchasable: true }, priceIDR: { amountMinor: "21000", scale: 0 } });
    expect(canonical.qualifiers).toContain("Indonesia");
    expect(JSON.stringify(d)).not.toMatch(/costPrice|supplierPrice|additionalFields|metadata/);
  });
  it("matches legacy list and denomination list with detail", async () => {
    const headers = { cookie: "shop_lang=id; shop_currency=IDR" };
    const detail = await app.inject({ url: `/api/v1/pages/product/${slug}`, headers });
    const { generatedAt: _detailTime, ...expected } = CanonicalProductSchema.parse(detail.json().denominations[0].canonical);
    for (const url of ["/api/v1/products", `/api/v1/products/${slug}/denominations`]) {
      const res = await app.inject({ url, headers });
      const body = res.json();
      const denominations = body.denominations ?? body.products.find((p: { slug: string }) => p.slug === slug).denominations;
      const { generatedAt: _listTime, ...actual } = CanonicalProductSchema.parse(denominations[0].canonical);
      expect(actual).toEqual(expected);
      expect(res.headers["cache-control"]).toContain("no-store");
    }
  });
  it("uses viewer effective reseller price rather than catalog base price", async () => {
    const page = await productPageData(slug, true);
    expect(page!.denominations[0]!.canonical.priceIDR).toEqual({ currency: "IDR", amountMinor: "20000", scale: 0 });
  });
  it("partitions viewer prices and context across an authenticated reseller and guest", async () => {
    const user = await createWebUser(prisma, { loginUsername: "canonical-reseller", email: "canonical@example.invalid", passwordHash: hashPassword("CanonicalTest-123"), fullName: "Fixture" });
    await prisma.user.update({ where: { id: user.id }, data: { role: "RESELLER" } });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "canonical-reseller", password: "CanonicalTest-123" } });
    expect(login.statusCode).toBe(200);
    const cookies = login.headers["set-cookie"];
    const cookie = Array.isArray(cookies) ? cookies.join("; ") : String(cookies);
    const context = await app.inject({ url: "/api/v1/pages/context", headers: { cookie } });
    expect(context.json().pricing_context).toBe(`${user.id}:RESELLER`);
    for (const prefix of ["/pages/product/", "/products/"]) {
      const reseller = await app.inject({ url: `/api/v1${prefix}${slug}`, headers: { cookie } });
      const guest = await app.inject({ url: `/api/v1${prefix}${slug}` });
      const read = (body: { denominations?: Array<{ canonical: { priceIDR: { amountMinor: string } } }>; product?: { denominations: Array<{ canonical: { priceIDR: { amountMinor: string } } }> } }) => (body.denominations ?? body.product!.denominations)[0]!.canonical.priceIDR.amountMinor;
      expect(read(reseller.json())).toBe("20000");
      expect(read(guest.json())).toBe("21000");
      expect(reseller.headers["cache-control"]).toContain("no-store");
    }
  });
  it("retains complete semantic data in current cart and final checkout preview", async () => {
    const cookie = `shop_cart_v2=${encodeURIComponent(JSON.stringify({ v: 2, items: [{ p: id, q: 1 }] }))}; shop_lang=id`;
    for (const path of ["cart", "checkout"]) {
      const res = await app.inject({ url: `/api/v1/${path}`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const canonical = CanonicalProductSchema.parse(res.json().items[0].canonical);
      expect(canonical.displayName).toContain("8 Bonus Global");
      expect(canonical.qualifiers).toContain("Indonesia");
      expect(canonical.formattedPrice).toBe("Rp21.000");
    }
  });
  it("formats preference per request with real rate confirmation and safe missing-rate fallback", async () => {
    await setSetting(prisma, "usd_idr_rate", "16000");
    const asOf = new Date().toISOString();
    await setSetting(prisma, "usd_idr_rate_updated_at", asOf);
    const usd = await app.inject({ url: `/api/v1/pages/product/${slug}`, headers: { cookie: "shop_currency=USD; shop_lang=en" } });
    const canonical = usd.json().denominations[0].canonical;
    expect(canonical.formattedPrice).toBe("$1.32");
    expect(canonical.conversion).toMatchObject({ source: "settings:usd_idr_rate", asOf, basis: "USDT", rate: "16000" });
    await setSetting(prisma, "usd_idr_rate", "invalid");
    const fallback = await app.inject({ url: `/api/v1/pages/product/${slug}`, headers: { cookie: "shop_currency=USD; shop_lang=en" } });
    expect(fallback.json().denominations[0].canonical).toMatchObject({ currencyFallback: true, formattedPrice: "Rp21,000", conversion: null });
    await deleteSetting(prisma, "usd_idr_rate");
  });
});
