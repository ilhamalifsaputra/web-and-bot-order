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
import { createOrderDirect, addToCart, getCart, createVoucher } from "@app/db";
import { VoucherType } from "@app/core/enums";
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

  // Checkout-5 (security audit, 2026-06-23): quantity from a crafted callback
  // must not bypass server-side validation.
  it("rejects a zero/negative/non-integer quantity with error.invalid_quantity, before touching stock", async () => {
    const { user, product } = sample;
    for (const bad of [0, -5, 1.5]) {
      await expect(
        createOrderDirect(prisma, { user, productId: product.id, quantity: bad }),
      ).rejects.toMatchObject({ key: "error.invalid_quantity" });
    }
    expect(await prisma.order.count()).toBe(0);
  });

  it("rejects a quantity above the 99 cap with error.invalid_quantity", async () => {
    const { user, product } = sample;
    await expect(
      createOrderDirect(prisma, { user, productId: product.id, quantity: 100 }),
    ).rejects.toMatchObject({ key: "error.invalid_quantity" });
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

  // Pricing-1 (security audit, 2026-06-23): a voucher must not be reusable by
  // the same buyer across multiple direct (bot) orders.
  it("the SAME user reusing SAVE10 on a second direct order → error.voucher_already_redeemed", async () => {
    const { user, product, voucher } = sample;
    await createOrderDirect(prisma, { user, productId: product.id, quantity: 1, voucherCode: "SAVE10" });

    await expect(
      createOrderDirect(prisma, { user, productId: product.id, quantity: 1, voucherCode: "SAVE10" }),
    ).rejects.toMatchObject({ key: "error.voucher_already_redeemed" });

    const fresh = await prisma.voucher.findUnique({ where: { id: voucher.id } });
    expect(fresh!.usedCount).toBe(1); // the blocked second attempt never bumped the global counter
  });

  // Pricing-2 (security audit, 2026-06-23): the global usageLimit bump is now
  // an atomic conditional updateMany, not a separate read-check-then-increment
  // — a SECOND distinct user must be turned away once usageLimit=1 is hit,
  // exactly the same as before, but via the DB-level guard rather than an
  // in-memory snapshot.
  it("a GLOBAL usageLimit=1 voucher is refused for a second order by a DIFFERENT user once exhausted", async () => {
    const { user, product } = sample;
    const v = await createVoucher(prisma, { code: "ONESHOT", type: VoucherType.PERCENT, value: "10", usageLimit: 1 });
    await createOrderDirect(prisma, { user, productId: product.id, quantity: 1, voucherCode: "ONESHOT" });

    const otherUser = await prisma.user.create({ data: { telegramId: 5_551_234, referralCode: "ONESHOT-U2" } });
    await expect(
      createOrderDirect(prisma, {
        user: { id: otherUser.id, role: "CUSTOMER" },
        productId: product.id,
        quantity: 1,
        voucherCode: "ONESHOT",
      }),
    ).rejects.toMatchObject({ key: "error.voucher_used_up" });

    const fresh = await prisma.voucher.findUnique({ where: { id: v.id } });
    expect(fresh!.usedCount).toBe(1); // the refused attempt never bumped past the limit
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
