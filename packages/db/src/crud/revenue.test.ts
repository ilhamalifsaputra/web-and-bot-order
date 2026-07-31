import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { OrderStatus } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import {
  revenueByDay,
  revenueSummary,
  profitSummarySince,
  topProductsByMargin,
  ordersByDay,
  combinedRevenueByDay,
} from "./revenue";

let db: TestDb;
let prisma: PrismaClient;
let userId: number;
let parentProductId: number;
let parentProductName: string;

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

  const user = await prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
  });
  userId = user.id;
  const category = await createCategory(prisma, `Cat-${Math.random()}`);
  const parentProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: `Prod-${Math.random()}`, description: "x" });
  parentProductId = parentProduct.id;
  parentProductName = parentProduct.name;
});

describe("revenueByDay", () => {
  it("keeps a delivered USDT order's total out of the IDR bucket for the same day", async () => {
    const now = new Date();
    await prisma.order.create({
      data: {
        orderCode: `ORD-idr-${Math.random()}`, userId,
        subtotalAmount: "54000", totalAmount: "54000", currency: "IDR",
        status: "DELIVERED", deliveredAt: now,
      },
    });
    await prisma.order.create({
      data: {
        orderCode: `ORD-usdt-${Math.random()}`, userId,
        subtotalAmount: "54000", totalAmount: "3.43", currency: "USDT", fxRate: "16000",
        status: "DELIVERED", deliveredAt: now,
      },
    });

    const days = await revenueByDay(prisma, 1);
    expect(days).toHaveLength(1);
    const today = days[0]!;
    expect(today.orders).toBe(2);
    // The IDR bucket must be exactly the IDR order's total — the USDT order's
    // 3.43 must never land in this number (that's the reports-page equivalent
    // of the "Rp3" display bug: a tiny USDT figure silently added to Rupiah).
    expect(today.revenue_idr).toBe("54000");
    expect(today.revenue_usdt).toBe("3.43");
  });

  it("fills empty days with zero in both currencies", async () => {
    const days = await revenueByDay(prisma, 3);
    expect(days).toHaveLength(3);
    for (const d of days) {
      expect(d.revenue_idr).toBe("0");
      expect(d.revenue_usdt).toBe("0");
      expect(d.orders).toBe(0);
    }
  });
});

describe("revenueSummary", () => {
  it("excludes orders delivered after `until`", async () => {
    const now = new Date();
    const before = new Date(now.getTime() - 60_000);
    await prisma.order.create({
      data: { orderCode: `ORD-a-${Math.random()}`, userId, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: before },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-b-${Math.random()}`, userId, subtotalAmount: "20000", totalAmount: "20000", currency: "IDR", status: "DELIVERED", deliveredAt: now },
    });

    const result = await revenueSummary(prisma, new Date(now.getTime() - 120_000), before);
    expect(result.revenue_idr.toString()).toBe("10000");
    expect(result.orders).toBe(1);
  });

  it("defaults `until` to now when omitted", async () => {
    const now = new Date();
    await prisma.order.create({
      data: { orderCode: `ORD-c-${Math.random()}`, userId, subtotalAmount: "5000", totalAmount: "5000", currency: "IDR", status: "DELIVERED", deliveredAt: now },
    });
    const result = await revenueSummary(prisma, new Date(now.getTime() - 60_000));
    expect(result.revenue_idr.toString()).toBe("5000");
  });
});

describe("profitSummarySince", () => {
  it("splits net profit and margin% by currency, converting a USDT bucket's IDR-native revenue AND cost via the order's own fxRate — never blending IDR and USDT", async () => {
    const now = new Date();
    const idrProduct = await createDenomination(prisma, { productId: parentProductId, name: "IDR item", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "6000" });
    const usdtProduct = await createDenomination(prisma, { productId: parentProductId, name: "USDT item", type: "SHARED", durationLabel: "1 Month", price: "160000", costPrice: "32000" });

    const idrOrder = await prisma.order.create({ data: { orderCode: `ORD-idr-${Math.random()}`, userId, subtotalAmount: "20000", totalAmount: "20000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: idrOrder.id, productId: idrProduct.id, quantity: 2, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    // unitPrice is the catalog IDR price verbatim (160000) — exactly what
    // createOrderFromCart/createOrderDirect actually write, regardless of the
    // order settling in USDT. It must NOT be pre-divided by fxRate in the
    // fixture; profitSummarySince itself is responsible for the conversion.
    const usdtOrder = await prisma.order.create({ data: { orderCode: `ORD-usdt-${Math.random()}`, userId, subtotalAmount: "160000", totalAmount: "10", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: usdtOrder.id, productId: usdtProduct.id, quantity: 1, unitPrice: "160000", warrantyDaysSnapshot: 30 } });

    const result = await profitSummarySince(prisma, new Date(now.getTime() - 60_000));
    // IDR: revenue 2x10000=20000, cost 2x6000=12000 -> profit 8000, margin 40%
    expect(result.idr).toEqual({ netProfit: "8000", marginPct: "40", excludedItemCount: 0 });
    // USDT: revenue 160000 IDR / fxRate 16000 = 10 USDT-equiv, cost 32000 IDR / fxRate 16000 = 2 USDT-equiv -> profit 8, margin 80%
    expect(result.usdt).toEqual({ netProfit: "8", marginPct: "80", excludedItemCount: 0 });
  });

  it("excludes items with no costPrice from profit and margin%, but still counts them", async () => {
    const now = new Date();
    const noCostProduct = await createDenomination(prisma, { productId: parentProductId, name: "No cost item", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const order = await prisma.order.create({ data: { orderCode: `ORD-nc-${Math.random()}`, userId, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: noCostProduct.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const result = await profitSummarySince(prisma, new Date(now.getTime() - 60_000));
    expect(result.idr).toEqual({ netProfit: "0", marginPct: null, excludedItemCount: 1 });
  });

  it("excludes a USDT item with no costPrice from profit and margin%, but still counts it", async () => {
    const now = new Date();
    const noCostProduct = await createDenomination(prisma, { productId: parentProductId, name: "No cost USDT item", type: "SHARED", durationLabel: "1 Month", price: "160000" });
    const order = await prisma.order.create({ data: { orderCode: `ORD-nc-usdt-${Math.random()}`, userId, subtotalAmount: "160000", totalAmount: "10", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: noCostProduct.id, quantity: 1, unitPrice: "160000", warrantyDaysSnapshot: 30 } });

    const result = await profitSummarySince(prisma, new Date(now.getTime() - 60_000));
    expect(result.usdt).toEqual({ netProfit: "0", marginPct: null, excludedItemCount: 1 });
  });

  it("excludes a no-cost item's revenue from the bucket while still summing a priced item alongside it", async () => {
    const now = new Date();
    const pricedProduct = await createDenomination(prisma, { productId: parentProductId, name: "Priced item", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "6000" });
    const noCostProduct = await createDenomination(prisma, { productId: parentProductId, name: "No cost item", type: "SHARED", durationLabel: "1 Month", price: "5000" });
    const order = await prisma.order.create({ data: { orderCode: `ORD-mix-${Math.random()}`, userId, subtotalAmount: "15000", totalAmount: "15000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: pricedProduct.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: noCostProduct.id, quantity: 1, unitPrice: "5000", warrantyDaysSnapshot: 30 } });

    const result = await profitSummarySince(prisma, new Date(now.getTime() - 60_000));
    // Only the priced item contributes: revenue 10000, cost 6000 -> profit 4000, margin 40%.
    // The no-cost item's 5000 revenue must not leak into the bucket.
    expect(result.idr).toEqual({ netProfit: "4000", marginPct: "40", excludedItemCount: 1 });
  });

  it("returns null for a currency with no delivered items in range", async () => {
    const result = await profitSummarySince(prisma, new Date());
    expect(result.idr).toBeNull();
    expect(result.usdt).toBeNull();
  });

  it("prorates the order's bulkDiscountAmount + discountAmount into line revenue so a voucher-discounted order that actually lost money reports a loss, not the gross-revenue profit (M-1)", async () => {
    const now = new Date();
    // Gross (pre-discount) numbers alone would show a healthy profit:
    // revenue 10000, cost 8000 -> +2000 (20% margin). But the order carries a
    // Rp1000 bulk discount + Rp2000 voucher discount (3000 total) that the
    // buyer actually paid less for — netting only 7000 against the same 8000
    // cost basis is a genuine Rp1000 loss. If orderItemRevenueIdr still used
    // gross unitPrice×quantity, this would assert the old (wrong) +2000/20%.
    const product = await createDenomination(prisma, {
      productId: parentProductId, name: "Discounted item", type: "SHARED", durationLabel: "1 Month",
      price: "10000", costPrice: "8000",
    });
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-disc-${Math.random()}`, userId,
        subtotalAmount: "10000", bulkDiscountAmount: "1000", discountAmount: "2000",
        totalAmount: "7000", currency: "IDR", status: "DELIVERED", deliveredAt: now,
      },
    });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const result = await profitSummarySince(prisma, new Date(now.getTime() - 60_000));
    // Net revenue 10000-3000=7000, cost 8000 -> profit -1000, margin -14.29%.
    expect(result.idr).toEqual({ netProfit: "-1000", marginPct: "-14.29", excludedItemCount: 0 });
  });
});

describe("topProductsByMargin", () => {
  it("ranks by units sold; revenue/profit are the catalog-IDR price as-is, with zero fxRate multiplication for USDT-paid orders", async () => {
    const now = new Date();
    const productA = await createDenomination(prisma, { productId: parentProductId, name: "Product A", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "6000" });
    const productB = await createDenomination(prisma, { productId: parentProductId, name: "Product B", type: "SHARED", durationLabel: "1 Month", price: "80000", costPrice: "32000" });

    const idrOrder = await prisma.order.create({ data: { orderCode: `ORD-a-${Math.random()}`, userId, subtotalAmount: "30000", totalAmount: "30000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: idrOrder.id, productId: productA.id, quantity: 3, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    // unitPrice is the catalog IDR price verbatim (80000) — exactly what
    // createOrderFromCart/createOrderDirect actually write for a USDT order.
    // If the old bug (unitPrice × fxRate) were still present, this would
    // compute 80000 × 16000 = 1,280,000,000 instead of 80000.
    const usdtOrder = await prisma.order.create({ data: { orderCode: `ORD-b-${Math.random()}`, userId, subtotalAmount: "80000", totalAmount: "5", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: usdtOrder.id, productId: productB.id, quantity: 1, unitPrice: "80000", warrantyDaysSnapshot: 30 } });

    const result = await topProductsByMargin(prisma, new Date(now.getTime() - 60_000), 5);
    expect(result).toEqual([
      { productId: productA.id, productLabel: `${parentProductName} · Product A`, unitsSold: 3, revenueIdrEquiv: "30000", profitIdrEquiv: "12000", costUnknownUnits: 0 },
      { productId: productB.id, productLabel: `${parentProductName} · Product B`, unitsSold: 1, revenueIdrEquiv: "80000", profitIdrEquiv: "48000", costUnknownUnits: 0 },
    ]);
  });

  it("nulls profit for a product with any cost-unknown units, but still reports its revenue", async () => {
    const now = new Date();
    const product = await createDenomination(prisma, { productId: parentProductId, name: "No cost", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const order = await prisma.order.create({ data: { orderCode: `ORD-nc-${Math.random()}`, userId, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const result = await topProductsByMargin(prisma, new Date(now.getTime() - 60_000), 5);
    expect(result[0]).toEqual({ productId: product.id, productLabel: `${parentProductName} · No cost`, unitsSold: 1, revenueIdrEquiv: "10000", profitIdrEquiv: null, costUnknownUnits: 1 });
  });

  it("regression: a realistic USDT order's revenue is not inflated by fxRate (2026-07 CapCut-Pro-style incident)", async () => {
    const now = new Date();
    const product = await createDenomination(prisma, {
      productId: parentProductId, name: "1 Month", type: "SHARED", durationLabel: "1 Month",
      price: "30000", costPrice: "15000",
    });
    for (let i = 0; i < 3; i++) {
      const order = await prisma.order.create({ data: {
        orderCode: `ORD-usdt-${Math.random()}`, userId, subtotalAmount: "30000", totalAmount: "2",
        currency: "USDT", fxRate: "15000", status: "DELIVERED", deliveredAt: now,
      } });
      // unitPrice is the catalog IDR price verbatim — what createOrderFromCart
      // actually writes; NOT pre-divided by fxRate.
      await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 1, unitPrice: "30000", warrantyDaysSnapshot: 30 } });
    }

    const top = await topProductsByMargin(prisma, new Date(now.getTime() - 60_000), 5);
    // 3 × Rp30,000 = Rp90,000 — NOT ~Rp1.35 billion (30000×3×15000), the
    // magnitude the live "84 sold · Rp37.198.718.000" incident produced.
    expect(top[0]).toMatchObject({ unitsSold: 3, revenueIdrEquiv: "90000", profitIdrEquiv: "45000" });

    const profit = await profitSummarySince(prisma, new Date(now.getTime() - 60_000));
    // revenue 3×(30000/15000)=6, cost 3×(15000/15000)=3 -> profit 3, margin 50%.
    expect(profit.usdt).toMatchObject({ netProfit: "3", marginPct: "50" });
  });

  it("splits the order's bulkDiscountAmount + discountAmount across two lines by their share of subtotalAmount, turning both into losses (M-1)", async () => {
    const now = new Date();
    // Two lines, subtotal 6000 + 4000 = 10000. Order carries a Rp1000 bulk
    // discount + Rp2000 voucher (3000 total), split 60/40 by subtotal share:
    // line A eats 1800, line B eats 1200. Gross-only numbers would show both
    // products profitable (A: 6000-5000=+1000, B: 4000-3000=+1000); with the
    // discount prorated in, both actually lost money.
    const productA = await createDenomination(prisma, { productId: parentProductId, name: "Product A", type: "SHARED", durationLabel: "1 Month", price: "6000", costPrice: "5000" });
    const productB = await createDenomination(prisma, { productId: parentProductId, name: "Product B", type: "SHARED", durationLabel: "1 Month", price: "4000", costPrice: "3000" });

    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-disc-${Math.random()}`, userId,
        subtotalAmount: "10000", bulkDiscountAmount: "1000", discountAmount: "2000",
        totalAmount: "7000", currency: "IDR", status: "DELIVERED", deliveredAt: now,
      },
    });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: productA.id, quantity: 1, unitPrice: "6000", warrantyDaysSnapshot: 30 } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: productB.id, quantity: 1, unitPrice: "4000", warrantyDaysSnapshot: 30 } });

    const result = await topProductsByMargin(prisma, new Date(now.getTime() - 60_000), 5);
    // A: discount 3000×(6000/10000)=1800 -> revenue 4200, cost 5000 -> profit -800.
    // B: discount 3000×(4000/10000)=1200 -> revenue 2800, cost 3000 -> profit -200.
    expect(result).toEqual(
      expect.arrayContaining([
        { productId: productA.id, productLabel: `${parentProductName} · Product A`, unitsSold: 1, revenueIdrEquiv: "4200", profitIdrEquiv: "-800", costUnknownUnits: 0 },
        { productId: productB.id, productLabel: `${parentProductName} · Product B`, unitsSold: 1, revenueIdrEquiv: "2800", profitIdrEquiv: "-200", costUnknownUnits: 0 },
      ]),
    );
  });
});

describe("ordersByDay", () => {
  it("counts delivered orders per day, split by currency", async () => {
    const now = new Date();
    await prisma.order.create({ data: { orderCode: `ORD-a-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.order.create({ data: { orderCode: `ORD-b-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.order.create({ data: { orderCode: `ORD-c-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", currency: "USDT", status: "DELIVERED", deliveredAt: now } });

    const days = await ordersByDay(prisma, 1);
    expect(days).toEqual([{ day: days[0]!.day, ordersIdr: 2, ordersUsdt: 1 }]);
  });

  it("fills empty days with zero counts", async () => {
    const days = await ordersByDay(prisma, 3);
    expect(days).toHaveLength(3);
    for (const d of days) expect(d).toMatchObject({ ordersIdr: 0, ordersUsdt: 0 });
  });
});

describe("combinedRevenueByDay", () => {
  it("converts a USDT order's total to IDR-equivalent via its own fxRate, and leaves IDR orders unconverted", async () => {
    const now = new Date();
    await prisma.order.create({ data: { orderCode: `ORD-idr-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "54000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.order.create({ data: { orderCode: `ORD-usdt-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "3.43", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: now } });

    const days = await combinedRevenueByDay(prisma, 1);
    expect(days).toHaveLength(1);
    // 54000 (IDR, unconverted) + 3.43 * 16000 = 54880 (USDT, via its own snapshot rate)
    expect(days[0]!.revenueIdrEquiv).toBe("108880");
  });

  it("fills empty days with zero", async () => {
    const days = await combinedRevenueByDay(prisma, 2);
    expect(days).toHaveLength(2);
    for (const d of days) expect(d.revenueIdrEquiv).toBe("0");
  });
});

describe("status exclusion", () => {
  it("only DELIVERED orders contribute to revenue, profit, or top-products — every other status is excluded", async () => {
    const now = new Date();
    const product = await createDenomination(prisma, { productId: parentProductId, name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "5000" });

    const nonDelivered = Object.values(OrderStatus).filter((s) => s !== OrderStatus.DELIVERED);
    for (const status of nonDelivered) {
      // deliveredAt is deliberately set on these non-DELIVERED rows too, so
      // this proves the guard is the status filter, not an incidental null
      // deliveredAt.
      const order = await prisma.order.create({ data: { orderCode: `ORD-${status}-${Math.random()}`, userId, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status, deliveredAt: now } });
      await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });
    }
    const delivered = await prisma.order.create({ data: { orderCode: `ORD-delivered-${Math.random()}`, userId, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: delivered.id, productId: product.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const since = new Date(now.getTime() - 60_000);

    const revenue = await revenueSummary(prisma, since);
    expect(revenue.revenue_idr.toString()).toBe("10000");
    expect(revenue.orders).toBe(1);

    const days = await revenueByDay(prisma, 1);
    expect(days[0]).toMatchObject({ revenue_idr: "10000", orders: 1 });

    const top = await topProductsByMargin(prisma, since, 5);
    expect(top).toEqual([{ productId: product.id, productLabel: `${parentProductName} · 1 Month`, unitsSold: 1, revenueIdrEquiv: "10000", profitIdrEquiv: "5000", costUnknownUnits: 0 }]);

    const profit = await profitSummarySince(prisma, since);
    expect(profit.idr).toEqual({ netProfit: "5000", marginPct: "50", excludedItemCount: 0 });
  });
});
