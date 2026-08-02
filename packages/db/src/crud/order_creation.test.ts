/**
 * Port of tests/test_order_creation.py — order creation from cart.
 *   * Happy path: cart → order with correct subtotal, totals, unique cents,
 *     and stock reserved (Checkout-2/Stock-1 fix, security audit 2026-06-23).
 *   * Empty-cart guard.
 *   * Out-of-stock guard: requesting more than available throws before
 *     reserving anything (pre-check ahead of the atomic per-unit allocation).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  addToCart,
  createOrderFromCart,
  createOrderDirect,
  createVoucher,
  upsertBulkPricing,
  getOrder,
  getCart,
  countAvailableStock,
  markStockDead,
  createCatalogProduct,
  createDenomination,
  bulkAddStock,
  MAX_CART_ORDER_UNITS,
} from "@app/db";
import { Decimal } from "@app/core/money";
import { ProductType, VoucherType } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

describe("create order from cart", () => {
  it("happy path: buying 2 units of a 5.00 product", async () => {
    const { user, product } = sample;
    await addToCart(prisma, user.id, product.id, 2);
    const created = await createOrderFromCart(prisma, { user });
    const order = (await getOrder(prisma, created!.id))!;

    expect(new Decimal(order.subtotalAmount).equals("10.0000")).toBe(true);
    expect(new Decimal(order.discountAmount).equals(0)).toBe(true);
    expect(new Decimal(order.walletUsed).equals(0)).toBe(true);
    expect(order.status).toBe("PENDING_PAYMENT");

    // Unique cents non-zero and folded into the total.
    expect(new Decimal(order.uniqueCents).greaterThan(0)).toBe(true);
    expect(
      new Decimal(order.totalAmount).equals(
        new Decimal(order.subtotalAmount).plus(order.uniqueCents),
      ),
    ).toBe(true);

    // Two OrderItems, each reserved against a stock row at creation time.
    expect(order.items.length).toBe(2);
    for (const item of order.items) {
      expect(item.stockItem).not.toBeNull();
      expect(item.stockItem!.status).toBe("RESERVED");
    }

    // Cart emptied.
    expect(await getCart(prisma, user.id)).toEqual([]);

    // Order code format: ORD-YYYYMMDD-XXXX (17 chars).
    expect(order.orderCode.startsWith("ORD-")).toBe(true);
    expect(order.orderCode.length).toBe(17);
  });

  it("empty cart raises error.cart_empty", async () => {
    const { user } = sample;
    await expect(createOrderFromCart(prisma, { user })).rejects.toMatchObject({
      key: "error.cart_empty",
    });
  });

  it("out-of-stock request throws and leaks no RESERVED rows", async () => {
    const { user, product } = sample;

    // Mark 4 of 5 dead → exactly 1 available.
    const items = await prisma.stockItem.findMany({
      where: { productId: product.id },
      take: 4,
    });
    for (const it of items) await markStockDead(prisma, it.id, "test");
    expect(await countAvailableStock(prisma, product.id)).toBe(1);

    // Request 3 — fails the availability check.
    await addToCart(prisma, user.id, product.id, 3);
    await expect(createOrderFromCart(prisma, { user })).rejects.toMatchObject({
      key: "error.out_of_stock",
    });

    // The pre-check fails before any row is touched — nothing reserved.
    const reserved = await prisma.stockItem.count({ where: { status: "RESERVED" } });
    expect(reserved).toBe(0);
  });
});

// M-7 fix, backend audit 2026-07-31: createOrderFromCart used to do per-unit
// work (allocateOneAvailableStock + an individual orderItem.create) for every
// single unit in the cart with no cap on the TOTAL across all lines (only the
// existing 99-per-line clamp). A large multi-line cart could turn into
// thousands of queries inside one write transaction. The fix adds a
// total-units cap (checked before any per-unit work, or even the order shell,
// exists) and batches every unit's OrderItem into one createMany.
describe("total-units cap and batched insert (M-7 fix)", () => {
  /** A fresh active AUTO denomination under `sample.category`, no stock. */
  async function makeDenomination(name: string) {
    const product = await createCatalogProduct(prisma, { categoryId: sample.category.id, name });
    return createDenomination(prisma, {
      productId: product.id,
      name,
      type: ProductType.SHARED,
      durationLabel: "1 Month",
      price: "5.00",
      warrantyDays: 30,
    });
  }

  it("a cart whose total units exceed the cap is rejected before any row is touched", async () => {
    const { user } = sample;
    // 4 lines x 99 units = 396, over the cap — each line stays within the
    // existing 99-per-line clamp, so only the NEW total-units cap can reject
    // this cart. No stock is seeded: the cap check must fire before the
    // per-line availability pre-check ever runs.
    expect(4 * 99).toBeGreaterThan(MAX_CART_ORDER_UNITS);
    for (let i = 0; i < 4; i++) {
      const denom = await makeDenomination(`Bulk Item ${i}`);
      await addToCart(prisma, user.id, denom.id, 99);
    }

    await expect(createOrderFromCart(prisma, { user })).rejects.toMatchObject({
      key: "error.cart_too_large",
    });

    // Rejected before the order shell, or any stock reservation, was created.
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.stockItem.count({ where: { status: "RESERVED" } })).toBe(0);
    // Cart is left untouched so the buyer can trim it down and retry.
    expect((await getCart(prisma, user.id)).length).toBe(4);
  });

  it("a large-but-under-cap multi-line cart completes with one batched insert, same rows a per-unit loop would produce", async () => {
    const { user } = sample;
    const perLine = 90; // 3 lines x 90 = 270, under the cap
    expect(perLine * 3).toBeLessThanOrEqual(MAX_CART_ORDER_UNITS);
    const denomIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const denom = await makeDenomination(`Big Line ${i}`);
      await bulkAddStock(
        prisma,
        denom.id,
        Array.from({ length: perLine }, (_, k) => `line${i}-cred-${k}`),
      );
      await addToCart(prisma, user.id, denom.id, perLine);
      denomIds.push(denom.id);
    }

    const created = await createOrderFromCart(prisma, { user });
    const order = (await getOrder(prisma, created!.id))!;

    expect(order.items.length).toBe(perLine * denomIds.length);
    for (const productId of denomIds) {
      const linesForProduct = order.items.filter((it) => it.productId === productId);
      expect(linesForProduct.length).toBe(perLine);

      // Every unit reserved a DISTINCT stock row — batching the INSERT must
      // not change which stock item allocateOneAvailableStock assigned to
      // which line/unit.
      const stockIds = linesForProduct.map((it) => it.stockItemId);
      expect(new Set(stockIds).size).toBe(perLine);
      for (const it of linesForProduct) {
        expect(it.stockItem).not.toBeNull();
        expect(it.stockItem!.status).toBe("RESERVED");
        expect(it.quantity).toBe(1);
        expect(new Decimal(it.unitPrice).equals("5.00")).toBe(true);
        expect(it.deliveryTypeSnapshot).toBe("auto");
      }
      // All of this product's seeded stock got consumed — none left over.
      expect(await countAvailableStock(prisma, productId)).toBe(0);
    }

    // Cart emptied, same as the happy-path test above.
    expect(await getCart(prisma, user.id)).toEqual([]);
  });
});

// Both order creators must bottom out at zero, never below it — a negative
// total or walletUsed would be persisted as-is and corrupt the audit trail
// (Money-2). createOrderFromCart has clamped since that fix; createOrderDirect
// now clamps identically (math audit F2).
describe("discounts can zero an order but never take it negative", () => {
  it("createOrderDirect: a 100% bulk rule plus a voucher lands on exactly zero", async () => {
    const { user, product } = sample;
    await upsertBulkPricing(prisma, { denominationId: product.id, minQuantity: 2, discountPercent: "100" });
    await createVoucher(prisma, { code: "ONTOP", type: VoucherType.PERCENT, value: "50" });

    const created = await createOrderDirect(prisma, {
      user,
      productId: product.id,
      quantity: 2,
      voucherCode: "ONTOP",
    });
    const order = (await getOrder(prisma, created!.id))!;

    // Bulk already took everything; the voucher is capped against what's left.
    expect(new Decimal(order.bulkDiscountAmount).equals(order.subtotalAmount)).toBe(true);
    expect(new Decimal(order.discountAmount).equals(0)).toBe(true);
    expect(new Decimal(order.walletUsed).greaterThanOrEqualTo(0)).toBe(true);
    // Only the unique cents remain payable — never a negative total.
    expect(new Decimal(order.totalAmount).equals(order.uniqueCents)).toBe(true);
  });

  it("createOrderDirect: a bulk rule stored above 100% is refused at read time, not honoured", async () => {
    const { user, product } = sample;
    // Bypass upsertBulkPricing's write-time guard the way a hand-edited row or
    // a pre-guard row would: write the rule straight to the table.
    await prisma.bulkPricing.create({
      data: { productId: product.id, minQuantity: 1, discountPercent: new Decimal("150"), isActive: true },
    });

    const created = await createOrderDirect(prisma, { user, productId: product.id, quantity: 2 });
    const order = (await getOrder(prisma, created!.id))!;

    expect(new Decimal(order.bulkDiscountAmount).equals(0)).toBe(true);
    expect(new Decimal(order.totalAmount).greaterThan(0)).toBe(true);
  });
});
