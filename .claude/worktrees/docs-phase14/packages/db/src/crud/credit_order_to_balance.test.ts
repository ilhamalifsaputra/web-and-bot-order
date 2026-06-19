/**
 * creditOrderToBalance — add a paid-but-unfulfillable order's external payment
 * to the buyer's credit balance (store credit) in the order's currency, then
 * void the order (CANCELLED, never REFUNDED).
 *
 * Covered: credits the correct currency + amount, marks CANCELLED, is
 * idempotent on retry, and re-tags a linked processed_binance_tx row to the
 * `credited_to_balance` outcome when a binanceTxId is passed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  adjustWallet,
  createOrderDirect,
  createInternalOrder,
  creditOrderToBalance,
  getOrder,
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
  await prisma.walletTransaction.deleteMany();
  await prisma.processedBinanceTx.deleteMany();
  sample = await buildSampleData(prisma);
});

const balances = (userId: number) =>
  prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { walletBalance: true, walletBalanceUsdt: true },
  });

describe("creditOrderToBalance", () => {
  it("credits the IDR balance with the paid amount and marks the order CANCELLED", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, {
      user: { id: user.id, role: user.role },
      productId: product.id,
      quantity: 1,
    }))!; // 5.00 IDR total, currency IDR

    const before = await balances(user.id);
    const res = await creditOrderToBalance(prisma, { orderId: order.id, adminId: 7 });

    expect(res.currency).toBe("IDR");
    expect(new Decimal(res.credited).equals(order.totalAmount)).toBe(true);

    const after = await balances(user.id);
    expect(Number(after.walletBalance) - Number(before.walletBalance)).toBeCloseTo(
      Number(order.totalAmount),
    );
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(Number(before.walletBalanceUsdt)); // USDT untouched

    expect((await getOrder(prisma, order.id))!.status).toBe("CANCELLED");

    const led = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "unfulfilled_credit" },
    });
    expect(led.currency).toBe("IDR");
    expect(led.adminId).toBe(7);
  });

  it("credits the USDT balance for a USDT order — IDR untouched", async () => {
    const { user, product } = sample;
    const created = await prisma.$transaction((tx) =>
      createInternalOrder(tx, {
        user: { id: user.id, role: user.role },
        productId: product.id,
        quantity: 1,
        rate: 1, // USDT total ≈ 5.00
      }),
    );
    const order = (await getOrder(prisma, created!.id))!;
    expect(order.currency).toBe("USDT");

    const before = await balances(user.id);
    const res = await creditOrderToBalance(prisma, { orderId: order.id, adminId: 9 });

    expect(res.currency).toBe("USDT");
    const after = await balances(user.id);
    expect(Number(after.walletBalanceUsdt) - Number(before.walletBalanceUsdt)).toBeCloseTo(
      Number(order.totalAmount),
    );
    expect(Number(after.walletBalance)).toBeCloseTo(Number(before.walletBalance)); // IDR untouched
    expect((await getOrder(prisma, order.id))!.status).toBe("CANCELLED");

    const led = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "unfulfilled_credit" },
    });
    expect(led.currency).toBe("USDT");
  });

  it("credits an explicit amount when provided", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, {
      user: { id: user.id, role: user.role },
      productId: product.id,
      quantity: 1,
    }))!;
    const before = await balances(user.id);
    await creditOrderToBalance(prisma, { orderId: order.id, amount: "3.00", adminId: 1 });
    const after = await balances(user.id);
    expect(Number(after.walletBalance) - Number(before.walletBalance)).toBeCloseTo(3);
  });

  it("is idempotent — a retry does not double-credit", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, {
      user: { id: user.id, role: user.role },
      productId: product.id,
      quantity: 1,
    }))!;
    await creditOrderToBalance(prisma, { orderId: order.id, adminId: 1 });
    const after1 = await balances(user.id);

    await expect(
      creditOrderToBalance(prisma, { orderId: order.id, adminId: 1 }),
    ).rejects.toMatchObject({ key: "error.order_terminal" });

    const after2 = await balances(user.id);
    expect(Number(after2.walletBalance)).toBeCloseTo(Number(after1.walletBalance));
    expect(
      await prisma.walletTransaction.count({
        where: { orderId: order.id, reason: "unfulfilled_credit" },
      }),
    ).toBe(1);
  });

  it("re-tags a linked processed_binance_tx row as credited_to_balance", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, {
      user: { id: user.id, role: user.role },
      productId: product.id,
      quantity: 1,
    }))!;
    await prisma.processedBinanceTx.create({
      data: { binanceTxId: "CTX-1", amount: new Decimal("5.00"), outcome: "unmatched" },
    });

    await creditOrderToBalance(prisma, {
      orderId: order.id,
      amount: "5.00",
      adminId: 3,
      binanceTxId: "CTX-1",
    });

    const row = await prisma.processedBinanceTx.findUniqueOrThrow({ where: { binanceTxId: "CTX-1" } });
    expect(row.outcome).toBe("credited_to_balance");
    expect(row.orderId).toBe(order.id);
  });
});
