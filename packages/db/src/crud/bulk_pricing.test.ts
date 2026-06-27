import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  upsertBulkPricing,
  activeBulkPricingByDenomination,
  createCategory,
  createCatalogProduct,
  createDenomination,
} from "./catalog";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

/** Seed a denomination (the sellable SKU) under its own product + category. */
async function makeProduct(name: string) {
  const cat = await createCategory(prisma, `c${Math.random()}`);
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name });
  return createDenomination(prisma, {
    productId: product.id,
    name,
    type: "SHARED",
    durationLabel: "1 Month",
    price: "5",
  });
}

describe("activeBulkPricingByDenomination (storefront discount badge)", () => {
  it("maps denomination id → rule and excludes inactive rules", async () => {
    const withRule = await makeProduct("with-rule");
    const inactive = await makeProduct("inactive");
    const noRule = await makeProduct("no-rule");

    await upsertBulkPricing(prisma, { denominationId: withRule.id, minQuantity: 3, discountPercent: 10 });
    await upsertBulkPricing(prisma, { denominationId: inactive.id, minQuantity: 5, discountPercent: 20 });
    // turn the second rule off
    await prisma.bulkPricing.update({ where: { productId: inactive.id }, data: { isActive: false } });

    const map = await activeBulkPricingByDenomination(prisma);

    expect(map[withRule.id]?.minQuantity).toBe(3);
    expect(Number(map[withRule.id]?.discountPercent)).toBe(10); // numeric: tolerant of "10" vs "10.00"
    expect(map[inactive.id]).toBeUndefined(); // inactive rule excluded
    expect(map[noRule.id]).toBeUndefined(); // products without a rule are absent
  });
});

// Pricing-4 (security audit, 2026-06-23): a misconfigured discountPercent is
// the only thing standing between an admin typo and a free (Rp0) order.
describe("upsertBulkPricing discountPercent bounds", () => {
  it("rejects discountPercent > 100", async () => {
    const p = await makeProduct("over-100");
    await expect(
      upsertBulkPricing(prisma, { denominationId: p.id, minQuantity: 2, discountPercent: 150 }),
    ).rejects.toMatchObject({ key: "error.invalid_discount_percent" });
    expect(await prisma.bulkPricing.findUnique({ where: { productId: p.id } })).toBeNull();
  });

  it("rejects discountPercent === 0 and negative", async () => {
    const p = await makeProduct("zero-or-negative");
    await expect(
      upsertBulkPricing(prisma, { denominationId: p.id, minQuantity: 2, discountPercent: 0 }),
    ).rejects.toMatchObject({ key: "error.invalid_discount_percent" });
    await expect(
      upsertBulkPricing(prisma, { denominationId: p.id, minQuantity: 2, discountPercent: -10 }),
    ).rejects.toMatchObject({ key: "error.invalid_discount_percent" });
  });

  it("accepts exactly 100", async () => {
    const p = await makeProduct("exactly-100");
    const rule = await upsertBulkPricing(prisma, { denominationId: p.id, minQuantity: 2, discountPercent: 100 });
    expect(Number(rule.discountPercent)).toBe(100);
  });
});
