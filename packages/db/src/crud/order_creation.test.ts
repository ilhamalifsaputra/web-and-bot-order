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
import { addToCart, createOrderFromCart, getOrder, getCart, countAvailableStock, markStockDead } from "@app/db";
import { Decimal } from "@app/core/money";

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
