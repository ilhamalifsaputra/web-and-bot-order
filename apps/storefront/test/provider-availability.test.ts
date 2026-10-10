/**
 * Storefront availability follows @app/core/productAvailability, the same
 * rule the order server applies: an `auto` + `digiflazz` SKU with no local
 * stock rows is a provider SKU and stays purchasable; an `auto` SKU without a
 * provider source and with no stock is out of stock; an inactive SKU is
 * inactive. PDP, cards, cart, checkout, API v1 and the product JSON-LD must
 * all give the same answer, and it must match the canonical object the bot
 * builds from the same resolver.
 */
import "./setup-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, initDb, createCatalogProduct, createDenomination, setSetting } from "@app/db";
import { canonicalProduct, CanonicalProductSchema } from "@app/core/canonicalProduct";
import { hasSellableStock, resolveDenominationAvailability } from "@app/core/productAvailability";
import { productPageData } from "../src/pageData";
import { buildApp } from "../src/server";

type Combo = { deliveryType: "auto" | "manual"; source: string | null; stock: number };
const COMBOS: Combo[] = [];
for (const deliveryType of ["auto", "manual"] as const) {
  for (const source of [null, "digiflazz"]) {
    for (const stock of [0, 2]) COMBOS.push({ deliveryType, source, stock });
  }
}
const label = (c: Combo) => `${c.deliveryType}/${c.source ?? "none"}/stock ${c.stock}`;
const expectPurchasable = (c: Combo) => !(c.deliveryType === "auto" && c.source === null && c.stock === 0);

let app: FastifyInstance;
let matrixSlug: string;
let mixedSlug: string;
let providerOnlySlug: string;
let localOnlySlug: string;
const ids = new Map<string, number>();
let inactiveId: number;

async function addStock(denominationId: number, count: number) {
  if (count === 0) return;
  await prisma.stockItem.createMany({
    data: Array.from({ length: count }, (_, i) => ({ productId: denominationId, credentials: `cred-${denominationId}-${i}`, status: "AVAILABLE" })),
  });
}

beforeAll(async () => {
  await initDb();
  await setSetting(prisma, "setup_completed", "true");
  app = await buildApp();
  const category = await prisma.category.create({ data: { name: "Availability", slug: "availability-fixture" } });
  const matrix = await createCatalogProduct(prisma, { categoryId: category.id, name: "Matrix Product" });
  matrixSlug = matrix.slug;
  let price = 10000;
  for (const c of COMBOS) {
    const d = await createDenomination(prisma, {
      productId: matrix.id, name: label(c), durationLabel: label(c), type: "SHARED",
      price: String(price += 1000), deliveryType: c.deliveryType, autoDeliverySource: c.source,
    });
    await addStock(d.id, c.stock);
    ids.set(label(c), d.id);
  }
  const inactive = await createDenomination(prisma, {
    productId: matrix.id, name: "Inactive provider", durationLabel: "Inactive provider", type: "SHARED",
    price: "99000", deliveryType: "auto", autoDeliverySource: "digiflazz", isActive: false,
  });
  inactiveId = inactive.id;

  // Mixed: one local SKU with 3 rows + one provider SKU with none.
  const mixed = await createCatalogProduct(prisma, { categoryId: category.id, name: "Mixed Product" });
  mixedSlug = mixed.slug;
  const mixedLocal = await createDenomination(prisma, { productId: mixed.id, name: "Local", durationLabel: "Local", type: "SHARED", price: "5000", deliveryType: "auto" });
  await addStock(mixedLocal.id, 3);
  await createDenomination(prisma, { productId: mixed.id, name: "Provider", durationLabel: "Provider", type: "SHARED", price: "6000", deliveryType: "auto", autoDeliverySource: "digiflazz" });

  const providerOnly = await createCatalogProduct(prisma, { categoryId: category.id, name: "Provider Only" });
  providerOnlySlug = providerOnly.slug;
  await createDenomination(prisma, { productId: providerOnly.id, name: "P1", durationLabel: "P1", type: "SHARED", price: "7000", deliveryType: "auto", autoDeliverySource: "digiflazz" });

  const localOnly = await createCatalogProduct(prisma, { categoryId: category.id, name: "Local Only" });
  localOnlySlug = localOnly.slug;
  const localOnlyDenom = await createDenomination(prisma, { productId: localOnly.id, name: "L1", durationLabel: "L1", type: "SHARED", price: "8000", deliveryType: "auto" });
  await addStock(localOnlyDenom.id, 2);
});
afterAll(async () => { await app?.close(); await prisma.$disconnect(); });

describe("product page availability", () => {
  it.each(COMBOS)("$deliveryType / $source / stock $stock", async (c) => {
    const page = await productPageData(matrixSlug);
    const d = page!.denominations.find((x) => x.id === ids.get(label(c)))!;
    expect(d.canonical.availability.purchasable).toBe(expectPurchasable(c));
    expect(d.canonical.availability.status).toBe(expectPurchasable(c) ? "available" : "out_of_stock");
    expect(d.purchasable).toBe(expectPurchasable(c));
    expect(d.uses_local_inventory).toBe(c.deliveryType === "auto" && c.source === null);
  });

  it("never lists an inactive SKU", async () => {
    const page = await productPageData(matrixSlug);
    expect(page!.denominations.some((d) => d.id === inactiveId)).toBe(false);
  });

  it("matches API v1 and the canonical object the bot builds from the resolver", async () => {
    const page = await productPageData(matrixSlug);
    const res = await app.inject({ url: `/api/v1/products/${matrixSlug}/denominations` });
    expect(res.statusCode).toBe(200);
    const api = res.json().denominations as Array<{ id: number; status: string; canonical: unknown }>;
    for (const c of COMBOS) {
      const id = ids.get(label(c))!;
      const pdp = page!.denominations.find((x) => x.id === id)!;
      const v1 = api.find((x) => x.id === id)!;
      expect(CanonicalProductSchema.parse(v1.canonical).availability).toEqual(pdp.canonical.availability);
      expect(v1.status === "out_of_stock").toBe(!expectPurchasable(c));
      const denom = await prisma.denomination.findUniqueOrThrow({ where: { id }, include: { product: { include: { category: true } } } });
      const bot = canonicalProduct(
        { denomination: { ...denom, createdAt: denom.createdAt.toISOString() }, product: denom.product, category: denom.product.category, stockAvailable: hasSellableStock(denom, c.stock) },
        { effectivePriceIDR: denom.price.toString(), preferredCurrency: "IDR" },
      );
      expect(bot.availability).toEqual(pdp.canonical.availability);
    }
  });

  it("keeps an inactive provider SKU inactive for the bot and storefront alike", async () => {
    const denom = await prisma.denomination.findUniqueOrThrow({ where: { id: inactiveId }, include: { product: { include: { category: true } } } });
    const canonical = canonicalProduct(
      { denomination: { ...denom, createdAt: denom.createdAt.toISOString() }, product: denom.product, category: denom.product.category, stockAvailable: hasSellableStock(denom, 0) },
      { effectivePriceIDR: denom.price.toString(), preferredCurrency: "IDR" },
    );
    expect(canonical.availability).toEqual({ status: "inactive", purchasable: false });
    expect(resolveDenominationAvailability({ denom, productActive: true, categoryActive: true, availableStock: 0 }).reason).toBe("admin_inactive");
  });
});

describe("product cards", () => {
  async function card(slug: string) {
    const res = await app.inject({ url: "/api/v1/pages/category/availability-fixture" });
    expect(res.statusCode).toBe(200);
    return (res.json().products as Array<Record<string, unknown>>).find((p) => p.slug === slug)!;
  }

  it("a provider-only product is never out of stock and shows no stock count", async () => {
    const c = await card(providerOnlySlug);
    expect(c).toMatchObject({ all_non_auto: true, all_local_inventory: false, available: 0 });
  });

  it("a mixed product does not present its partial local stock as the product's stock", async () => {
    const c = await card(mixedSlug);
    expect(c).toMatchObject({ all_non_auto: false, all_local_inventory: false });
  });

  it("a local-only product keeps its real stock count", async () => {
    const c = await card(localOnlySlug);
    expect(c).toMatchObject({ all_non_auto: false, all_local_inventory: true, available: 2 });
  });
});

describe("cart and checkout accept a provider SKU with no stock rows", () => {
  const cookieFor = (id: number) => `shop_cart_v2=${encodeURIComponent(JSON.stringify({ v: 2, items: [{ p: id, q: 1 }] }))}; shop_lang=en`;

  it("auto + digiflazz with stock 0 is purchasable in cart and checkout", async () => {
    const id = ids.get(label({ deliveryType: "auto", source: "digiflazz", stock: 0 }))!;
    const cart = await app.inject({ url: "/api/v1/cart", headers: { cookie: cookieFor(id) } });
    expect(cart.statusCode).toBe(200);
    const line = cart.json().items[0];
    expect(line.canonical.availability.purchasable).toBe(true);
    expect(line.uses_local_inventory).toBe(false);
    const checkout = await app.inject({ url: "/api/v1/checkout", headers: { cookie: cookieFor(id) } });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json().items[0].canonical.availability.purchasable).toBe(true);
  });

  it("auto without a provider and stock 0 stays out of stock", async () => {
    const id = ids.get(label({ deliveryType: "auto", source: null, stock: 0 }))!;
    const cart = await app.inject({ url: "/api/v1/cart", headers: { cookie: cookieFor(id) } });
    const line = cart.json().items[0];
    expect(line.canonical.availability.status).toBe("out_of_stock");
    expect(line.uses_local_inventory).toBe(true);
  });
});

describe("product JSON-LD", () => {
  it("a provider-only product is InStock", async () => {
    const res = await app.inject({ url: `/p/${providerOnlySlug}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("https://schema.org/InStock");
    expect(res.body).not.toContain("https://schema.org/OutOfStock");
  });
});
