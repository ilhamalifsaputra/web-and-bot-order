/**
 * Shared test fixture — the Vitest port of conftest.py's `sample_data`:
 * 1 user, 1 category, 1 product with 5 stock items, 1 voucher.
 *
 * `resetDb` wipes all rows (FK-safe order) so a single test DB can be reused
 * across tests in a file — far cheaper than spinning a fresh `prisma db push`
 * per test. Call resetDb + buildSampleData in beforeEach.
 */
import type { PrismaClient } from "@prisma/client";
import {
  upsertUser,
  createCategory,
  createProduct,
  bulkAddStock,
  createVoucher,
} from "@app/db";
import { ProductType, VoucherType } from "@app/core/enums";

export async function buildSampleData(prisma: PrismaClient) {
  const user = await upsertUser(prisma, {
    telegramId: 42,
    username: "tester",
    fullName: "Test User",
  });
  const category = await createCategory(prisma, "Streaming", "🎬");
  const product = await createProduct(prisma, {
    categoryId: category.id,
    name: "Netflix Premium 1M",
    description: "Shared profile",
    type: ProductType.SHARED,
    durationLabel: "1 Month",
    price: "5.00",
    resellerPrice: "4.00",
    warrantyDays: 30,
  });
  await bulkAddStock(
    prisma,
    product.id,
    Array.from({ length: 5 }, (_, i) => `user${i + 1}@example.com:pwd${i + 1}`),
  );
  const voucher = await createVoucher(prisma, {
    code: "SAVE10",
    type: VoucherType.PERCENT,
    value: "10",
    usageLimit: 100,
    minPurchase: "3",
  });
  // `createProduct` (deprecated shim) auto-creates a 1:1 wrapper mid-tier Product
  // over the denomination. `product` is the Denomination/SKU (id used by the
  // order/stock flow); `parentProduct` is that wrapper Product (the row the bot's
  // flat list now shows and whose picker collapses to this single denomination).
  const parentProduct = await prisma.product.findUniqueOrThrow({ where: { id: product.productId } });
  return { user, category, product, parentProduct, voucher };
}

export type SampleData = Awaited<ReturnType<typeof buildSampleData>>;

/** Delete every row, children before parents, so each test starts clean. */
export async function resetDb(prisma: PrismaClient) {
  await prisma.notificationOutbox.deleteMany();
  await prisma.ticketMessage.deleteMany();
  await prisma.supportTicket.deleteMany();
  await prisma.review.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.restockSubscription.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.bulkPricing.deleteMany();
  await prisma.stockItem.deleteMany();
  await prisma.denomination.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.broadcast.deleteMany();
  await prisma.setting.deleteMany();
  await prisma.user.deleteMany();
}
