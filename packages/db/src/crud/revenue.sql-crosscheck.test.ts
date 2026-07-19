/**
 * Independent audit: every revenue.ts figure must equal a hand-recomputed
 * aggregate over the raw `orders`/`order_items` tables — read via
 * `$queryRawUnsafe` (bypassing Prisma's groupBy/relation-traversal API that
 * revenue.ts itself uses), summed with `Decimal` inline in this file, never
 * by calling the function under test. This is the automated form of "the
 * dashboard must produce the exact same totals as direct SQL queries against
 * the database" (2026-07 financial audit requirement).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import { revenueSummary, topProductsByMargin, profitSummarySince } from "./revenue";

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

  const user = await prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
  });
  userId = user.id;
  const category = await createCategory(prisma, `Cat-${Math.random()}`);
  const parentProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: `Prod-${Math.random()}`, description: "x" });
  parentProductId = parentProduct.id;
});

/** Seeds a mixed scenario: 2 IDR delivered orders, 2 USDT delivered orders
 * (distinct fxRates), 1 cancelled order, 1 pending order, and one delivered
 * item with no costPrice — everything a real dashboard would need to get
 * right at once. */
async function seedMixedScenario(now: Date) {
  const idrDenom = await createDenomination(prisma, { productId: parentProductId, name: "IDR Plan", type: "SHARED", durationLabel: "1 Month", price: "25000", costPrice: "10000" });
  const usdtDenomA = await createDenomination(prisma, { productId: parentProductId, name: "USDT Plan A", type: "SHARED", durationLabel: "3 Month", price: "60000", costPrice: "24000" });
  const usdtDenomB = await createDenomination(prisma, { productId: parentProductId, name: "USDT Plan B", type: "SHARED", durationLabel: "6 Month", price: "120000" }); // no costPrice

  const idrOrder1 = await prisma.order.create({ data: { orderCode: `ORD-idr1-${Math.random()}`, userId, subtotalAmount: "25000", totalAmount: "25000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
  await prisma.orderItem.create({ data: { orderId: idrOrder1.id, productId: idrDenom.id, quantity: 1, unitPrice: "25000", warrantyDaysSnapshot: 30 } });

  const idrOrder2 = await prisma.order.create({ data: { orderCode: `ORD-idr2-${Math.random()}`, userId, subtotalAmount: "50000", totalAmount: "50000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
  await prisma.orderItem.create({ data: { orderId: idrOrder2.id, productId: idrDenom.id, quantity: 2, unitPrice: "25000", warrantyDaysSnapshot: 30 } });

  const usdtOrder1 = await prisma.order.create({ data: { orderCode: `ORD-usdt1-${Math.random()}`, userId, subtotalAmount: "60000", totalAmount: "4", currency: "USDT", fxRate: "15000", status: "DELIVERED", deliveredAt: now } });
  await prisma.orderItem.create({ data: { orderId: usdtOrder1.id, productId: usdtDenomA.id, quantity: 1, unitPrice: "60000", warrantyDaysSnapshot: 30 } });

  const usdtOrder2 = await prisma.order.create({ data: { orderCode: `ORD-usdt2-${Math.random()}`, userId, subtotalAmount: "120000", totalAmount: "7.5", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: now } });
  await prisma.orderItem.create({ data: { orderId: usdtOrder2.id, productId: usdtDenomB.id, quantity: 1, unitPrice: "120000", warrantyDaysSnapshot: 30 } });

  const cancelled = await prisma.order.create({ data: { orderCode: `ORD-cancel-${Math.random()}`, userId, subtotalAmount: "999000", totalAmount: "999000", currency: "IDR", status: "CANCELLED", deliveredAt: now } });
  await prisma.orderItem.create({ data: { orderId: cancelled.id, productId: idrDenom.id, quantity: 1, unitPrice: "999000", warrantyDaysSnapshot: 30 } });

  const pending = await prisma.order.create({ data: { orderCode: `ORD-pending-${Math.random()}`, userId, subtotalAmount: "500000", totalAmount: "500000", currency: "IDR", status: "PENDING_PAYMENT" } });
  await prisma.orderItem.create({ data: { orderId: pending.id, productId: idrDenom.id, quantity: 1, unitPrice: "500000", warrantyDaysSnapshot: 30 } });

  return { idrDenom, usdtDenomA, usdtDenomB };
}

describe("revenue.ts matches an independently-recomputed SQL aggregate", () => {
  it("revenueSummary matches a raw SUM(total_amount) grouped by currency, delivered-only", async () => {
    const now = new Date();
    await seedMixedScenario(now);
    const since = new Date(now.getTime() - 60_000);

    const rows = await prisma.$queryRawUnsafe<{ status: string; currency: string; total_amount: string }[]>(
      `SELECT status, currency, total_amount FROM orders`,
    );
    const expected = { idr: new Decimal(0), usdt: new Decimal(0), orders: 0 };
    for (const r of rows) {
      if (r.status !== "DELIVERED") continue;
      if (r.currency === "IDR") expected.idr = expected.idr.plus(r.total_amount);
      else expected.usdt = expected.usdt.plus(r.total_amount);
      expected.orders += 1;
    }

    const result = await revenueSummary(prisma, since);
    expect(result.revenue_idr.toString()).toBe(expected.idr.toString());
    expect(result.revenue_usdt.toString()).toBe(expected.usdt.toString());
    expect(result.orders).toBe(expected.orders);
  });

  it("topProductsByMargin.revenueIdrEquiv matches raw unit_price×quantity per denomination, delivered-only, with zero fx multiplication", async () => {
    const now = new Date();
    await seedMixedScenario(now);
    const since = new Date(now.getTime() - 60_000);

    const rows = await prisma.$queryRawUnsafe<{ product_id: number; unit_price: string; quantity: number; status: string }[]>(
      `SELECT oi.product_id as product_id, oi.unit_price as unit_price, oi.quantity as quantity, o.status as status
       FROM order_items oi JOIN orders o ON o.id = oi.order_id`,
    );
    const expectedByProduct = new Map<number, Decimal>();
    for (const r of rows) {
      if (r.status !== "DELIVERED") continue;
      const prev = expectedByProduct.get(r.product_id) ?? new Decimal(0);
      expectedByProduct.set(r.product_id, prev.plus(new Decimal(r.unit_price).times(r.quantity)));
    }

    const result = await topProductsByMargin(prisma, since, 20);
    expect(result.length).toBe(expectedByProduct.size);
    for (const row of result) {
      expect(row.revenueIdrEquiv).toBe(expectedByProduct.get(row.productId)!.toString());
    }
  });

  it("profitSummarySince matches an independently-summed revenue/cost by currency, USDT converted via each order's own fxRate", async () => {
    const now = new Date();
    await seedMixedScenario(now);
    const since = new Date(now.getTime() - 60_000);

    const rows = await prisma.$queryRawUnsafe<
      { unit_price: string; quantity: number; status: string; currency: string; fx_rate: string | null; cost_price: string | null }[]
    >(
      `SELECT oi.unit_price as unit_price, oi.quantity as quantity, o.status as status, o.currency as currency, o.fx_rate as fx_rate, d.cost_price as cost_price
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN denominations d ON d.id = oi.product_id`,
    );

    const expected: Record<"IDR" | "USDT", { revenue: Decimal; cost: Decimal; excluded: number }> = {
      IDR: { revenue: new Decimal(0), cost: new Decimal(0), excluded: 0 },
      USDT: { revenue: new Decimal(0), cost: new Decimal(0), excluded: 0 },
    };
    for (const r of rows) {
      if (r.status !== "DELIVERED") continue;
      const isUsdt = r.currency === "USDT";
      const bucket = isUsdt ? expected.USDT : expected.IDR;
      if (r.cost_price == null) {
        bucket.excluded += 1;
        continue;
      }
      const lineRevenueIdr = new Decimal(r.unit_price).times(r.quantity);
      const lineCostIdr = new Decimal(r.cost_price).times(r.quantity);
      const rate = r.fx_rate;
      bucket.revenue = bucket.revenue.plus(isUsdt && rate != null ? lineRevenueIdr.div(rate) : lineRevenueIdr);
      bucket.cost = bucket.cost.plus(isUsdt && rate != null ? lineCostIdr.div(rate) : lineCostIdr);
    }

    const result = await profitSummarySince(prisma, since);
    for (const currency of ["IDR", "USDT"] as const) {
      const e = expected[currency];
      const actual = currency === "IDR" ? result.idr : result.usdt;
      if (e.revenue.isZero() && e.excluded === 0) {
        expect(actual).toBeNull();
        continue;
      }
      expect(actual).not.toBeNull();
      expect(actual!.netProfit).toBe(e.revenue.minus(e.cost).toDecimalPlaces(4).toString());
      expect(actual!.excludedItemCount).toBe(e.excluded);
    }
  });
});
