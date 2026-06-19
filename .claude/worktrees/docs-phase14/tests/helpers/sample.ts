/**
 * Mirror of the Python conftest `sample_data` fixture: 1 user, 1 category,
 * 1 product (price 5.00 / reseller 4.00) with 5 stock items, 1 voucher SAVE10.
 */
import type { PrismaClient } from "@prisma/client";
import {
  upsertUser,
  createCategory,
  createCatalogProduct,
  createDenomination,
  bulkAddStock,
  createVoucher,
} from "../../packages/db/src/index";
import { ProductType, VoucherType } from "../../packages/core/src/enums";

export async function seedSampleData(prisma: PrismaClient) {
  const user = await upsertUser(prisma, {
    telegramId: 42,
    username: "tester",
    fullName: "Test User",
  });
  const category = await createCategory(prisma, "Streaming", "🎬");
  const parentProduct = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: "Netflix Premium 1M",
    description: "Shared profile",
  });
  const product = await createDenomination(prisma, {
    productId: parentProduct.id,
    name: "Netflix Premium 1M",
    type: ProductType.SHARED,
    durationLabel: "1 Month",
    price: "5.00",
    resellerPrice: "4.00",
    warrantyDays: 30,
    description: "Shared profile",
  });
  await bulkAddStock(
    prisma,
    product.id,
    [1, 2, 3, 4, 5].map((i) => `user${i}@example.com:pwd${i}`),
  );
  const voucher = await createVoucher(prisma, {
    code: "SAVE10",
    type: VoucherType.PERCENT,
    value: "10",
    usageLimit: 100,
    minPurchase: "3",
  });
  return { user, category, product, voucher };
}
