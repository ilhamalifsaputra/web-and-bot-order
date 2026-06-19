/**
 * Cart crud — focused coverage for the storefront cart-line label join.
 * `getCartWithDenominationProduct` must surface the parent Product (mid-tier)
 * name alongside the Denomination (SKU), so the storefront can render
 * `Product - Denomination ×qty`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import {
  upsertUser,
  createCategory,
  createCatalogProduct,
  createDenomination,
  addToCart,
  getCartWithDenominationProduct,
} from "@app/db";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
});

describe("getCartWithDenominationProduct", () => {
  it("joins the parent product + category for the cart-line label", async () => {
    const user = await upsertUser(prisma, { telegramId: 7, username: "carttester", fullName: "Cart Tester" });
    const category = await createCategory(prisma, "Video");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "CapCut Pro" });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "30000",
    });
    await addToCart(prisma, user.id, denom.id, 2);

    const rows = await getCartWithDenominationProduct(prisma, user.id);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.quantity).toBe(2);
    // `product` is the Denomination (SKU); `product.product` is the mid-tier Product.
    expect(row.product.name).toBe("1 Month");
    expect(row.product.product.name).toBe("CapCut Pro");
    expect(row.product.product.category.name).toBe("Video");
  });
});
