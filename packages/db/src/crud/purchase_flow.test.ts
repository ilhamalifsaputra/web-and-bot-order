/**
 * Port of tests/test_purchase_flow.py — the CRUD entry-point
 * `createOrderDirect` (cart-bypassing path that closes the audit-1.1 race).
 *
 * The Python file's second half (callback-router dispatch table) is a bot
 * concern and is deferred to the order-bot app (Fase 4); it is not part of the
 * @app/db CRUD layer under test here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect, addToCart, getCart } from "@app/db";
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

const countItems = (orderId: number) => prisma.orderItem.count({ where: { orderId } });

describe("createOrderDirect", () => {
  it("happy path: single product, qty=2, no voucher", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, {
      user,
      productId: product.id,
      quantity: 2,
    }))!;

    expect(order.status).toBe("PENDING_PAYMENT");
    expect(new Decimal(order.subtotalAmount).equals("10.0000")).toBe(true);
    expect(new Decimal(order.discountAmount).equals(0)).toBe(true);
    expect(new Decimal(order.bulkDiscountAmount).equals(0)).toBe(true);
    expect(order.voucherId).toBeNull();
    expect(order.orderCode).toBeTruthy();
    expect(await countItems(order.id)).toBe(2);
  });

  it("rejects qty over available stock", async () => {
    const { user, product } = sample;
    await expect(
      createOrderDirect(prisma, { user, productId: product.id, quantity: 10 }),
    ).rejects.toMatchObject({ key: "error.out_of_stock" });
  });

  it("unknown product → error.out_of_stock", async () => {
    const { user } = sample;
    await expect(
      createOrderDirect(prisma, { user, productId: 99999, quantity: 1 }),
    ).rejects.toMatchObject({ key: "error.out_of_stock" });
  });

  it("with voucher SAVE10 → 10% off + used_count bumps", async () => {
    const { user, product, voucher } = sample;
    const order = (await createOrderDirect(prisma, {
      user,
      productId: product.id,
      quantity: 2,
      voucherCode: "SAVE10",
    }))!;

    expect(new Decimal(order.discountAmount).equals("1.0000")).toBe(true); // 10% of 10
    expect(order.voucherId).toBe(voucher.id);

    const fresh = await prisma.voucher.findUnique({ where: { id: voucher.id } });
    expect(fresh!.usedCount).toBe(1);
  });

  it("unknown voucher → error.voucher_not_found", async () => {
    const { user, product } = sample;
    await expect(
      createOrderDirect(prisma, {
        user,
        productId: product.id,
        quantity: 1,
        voucherCode: "NOSUCH",
      }),
    ).rejects.toMatchObject({ key: "error.voucher_not_found" });
  });

  it("does not touch the cart (audit 1.1)", async () => {
    const { user, product } = sample;
    // Seed a cart entry that must be ignored by the direct path.
    await addToCart(prisma, user.id, product.id, 3);

    const order = (await createOrderDirect(prisma, {
      user,
      productId: product.id,
      quantity: 1,
    }))!;

    expect(await countItems(order.id)).toBe(1);
    expect(new Decimal(order.subtotalAmount).equals("5.0000")).toBe(true);

    // Cart still holds the original 3 — direct path never clears it.
    const cart = await getCart(prisma, user.id);
    expect(cart.reduce((s, c) => s + c.quantity, 0)).toBe(3);
  });
});
