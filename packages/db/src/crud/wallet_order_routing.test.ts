/**
 * Dual credit balance (IDR + USDT) — spend/refund routing at the order layer.
 *
 * Rule under test: an order spends and is refunded against the credit balance
 * matching its `currency`. IDR orders move the IDR balance (`walletBalance`),
 * USDT orders move the USDT balance (`walletBalanceUsdt`); the other currency's
 * balance is never touched. `releaseOrderHolds` (via cancelOrder) returns the
 * credit in the order's currency.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  adjustWallet,
  createOrderFromCart,
  createInternalOrder,
  addToCart,
  getOrder,
  cancelOrder,
} from "@app/db";
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

const balances = (userId: number) =>
  prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { walletBalance: true, walletBalanceUsdt: true },
  });

describe("IDR order spends + refunds the IDR credit balance", () => {
  it("debits IDR on creation and returns it on cancel — USDT untouched", async () => {
    const { user, product } = sample;
    // Seed both balances; only IDR should move.
    await adjustWallet(prisma, user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    await adjustWallet(prisma, user.id, "7", { currency: "USDT", reason: "admin_adjust" });

    await addToCart(prisma, user.id, product.id, 1); // 5.00 IDR product
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const created = await createOrderFromCart(prisma, {
      user: { id: fresh.id, role: fresh.role, walletBalance: fresh.walletBalance },
      walletAmount: "4",
    });
    const order = (await getOrder(prisma, created!.id))!;

    expect(order.currency).toBe("IDR");
    expect(new Decimal(order.walletUsed).equals("4")).toBe(true);

    let u = await balances(user.id);
    expect(Number(u.walletBalance)).toBeCloseTo(6); // 10 - 4
    expect(Number(u.walletBalanceUsdt)).toBeCloseTo(7); // untouched

    // The order_payment ledger row is tagged IDR.
    const debit = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "order_payment" },
    });
    expect(debit.currency).toBe("IDR");

    // Cancel → credit balance back in IDR.
    await cancelOrder(prisma, order.id, "user_cancelled");
    u = await balances(user.id);
    expect(Number(u.walletBalance)).toBeCloseTo(10); // refunded
    expect(Number(u.walletBalanceUsdt)).toBeCloseTo(7); // still untouched

    const refund = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "order_refund" },
    });
    expect(refund.currency).toBe("IDR");
  });
});

describe("USDT order spends + refunds the USDT credit balance", () => {
  it("debits USDT on creation and returns it on cancel — IDR untouched", async () => {
    const { user, product } = sample;
    await adjustWallet(prisma, user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    await adjustWallet(prisma, user.id, "7", { currency: "USDT", reason: "admin_adjust" });

    // rate 1 keeps the USDT total numerically equal to the 5.00 central price.
    const created = await prisma.$transaction((tx) =>
      createInternalOrder(tx, {
        user: { id: user.id, role: user.role },
        productId: product.id,
        quantity: 1,
        rate: 1,
        walletAmount: "3",
      }),
    );
    const order = (await getOrder(prisma, created!.id))!;

    expect(order.currency).toBe("USDT");
    expect(new Decimal(order.walletUsed).equals("3")).toBe(true);

    let u = await balances(user.id);
    expect(Number(u.walletBalanceUsdt)).toBeCloseTo(4); // 7 - 3
    expect(Number(u.walletBalance)).toBeCloseTo(10); // IDR untouched

    const debit = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "order_payment" },
    });
    expect(debit.currency).toBe("USDT");

    // Cancel → credit balance back in USDT.
    await cancelOrder(prisma, order.id, "expired");
    u = await balances(user.id);
    expect(Number(u.walletBalanceUsdt)).toBeCloseTo(7); // refunded
    expect(Number(u.walletBalance)).toBeCloseTo(10); // still untouched

    const refund = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "order_refund" },
    });
    expect(refund.currency).toBe("USDT");
  });

  it("USDT spend is clamped to the order total and overdraw throws", async () => {
    const { user, product } = sample;
    await adjustWallet(prisma, user.id, "2", { currency: "USDT", reason: "admin_adjust" });

    // Request 100 USDT credit but the balance is only 2 → insufficient.
    await expect(
      prisma.$transaction((tx) =>
        createInternalOrder(tx, {
          user: { id: user.id, role: user.role },
          productId: product.id,
          quantity: 1,
          rate: 1,
          walletAmount: "100",
        }),
      ),
    ).rejects.toMatchObject({ key: "error.insufficient_wallet" });
  });

  it("USDT order without walletAmount leaves walletUsed = 0 and balances unchanged", async () => {
    const { user, product } = sample;
    await adjustWallet(prisma, user.id, "9", { currency: "USDT", reason: "admin_adjust" });

    const created = await prisma.$transaction((tx) =>
      createInternalOrder(tx, {
        user: { id: user.id, role: user.role },
        productId: product.id,
        quantity: 1,
        rate: 1,
      }),
    );
    const order = (await getOrder(prisma, created!.id))!;
    expect(new Decimal(order.walletUsed).equals(0)).toBe(true);
    const u = await balances(user.id);
    expect(Number(u.walletBalanceUsdt)).toBeCloseTo(9); // untouched
  });
});
