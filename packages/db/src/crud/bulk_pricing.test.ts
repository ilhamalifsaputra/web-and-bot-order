import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { upsertBulkPricing, activeBulkPricingByProduct } from "./catalog";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

async function makeProduct(name: string) {
  const cat = await prisma.category.create({ data: { name: `c${Math.random()}` } });
  return prisma.product.create({
    data: { categoryId: cat.id, name, type: "SHARED", durationLabel: "1 Month", price: "5" },
  });
}

describe("activeBulkPricingByProduct (storefront discount badge)", () => {
  it("maps product id → rule and excludes inactive rules", async () => {
    const withRule = await makeProduct("with-rule");
    const inactive = await makeProduct("inactive");
    const noRule = await makeProduct("no-rule");

    await upsertBulkPricing(prisma, { productId: withRule.id, minQuantity: 3, discountPercent: 10 });
    await upsertBulkPricing(prisma, { productId: inactive.id, minQuantity: 5, discountPercent: 20 });
    // turn the second rule off
    await prisma.bulkPricing.update({ where: { productId: inactive.id }, data: { isActive: false } });

    const map = await activeBulkPricingByProduct(prisma);

    expect(map[withRule.id]?.minQuantity).toBe(3);
    expect(Number(map[withRule.id]?.discountPercent)).toBe(10); // numeric: tolerant of "10" vs "10.00"
    expect(map[inactive.id]).toBeUndefined(); // inactive rule excluded
    expect(map[noRule.id]).toBeUndefined(); // products without a rule are absent
  });
});
