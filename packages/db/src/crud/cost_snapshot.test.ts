import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { addToCart } from "./cart";
import { createOrderDirect, createOrderFromCart } from "./orders";
import { completeCartOrderWithWalletCredit, completeOrderWithWalletCredit } from "./wallet_checkout";
import { adjustWallet } from "./users";
import { profitByDay, profitByPeriod, profitSummarySince, topProductsByMargin } from "./revenue";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "80000", costPrice: "70000" } });
});

describe("order item cost snapshots", () => {
  it.each([
    ["direct", "auto", "70000"],
    ["cart", "auto", "70000"],
    ["direct", "manual", "70000"],
    ["cart", "manual", "70000"],
    ["direct", "auto", "0"],
    ["cart", "manual", "0"],
    ["direct", "manual", null],
    ["cart", "auto", null],
  ] as const)("%s checkout stores per-unit %s cost %s on every line", async (path, deliveryType, costPrice) => {
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { deliveryType, costPrice } });
    if (path === "cart") await addToCart(prisma, sample.user.id, sample.product.id, 2);
    const order = path === "cart"
      ? await createOrderFromCart(prisma, { user: sample.user, channel: "web" })
      : await createOrderDirect(prisma, { user: sample.user, channel: "bot", productId: sample.product.id, quantity: 2 });
    expect(order).toBeTruthy();
    const items = await prisma.orderItem.findMany({ where: { orderId: order!.id } });
    expect(items).toHaveLength(2);
    for (const item of items) {
      const snapshot = item.costSnapshot;
      expect(snapshot == null ? snapshot : snapshot.toString()).toBe(costPrice);
    }
  });

  it.each([
    ["direct", "IDR"], ["cart", "IDR"], ["direct", "USDT"], ["cart", "USDT"],
  ] as const)("%s %s wallet checkout stores the IDR catalog cost", async (path, currency) => {
    await adjustWallet(prisma, sample.user.id, currency === "IDR" ? "160000" : "10", { reason: "test credit", currency });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    if (path === "cart") await addToCart(prisma, user.id, sample.product.id, 2);
    const args = { user, channel: "web" as const, currency, rate: "16000" };
    await prisma.$transaction(tx => path === "cart"
      ? completeCartOrderWithWalletCredit(tx, args)
      : completeOrderWithWalletCredit(tx, { ...args, productId: sample.product.id, quantity: 2 }));
    const items = await prisma.orderItem.findMany();
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.costSnapshot?.toString()).toBe("70000");
    }
  });
});

const readers = [
  { name: "topProductsByMargin", read: async () => (await topProductsByMargin(prisma, new Date(0)))[0]!.profitIdrEquiv, idr: "10000", usdt: "10000", legacy: "-10000" },
  { name: "profitSummarySince", read: async (currency: string) => (await profitSummarySince(prisma, new Date(0)))[currency === "IDR" ? "idr" : "usdt"]?.netProfit ?? null, idr: "10000", usdt: "0.625", legacy: "-10000" },
  { name: "profitByDay", read: async (currency: string) => (await profitByDay(prisma, 1))[0]![currency === "IDR" ? "profit_idr" : "profit_usdt"], idr: "10000", usdt: "0.625", legacy: "-10000" },
  { name: "profitByPeriod", read: async (currency: string) => (await profitByPeriod(prisma, "month", 1))[0]![currency === "IDR" ? "profit_idr" : "profit_usdt"], idr: "10000", usdt: "0.625", legacy: "-10000" },
];

async function soldOrder(currency: "IDR" | "USDT") {
  const order = await createOrderDirect(prisma, { user: sample.user, channel: "bot", productId: sample.product.id, quantity: 1 });
  await prisma.order.update({ where: { id: order!.id }, data: {
    status: "DELIVERED", deliveredAt: new Date(), currency,
    totalAmount: currency === "IDR" ? "80000" : "5", fxRate: currency === "USDT" ? "16000" : null,
  } });
}

describe.each(readers)("$name cost basis", reader => {
  it.each(["IDR", "USDT"] as const)("keeps %s profit unchanged when cost rises after sale", async currency => {
    await soldOrder(currency);
    expect(await reader.read(currency)).toBe(currency === "IDR" ? reader.idr : reader.usdt);
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { costPrice: "90000" } });
    expect(await reader.read(currency)).toBe(currency === "IDR" ? reader.idr : reader.usdt);
  });

  it("keeps known sale cost when the catalog cost is removed", async () => {
    await soldOrder("IDR");
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { costPrice: null } });
    expect(await reader.read("IDR")).toBe(reader.idr);
  });

  it("uses live catalog cost for a legacy null snapshot", async () => {
    const order = await prisma.order.create({ data: {
      orderCode: "COST-LEGACY", userId: sample.user.id, subtotalAmount: "80000", totalAmount: "80000",
      currency: "IDR", status: "DELIVERED", deliveredAt: new Date(),
    } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: sample.product.id, unitPrice: "80000", quantity: 1, warrantyDaysSnapshot: 30 } });
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { costPrice: "90000" } });
    expect(await reader.read("IDR")).toBe(reader.legacy);
  });

  it("keeps a zero-cost snapshot after supplier cost rises", async () => {
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { costPrice: "0" } });
    await soldOrder("IDR");
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { costPrice: "90000" } });
    expect(await reader.read("IDR")).toBe("80000");
  });
});
