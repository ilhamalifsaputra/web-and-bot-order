import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  OrderStatus,
  OrderKind,
  RefundExecutionMethod,
  RefundExecutionStatus,
  RefundStatus,
} from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import { seedChartOfAccounts } from "./ledgerAccounts";
import { createRefund, executeRefund, transitionRefundStatus } from "./refunds";
import {
  revenueByDay,
  revenueSummary,
  profitSummarySince,
  topProducts,
  topProductsByMargin,
  ordersByDay,
  combinedRevenueByDay,
  botOverallStats,
  refundTotalsSince,
  refundsByDay,
  grossSalesForNetSales,
} from "./revenue";

let db: TestDb;
let prisma: PrismaClient;
let userId: number;
let parentProductId: number;
let parentProductName: string;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
  // `executeRefund` posts its payout to the double-entry ledger in the same
  // transaction, so the chart of accounts has to exist or every refund fixture
  // below fails on an unknown account code. Seeded once here rather than per
  // test: the 15 account rows carry no per-test state, and the refund describes
  // deliberately leave `ledgerAccount` out of the reset above for that reason.
  await seedChartOfAccounts(prisma);
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  // The Refund-domain and ledger rows the refundTotalsSince/refundsByDay
  // describes below create through the real `executeRefund` path, cleared
  // children-before-parents. Every one of these relations is onDelete: Restrict
  // (a recorded payout is a financial-audit record), so without this the plain
  // `order.deleteMany()` underneath would start failing on a foreign-key
  // violation from the moment the first refund test runs — including for every
  // unrelated test in this file that happens to be declared after it.
  await prisma.refundExecution.deleteMany();
  await prisma.refundItem.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.orderStatusHistory.deleteMany();
  await prisma.order.deleteMany();
  await prisma.denomination.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.financialTransaction.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.walletTransaction.deleteMany();
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

// Task 6a (Financial Ledger M6): a settled WALLET_TOPUP order is a real Order
// row that reaches DELIVERED with a deliveredAt stamped (settleWalletTopup
// writes PENDING_PAYMENT -> DELIVERED directly), so before this fix every
// Order-level revenue aggregate in this module counted a buyer funding their
// own wallet as shop revenue. A top-up is money the shop holds on the buyer's
// behalf — a liability, not a sale — so none of these figures may include it.
//
// The OrderItem-rooted functions (topProducts, topProductsByMargin,
// profitSummarySince) need no such test: a top-up order carries zero OrderItem
// rows, so they were already immune.
describe("wallet top-ups are excluded from every revenue figure (kind: PRODUCT)", () => {
  /** A settled top-up: DELIVERED, deliveredAt set, zero OrderItem rows —
   * exactly the row shape settleWalletTopup leaves behind. */
  function makeSettledTopup(deliveredAt: Date, amount = "100000", currency: "IDR" | "USDT" = "IDR") {
    return prisma.order.create({
      data: {
        orderCode: `TOPUP-${Math.random()}`,
        userId,
        kind: OrderKind.WALLET_TOPUP,
        subtotalAmount: amount,
        totalAmount: amount,
        currency,
        ...(currency === "USDT" ? { fxRate: "16000" } : {}),
        status: OrderStatus.DELIVERED,
        paidAt: deliveredAt,
        deliveredAt,
      },
    });
  }

  function makeProductSale(deliveredAt: Date, amount = "54000") {
    return prisma.order.create({
      data: {
        orderCode: `ORD-${Math.random()}`,
        userId,
        kind: OrderKind.PRODUCT,
        subtotalAmount: amount,
        totalAmount: amount,
        currency: "IDR",
        status: OrderStatus.DELIVERED,
        deliveredAt,
      },
    });
  }

  it("revenueSummary counts the product sale and not the top-up", async () => {
    const now = new Date();
    await makeProductSale(now);
    await makeSettledTopup(now);
    await makeSettledTopup(now, "7", "USDT");

    const result = await revenueSummary(prisma, new Date(now.getTime() - 60_000));
    expect(result.revenue_idr.toString()).toBe("54000");
    expect(result.revenue_usdt.toString()).toBe("0");
    expect(result.orders).toBe(1);
  });

  it("revenueByDay counts the product sale and not the top-up", async () => {
    const now = new Date();
    await makeProductSale(now);
    await makeSettledTopup(now);

    const days = await revenueByDay(prisma, 1);
    expect(days[0]).toMatchObject({ revenue_idr: "54000", revenue_usdt: "0", orders: 1 });
  });

  it("ordersByDay counts the product sale and not the top-up", async () => {
    const now = new Date();
    await makeProductSale(now);
    await makeSettledTopup(now);
    await makeSettledTopup(now, "7", "USDT");

    const days = await ordersByDay(prisma, 1);
    expect(days[0]).toMatchObject({ ordersIdr: 1, ordersUsdt: 0 });
  });

  it("combinedRevenueByDay counts the product sale and not the top-up", async () => {
    const now = new Date();
    await makeProductSale(now);
    await makeSettledTopup(now);

    const days = await combinedRevenueByDay(prisma, 1);
    expect(days[0]!.revenueIdrEquiv).toBe("54000");
  });

  it("botOverallStats' shop-wide revenue counts the product sale and not the top-up", async () => {
    const now = new Date();
    await makeProductSale(now);
    await makeSettledTopup(now);

    const stats = await botOverallStats(prisma);
    expect(stats.revenue_idr.toString()).toBe("54000");
    expect(stats.revenue_usdt.toString()).toBe("0");
  });

  // salesRevenueByCurrency is module-private and revenueSummary is the one
  // caller that passes it an `extraWhere`. The kind filter has to live in the
  // helper's own base `where`, applied so a caller's extraWhere can never
  // clear it — proven here through the only public door into that helper.
  it("a top-up stays out even when reached through revenueSummary's extraWhere date window", async () => {
    const now = new Date();
    await makeSettledTopup(now);

    const result = await revenueSummary(prisma, new Date(now.getTime() - 60_000));
    expect(result.orders).toBe(0);
    expect(result.revenue_idr.toString()).toBe("0");
  });
});

// Task 6b (Financial Ledger M6): before these functions existed, a refund had
// zero effect on any dashboard figure — a customer paid back in full still
// showed up as full revenue, and nothing anywhere subtracted the payout. These
// two functions are the source of the "Refunds Today"/"Net Sales Today" cards,
// so a silent under- or over-count here is a wrong money figure on the
// dashboard, not a cosmetic bug.
//
// Every fixture pays out through Task 4's real `executeRefund` rather than
// hand-writing a `RefundExecution` row, so these tests exercise the exact row
// shape production writes (COMPLETED in one insert, `executedAt` stamped at the
// actual payout instant, currency snapshotted from the Refund). The one
// exception is the non-COMPLETED case: `executeRefund` cannot produce a
// FAILED/PENDING row by design — a mid-flight failure rolls the whole attempt
// away — so those rows are written directly, which is also how a real bounced
// transfer gets recorded after the fact.
describe("refund totals from RefundExecution", () => {
  let adminId: number;

  beforeEach(async () => {
    const admin = await prisma.user.create({
      data: {
        telegramId: BigInt(Math.floor(Math.random() * 1e15)),
        username: "refund-admin",
        fullName: "Refund Admin",
        role: "ADMIN",
        referralCode: `ra${Math.random()}`,
      },
    });
    adminId = admin.id;
  });

  /** A delivered product sale for a refund to be paid out against.
   *  `totalAmount` is the refundable ceiling `executeRefund` enforces, so it is
   *  set to exactly the payout under test. */
  function makeRefundableOrder(amount: string, currency: "IDR" | "USDT") {
    return prisma.order.create({
      data: {
        orderCode: `ORD-refundable-${Math.random()}`,
        userId,
        kind: OrderKind.PRODUCT,
        subtotalAmount: amount,
        totalAmount: amount,
        currency,
        ...(currency === "USDT" ? { fxRate: "16000" } : {}),
        status: OrderStatus.DELIVERED,
        deliveredAt: new Date(),
      },
    });
  }

  /** A Refund taken to PROCESSING — the only state `executeRefund` accepts. */
  async function makeProcessingRefund(orderId: number, amount: string, currency: "IDR" | "USDT") {
    const refund = await createRefund(prisma, { orderId, amount, currency, adminId });
    await transitionRefundStatus(prisma, {
      refundId: refund.id,
      from: RefundStatus.PENDING,
      to: RefundStatus.PROCESSING,
      adminId,
    });
    return refund;
  }

  /**
   * One real COMPLETED payout. `executedAt` is stamped by `executeRefund` itself
   * as the payout's own wall-clock instant, so a test needing a payout on a
   * different day backdates the row afterwards — that one value is the only
   * thing the real function cannot be asked for, and backdating it leaves every
   * other field exactly as production wrote it.
   */
  async function payOutRefund(opts: { amount: string; currency?: "IDR" | "USDT"; executedAt?: Date }) {
    const currency = opts.currency ?? "IDR";
    const order = await makeRefundableOrder(opts.amount, currency);
    const refund = await makeProcessingRefund(order.id, opts.amount, currency);
    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: opts.amount,
      executedBy: adminId,
    });
    if (!opts.executedAt) return execution;
    return prisma.refundExecution.update({
      where: { id: execution.id },
      data: { executedAt: opts.executedAt },
    });
  }

  /** A payout attempt that did NOT land, written directly — see this describe's
   *  comment for why `executeRefund` cannot produce one. */
  async function recordUnlandedExecution(status: string, amount: string, executedAt: Date) {
    const order = await makeRefundableOrder(amount, "IDR");
    const refund = await createRefund(prisma, { orderId: order.id, amount, currency: "IDR", adminId });
    return prisma.refundExecution.create({
      data: {
        refundId: refund.id,
        method: RefundExecutionMethod.MANUAL_TRANSFER,
        amount,
        currency: "IDR",
        status,
        executedBy: adminId,
        executedAt,
      },
    });
  }

  describe("refundTotalsSince", () => {
    it("counts a payout inside the window and leaves an earlier one out", async () => {
      const now = new Date();
      await payOutRefund({ amount: "2000" });
      await payOutRefund({ amount: "500", executedAt: new Date(now.getTime() - 3 * 86_400_000) });

      const totals = await refundTotalsSince(prisma, new Date(now.getTime() - 86_400_000));
      expect(totals.refunds_idr.toString()).toBe("2000");
      expect(totals.refunds_usdt.toString()).toBe("0");
    });

    it("excludes a payout made after `until`", async () => {
      const now = new Date();
      await payOutRefund({ amount: "700" });

      const totals = await refundTotalsSince(
        prisma,
        new Date(now.getTime() - 86_400_000),
        new Date(now.getTime() - 60_000),
      );
      expect(totals.refunds_idr.toString()).toBe("0");
    });

    it("ignores a FAILED or PENDING execution — only a payout that actually landed reduces what a customer spent", async () => {
      const now = new Date();
      await recordUnlandedExecution(RefundExecutionStatus.FAILED, "9000", now);
      await recordUnlandedExecution(RefundExecutionStatus.PENDING, "4000", now);

      const totals = await refundTotalsSince(prisma, new Date(now.getTime() - 86_400_000));
      expect(totals.refunds_idr.toString()).toBe("0");
    });

    it("keeps IDR and USDT payouts in separate buckets, never summed into one figure", async () => {
      const now = new Date();
      await payOutRefund({ amount: "54000", currency: "IDR" });
      await payOutRefund({ amount: "3.43", currency: "USDT" });

      const totals = await refundTotalsSince(prisma, new Date(now.getTime() - 86_400_000));
      // 3.43 USDT must never land in the Rupiah figure — the same "Rp3" class of
      // bug `salesRevenueByCurrency` splits currencies to prevent.
      expect(totals.refunds_idr.toString()).toBe("54000");
      expect(totals.refunds_usdt.toString()).toBe("3.43");
    });
  });

  describe("refundsByDay", () => {
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);

    it("buckets payouts by executedAt's UTC day, per currency, leaving the day between them at zero", async () => {
      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
      await payOutRefund({ amount: "2000" });
      await payOutRefund({ amount: "3.43", currency: "USDT" });
      await payOutRefund({ amount: "500", executedAt: twoDaysAgo });

      const days = await refundsByDay(prisma, 3);
      expect(days).toHaveLength(3);
      // Oldest → newest, same ordering contract as revenueByDay.
      expect(days.map((d) => d.day)).toEqual([...days.map((d) => d.day)].sort());

      const byDay = new Map(days.map((d) => [d.day, d]));
      expect(byDay.get(dayKey(now))).toMatchObject({ refunds_idr: "2000", refunds_usdt: "3.43" });
      expect(byDay.get(dayKey(twoDaysAgo))).toMatchObject({ refunds_idr: "500", refunds_usdt: "0" });
      expect(byDay.get(dayKey(new Date(now.getTime() - 86_400_000)))).toMatchObject({
        refunds_idr: "0",
        refunds_usdt: "0",
      });
    });

    it("fills every day in range with zero when there were no payouts at all", async () => {
      const days = await refundsByDay(prisma, 3);
      expect(days).toHaveLength(3);
      for (const d of days) {
        expect(d.refunds_idr).toBe("0");
        expect(d.refunds_usdt).toBe("0");
      }
    });

    it("keeps a FAILED execution out of its day's bucket", async () => {
      const now = new Date();
      await recordUnlandedExecution(RefundExecutionStatus.FAILED, "9000", now);

      const days = await refundsByDay(prisma, 1);
      expect(days[0]).toMatchObject({ refunds_idr: "0", refunds_usdt: "0" });
    });
  });

  // Task 6b fix (C1). Declared inside this describe rather than beside the
  // other revenue describes because it needs the same real payout fixtures:
  // the whole point of the function is what happens to a sale AFTER
  // `executeRefund` has moved it to REFUNDED, which only a real payout does.
  describe("grossSalesForNetSales", () => {
    it("still counts an order sold today and fully refunded today — the sale revenueSummary drops the moment executeRefund marks it REFUNDED", async () => {
      const now = new Date();
      const since = new Date(now.getTime() - 86_400_000);
      // payOutRefund's order is created with totalAmount === the payout, so this
      // is a FULL refund: executeRefund closes the order as REFUNDED.
      await payOutRefund({ amount: "10000" });

      // "Revenue Today" is delivered-only by design and no longer sees the
      // sale at all...
      expect((await revenueSummary(prisma, since)).revenue_idr.toString()).toBe("0");

      // ...but the sale genuinely happened today, so Net Sales' own gross basis
      // must still contain it. Without this, subtracting the payout from a
      // gross figure the sale already left charges the same refund twice and
      // fabricates -10000 for a day that truly netted zero.
      const gross = await grossSalesForNetSales(prisma, since);
      expect(gross.idr.toString()).toBe("10000");

      const refunds = await refundTotalsSince(prisma, since);
      expect(gross.idr.minus(refunds.refunds_idr).toString()).toBe("0");
    });

    it("sums a still-delivered sale and a refunded one together, keeping IDR and USDT in separate figures", async () => {
      const now = new Date();
      await makeRefundableOrder("54000", "IDR"); // sold, never refunded
      await payOutRefund({ amount: "3.43", currency: "USDT" }); // sold then fully refunded

      const gross = await grossSalesForNetSales(prisma, new Date(now.getTime() - 86_400_000));
      // 3.43 USDT must never land in the Rupiah figure — the same "Rp3" class of
      // bug every other function in this module splits currencies to prevent.
      expect(gross.idr.toString()).toBe("54000");
      expect(gross.usdt.toString()).toBe("3.43");
    });

    it("counts no status other than DELIVERED and REFUNDED, and never a wallet top-up", async () => {
      const now = new Date();
      const excluded = Object.values(OrderStatus).filter(
        (s) => s !== OrderStatus.DELIVERED && s !== OrderStatus.REFUNDED,
      );
      for (const status of excluded) {
        // deliveredAt is set on these too, so this proves the guard is the
        // status filter and not an incidental null deliveredAt.
        await prisma.order.create({
          data: {
            orderCode: `ORD-gross-${status}-${Math.random()}`,
            userId,
            kind: OrderKind.PRODUCT,
            subtotalAmount: "10000",
            totalAmount: "10000",
            currency: "IDR",
            status,
            deliveredAt: now,
          },
        });
      }
      // A settled wallet top-up is a DELIVERED order with a deliveredAt too, and
      // is still not a sale (Task 6a) — widening the status filter must not
      // quietly reopen that door.
      await prisma.order.create({
        data: {
          orderCode: `TOPUP-gross-${Math.random()}`,
          userId,
          kind: OrderKind.WALLET_TOPUP,
          subtotalAmount: "100000",
          totalAmount: "100000",
          currency: "IDR",
          status: OrderStatus.DELIVERED,
          paidAt: now,
          deliveredAt: now,
        },
      });
      await makeRefundableOrder("7000", "IDR");

      const gross = await grossSalesForNetSales(prisma, new Date(now.getTime() - 86_400_000));
      expect(gross.idr.toString()).toBe("7000");
      expect(gross.usdt.toString()).toBe("0");
    });

    it("excludes a sale delivered after `until`", async () => {
      const now = new Date();
      await makeRefundableOrder("8000", "IDR");

      const gross = await grossSalesForNetSales(
        prisma,
        new Date(now.getTime() - 86_400_000),
        new Date(now.getTime() - 60_000),
      );
      expect(gross.idr.toString()).toBe("0");
    });
  });
});
