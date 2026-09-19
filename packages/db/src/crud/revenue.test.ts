import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { OrderKind, OrderStatus, PaymentMethod } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import {
  botOverallStats,
  revenueByDay,
  revenueSummary,
  profitSummarySince,
  topProducts,
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

/**
 * A settled wallet top-up exactly as `settleWalletTopup`
 * (packages/db/src/crud/wallet_topup.ts) writes it: an Order row with kind
 * WALLET_TOPUP, status DELIVERED, `deliveredAt` stamped — and no OrderItem
 * rows, no voucher, no stock. This is the row shape that used to read as
 * sales revenue in every aggregate below.
 */
function makeSettledTopup(
  deliveredAt: Date,
  args: { amount?: string; currency?: "IDR" | "USDT" } = {},
) {
  const amount = args.amount ?? "500000";
  const currency = args.currency ?? "IDR";
  return prisma.order.create({
    data: {
      orderCode: `TOP-${Math.random()}`,
      userId,
      kind: OrderKind.WALLET_TOPUP,
      subtotalAmount: amount,
      totalAmount: amount,
      currency,
      ...(currency === "USDT" ? { fxRate: "16000" } : {}),
      status: OrderStatus.DELIVERED,
      deliveredAt,
      paymentMethod: PaymentMethod.TOKOPAY,
    },
  });
}

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

describe("topProducts", () => {
  it("ranks by quantity summed across multiple orders — not by revenue and not by order count — with deterministic tie-breaking (M-33 regression: a naive per-order/per-line grouping, or ranking by revenue, would get this wrong)", async () => {
    const now = new Date();
    const productA = await createDenomination(prisma, { productId: parentProductId, name: "A", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const productB = await createDenomination(prisma, { productId: parentProductId, name: "B", type: "SHARED", durationLabel: "1 Month", price: "50000" });
    const productC = await createDenomination(prisma, { productId: parentProductId, name: "C", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const productD = await createDenomination(prisma, { productId: parentProductId, name: "D", type: "SHARED", durationLabel: "1 Month", price: "10000" });

    // Product A: 5 units total spread across three separate orders (2+2+1) —
    // a naive "most orders" or "biggest single order" heuristic would rank
    // this below B.
    for (const qty of [2, 2, 1]) {
      const order = await prisma.order.create({
        data: { orderCode: `ORD-a-${Math.random()}`, userId, subtotalAmount: String(10000 * qty), totalAmount: String(10000 * qty), currency: "IDR", status: "DELIVERED", deliveredAt: now },
      });
      await prisma.orderItem.create({ data: { orderId: order.id, productId: productA.id, quantity: qty, unitPrice: "10000", warrantyDaysSnapshot: 30 } });
    }

    // Product B: a single order of 4 units at 5x the unit price — higher
    // gross revenue (200000) than A's (50000) but fewer units, so it must
    // still rank below A if ranking is genuinely by quantity, not revenue.
    const orderB = await prisma.order.create({
      data: { orderCode: `ORD-b-${Math.random()}`, userId, subtotalAmount: "200000", totalAmount: "200000", currency: "IDR", status: "DELIVERED", deliveredAt: now },
    });
    await prisma.orderItem.create({ data: { orderId: orderB.id, productId: productB.id, quantity: 4, unitPrice: "50000", warrantyDaysSnapshot: 30 } });

    // Products C and D tie at 2 units each — proves a tie doesn't drop or
    // duplicate a product, and is broken deterministically (by productId).
    const orderC = await prisma.order.create({
      data: { orderCode: `ORD-c-${Math.random()}`, userId, subtotalAmount: "20000", totalAmount: "20000", currency: "IDR", status: "DELIVERED", deliveredAt: now },
    });
    await prisma.orderItem.create({ data: { orderId: orderC.id, productId: productC.id, quantity: 2, unitPrice: "10000", warrantyDaysSnapshot: 30 } });
    const orderD = await prisma.order.create({
      data: { orderCode: `ORD-d-${Math.random()}`, userId, subtotalAmount: "20000", totalAmount: "20000", currency: "IDR", status: "DELIVERED", deliveredAt: now },
    });
    await prisma.orderItem.create({ data: { orderId: orderD.id, productId: productD.id, quantity: 2, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const result = await topProducts(prisma, new Date(now.getTime() - 60_000), 10);

    expect(result.map((r) => r.productId)).toEqual([
      productA.id,
      productB.id,
      ...[productC.id, productD.id].sort((a, b) => a - b),
    ]);
    expect(result[0]).toMatchObject({ productId: productA.id, name: "A", qty: 5, revenue: "50000" });
    expect(result[1]).toMatchObject({ productId: productB.id, name: "B", qty: 4, revenue: "200000" });
  });

  it("excludes rows delivered before `since`", async () => {
    const now = new Date();
    const before = new Date(now.getTime() - 3_600_000);
    const product = await createDenomination(prisma, { productId: parentProductId, name: "Old", type: "SHARED", durationLabel: "1 Month", price: "10000" });

    const oldOrder = await prisma.order.create({
      data: { orderCode: `ORD-old-${Math.random()}`, userId, subtotalAmount: "90000", totalAmount: "90000", currency: "IDR", status: "DELIVERED", deliveredAt: before },
    });
    await prisma.orderItem.create({ data: { orderId: oldOrder.id, productId: product.id, quantity: 9, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const recentOrder = await prisma.order.create({
      data: { orderCode: `ORD-new-${Math.random()}`, userId, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: now },
    });
    await prisma.orderItem.create({ data: { orderId: recentOrder.id, productId: product.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    // `since` excludes the old (9-unit) order — if it leaked in, qty would be
    // 10 and revenue 100000 instead of 1 / 10000.
    const result = await topProducts(prisma, new Date(now.getTime() - 60_000), 10);
    expect(result).toEqual([{ productId: product.id, name: "Old", qty: 1, revenue: "10000" }]);
  });

  it("caps results at `limit`", async () => {
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const product = await createDenomination(prisma, { productId: parentProductId, name: `P${i}`, type: "SHARED", durationLabel: "1 Month", price: "10000" });
      const order = await prisma.order.create({
        data: { orderCode: `ORD-${i}-${Math.random()}`, userId, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: now },
      });
      await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 12 - i, unitPrice: "10000", warrantyDaysSnapshot: 30 } });
    }
    const result = await topProducts(prisma, new Date(now.getTime() - 60_000), 10);
    expect(result).toHaveLength(10);
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

    const topByQty = await topProducts(prisma, since, 5);
    expect(topByQty).toEqual([{ productId: product.id, name: "1 Month", qty: 1, revenue: "10000" }]);

    const profit = await profitSummarySince(prisma, since);
    expect(profit.idr).toEqual({ netProfit: "5000", marginPct: "50", excludedItemCount: 0 });
  });
});

describe("wallet-top-up exclusion", () => {
  it("a settled wallet top-up leaves every sales revenue/order aggregate untouched", async () => {
    const now = new Date();
    const since = new Date(now.getTime() - 60_000);
    const product = await createDenomination(prisma, { productId: parentProductId, name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "5000" });

    const sale = await prisma.order.create({ data: { orderCode: `ORD-sale-${Math.random()}`, userId, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: sale.id, productId: product.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const baseline = {
      summary: await revenueSummary(prisma, since),
      overall: await botOverallStats(prisma),
      byDay: await revenueByDay(prisma, 1),
      ordersPerDay: await ordersByDay(prisma, 1),
      combined: await combinedRevenueByDay(prisma, 1),
      profit: await profitSummarySince(prisma, since),
      top: await topProducts(prisma, since, 5),
      margin: await topProductsByMargin(prisma, since, 5),
    };
    // Sanity: the product order really is in there, so an all-zero baseline
    // can't make the comparisons below pass vacuously.
    expect(baseline.summary.revenue_idr.toString()).toBe("10000");
    expect(baseline.summary.orders).toBe(1);

    // Half a million rupiah of deposits, in both currencies — the amounts are
    // deliberately far larger than the sale so any leak is unmissable.
    await makeSettledTopup(now, { amount: "500000", currency: "IDR" });
    await makeSettledTopup(now, { amount: "25", currency: "USDT" });

    expect(await revenueSummary(prisma, since)).toEqual(baseline.summary);
    expect(await revenueByDay(prisma, 1)).toEqual(baseline.byDay);
    expect(await ordersByDay(prisma, 1)).toEqual(baseline.ordersPerDay);
    expect(await combinedRevenueByDay(prisma, 1)).toEqual(baseline.combined);
    expect(await profitSummarySince(prisma, since)).toEqual(baseline.profit);
    expect(await topProducts(prisma, since, 5)).toEqual(baseline.top);
    expect(await topProductsByMargin(prisma, since, 5)).toEqual(baseline.margin);

    const overall = await botOverallStats(prisma);
    expect(overall.items_sold).toBe(baseline.overall.items_sold);
    expect(overall.revenue_idr.toString()).toBe(baseline.overall.revenue_idr.toString());
    expect(overall.revenue_usdt.toString()).toBe(baseline.overall.revenue_usdt.toString());
  });

  it("counts a product order paid from wallet credit exactly once, and not again as the top-up that funded it", async () => {
    const now = new Date();
    const since = new Date(now.getTime() - 60_000);
    const product = await createDenomination(prisma, { productId: parentProductId, name: "Wallet-paid", type: "SHARED", durationLabel: "1 Month", price: "30000", costPrice: "12000" });

    // The deposit that funded the purchase, then the purchase itself: the
    // same Rp30,000 moving twice through the same `orders` table. Only the
    // sale is revenue — counting both was the double-count this filter fixes.
    await makeSettledTopup(now, { amount: "30000", currency: "IDR" });
    const sale = await prisma.order.create({
      data: {
        orderCode: `ORD-wallet-${Math.random()}`, userId,
        subtotalAmount: "30000", totalAmount: "30000", walletUsed: "30000",
        currency: "IDR", paymentMethod: PaymentMethod.WALLET,
        status: "DELIVERED", deliveredAt: now,
      },
    });
    await prisma.orderItem.create({ data: { orderId: sale.id, productId: product.id, quantity: 1, unitPrice: "30000", warrantyDaysSnapshot: 30 } });

    const summary = await revenueSummary(prisma, since);
    expect(summary.revenue_idr.toString()).toBe("30000");
    expect(summary.orders).toBe(1);

    const days = await revenueByDay(prisma, 1);
    expect(days[0]).toMatchObject({ revenue_idr: "30000", revenue_usdt: "0", orders: 1 });
    expect((await ordersByDay(prisma, 1))[0]).toMatchObject({ ordersIdr: 1, ordersUsdt: 0 });
    expect((await combinedRevenueByDay(prisma, 1))[0]!.revenueIdrEquiv).toBe("30000");

    // `walletUsed` is a payment method, not a discount — the sale's full
    // Rp30,000 still counts as banked revenue (see orderItemRevenueIdr).
    expect(await profitSummarySince(prisma, since)).toEqual({
      idr: { netProfit: "18000", marginPct: "60", excludedItemCount: 0 },
      usdt: null,
    });
  });
});

describe("daily buckets follow the shop timezone", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("files an order delivered at 18:30Z under the next day and one at 16:30Z under that day (TIMEZONE=Asia/Jakarta)", async () => {
    // Asia/Jakarta is UTC+7: 2026-03-14T18:30Z is 01:30 on the 15th locally,
    // 2026-03-14T16:30Z is 23:30 on the 14th. Under the old UTC bucketing
    // both landed on "2026-03-14".
    const product = await createDenomination(prisma, { productId: parentProductId, name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "5000" });
    const lateEvening = new Date("2026-03-14T18:30:00.000Z");
    const afternoon = new Date("2026-03-14T16:30:00.000Z");

    for (const [deliveredAt, total] of [[afternoon, "40000"], [lateEvening, "70000"]] as const) {
      const order = await prisma.order.create({
        data: { orderCode: `ORD-tz-${Math.random()}`, userId, subtotalAmount: total, totalAmount: total, currency: "IDR", status: "DELIVERED", deliveredAt },
      });
      await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 1, unitPrice: total, warrantyDaysSnapshot: 30 } });
    }
    const usdtOrder = await prisma.order.create({
      data: { orderCode: `ORD-tz-usdt-${Math.random()}`, userId, subtotalAmount: "160000", totalAmount: "10", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: lateEvening },
    });
    await prisma.orderItem.create({ data: { orderId: usdtOrder.id, productId: product.id, quantity: 1, unitPrice: "160000", warrantyDaysSnapshot: 30 } });

    // "Now" is mid-morning on the 15th in Jakarta, so a 2-day window is
    // exactly the 14th and the 15th.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T03:00:00.000Z"));

    expect(await revenueByDay(prisma, 2)).toEqual([
      { day: "2026-03-14", revenue_idr: "40000", revenue_usdt: "0", orders: 1 },
      { day: "2026-03-15", revenue_idr: "70000", revenue_usdt: "10", orders: 2 },
    ]);
    expect(await ordersByDay(prisma, 2)).toEqual([
      { day: "2026-03-14", ordersIdr: 1, ordersUsdt: 0 },
      { day: "2026-03-15", ordersIdr: 1, ordersUsdt: 1 },
    ]);
    expect(await combinedRevenueByDay(prisma, 2)).toEqual([
      { day: "2026-03-14", revenueIdrEquiv: "40000" },
      // 70000 + 10 USDT × 16000 = 230000
      { day: "2026-03-15", revenueIdrEquiv: "230000" },
    ]);
  });

  it("keeps a sale made in the shop's early-morning hours in today's bucket instead of yesterday's", async () => {
    // 2026-03-15T00:30 Jakarta = 2026-03-14T17:30Z. A single-day window must
    // still contain it: with a UTC-midnight `since`, that order was both
    // filtered out of the query AND keyed to the wrong day.
    const deliveredAt = new Date("2026-03-14T17:30:00.000Z");
    await prisma.order.create({
      data: { orderCode: `ORD-early-${Math.random()}`, userId, subtotalAmount: "12345", totalAmount: "12345", currency: "IDR", status: "DELIVERED", deliveredAt },
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T03:00:00.000Z"));

    expect(await revenueByDay(prisma, 1)).toEqual([
      { day: "2026-03-15", revenue_idr: "12345", revenue_usdt: "0", orders: 1 },
    ]);
  });
});
