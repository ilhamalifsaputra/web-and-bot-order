import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import { ordersByStatusSince, manualMatchQueueCounts, recentOrders } from "./reports";

let db: TestDb;
let prisma: PrismaClient;
let userId: number;
let parentProductId: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.denomination.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
  await prisma.processedBinanceTx.deleteMany();
  await prisma.processedBybitTx.deleteMany();
  await prisma.processedTokopayTx.deleteMany();
  await prisma.processedPaydisiniTx.deleteMany();
  await prisma.processedNowpaymentsTx.deleteMany();

  const user = await prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
  });
  userId = user.id;
  const category = await createCategory(prisma, `Cat-${Math.random()}`);
  const parentProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: `Prod-${Math.random()}`, description: "x" });
  parentProductId = parentProduct.id;
});

describe("ordersByStatusSince", () => {
  it("only counts orders created since the cutoff", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 86_400_000 * 2);
    await prisma.order.create({
      data: { orderCode: `ORD-old-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", createdAt: old },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-new-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status: "PENDING_PAYMENT", createdAt: now },
    });

    const result = await ordersByStatusSince(prisma, new Date(now.getTime() - 60_000));
    expect(result).toEqual([{ status: "PENDING_PAYMENT", count: 1 }]);
  });
});

describe("manualMatchQueueCounts", () => {
  it("sums unmatched and delivery_failed rows across all five processed-tx tables", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: `bn-${Math.random()}`, amount: "1", outcome: "unmatched" } });
    await prisma.processedBybitTx.create({ data: { bybitTxId: `by-${Math.random()}`, amount: "1", outcome: "delivery_failed" } });
    await prisma.processedTokopayTx.create({ data: { trxId: `tp-${Math.random()}`, amount: "1", outcome: "unmatched" } });
    await prisma.processedPaydisiniTx.create({ data: { trxId: `pd-${Math.random()}`, amount: "1", outcome: "matched" } });
    await prisma.processedNowpaymentsTx.create({ data: { trxId: `np-${Math.random()}`, amount: "1", outcome: "delivery_failed" } });

    const result = await manualMatchQueueCounts(prisma);
    expect(result).toEqual({ unmatched: 2, deliveryFailed: 2 });
  });
});

describe("recentOrders", () => {
  it("returns newest first, with the first item's product name and an overflow count when there are more", async () => {
    const now = new Date();
    const productA = await createDenomination(prisma, { productId: parentProductId, name: "Product A", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const productB = await createDenomination(prisma, { productId: parentProductId, name: "Product B", type: "SHARED", durationLabel: "1 Month", price: "10000" });

    const order1 = await prisma.order.create({ data: { orderCode: "ORD-1", userId, subtotalAmount: "1", totalAmount: "10000", currency: "IDR", status: "DELIVERED", createdAt: new Date(now.getTime() - 60_000) } });
    await prisma.orderItem.create({ data: { orderId: order1.id, productId: productA.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });
    await prisma.orderItem.create({ data: { orderId: order1.id, productId: productB.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const order2 = await prisma.order.create({ data: { orderCode: "ORD-2", userId, subtotalAmount: "1", totalAmount: "5000", currency: "IDR", status: "PENDING_PAYMENT", createdAt: now } });
    await prisma.orderItem.create({ data: { orderId: order2.id, productId: productA.id, quantity: 1, unitPrice: "5000", warrantyDaysSnapshot: 30 } });

    const result = await recentOrders(prisma, 10);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ orderId: order2.id, orderCode: "ORD-2", productLabel: "Product A", amount: "5000", currency: "IDR", status: "PENDING_PAYMENT" });
    expect(result[1]).toMatchObject({ orderId: order1.id, orderCode: "ORD-1", productLabel: "Product A +1 more", amount: "10000" });
  });

  it("falls back to a Telegram-id label when the user has no username", async () => {
    const product = await createDenomination(prisma, { productId: parentProductId, name: "Solo product", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const order = await prisma.order.create({ data: { orderCode: "ORD-solo", userId, subtotalAmount: "1", totalAmount: "10000", currency: "IDR", status: "DELIVERED" } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const result = await recentOrders(prisma, 10);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(result[0]!.customerLabel).toBe(`Telegram ${user.telegramId}`);
  });
});
