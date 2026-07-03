import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { OrderCurrency, OrderStatus, PaymentMethod, StockStatus } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { adjustWallet, getOrder, markStockDead } from "@app/db";
import { completeOrderWithWalletCredit } from "./wallet_checkout";

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
  sample = await buildSampleData(prisma); // product price "5.00" IDR
});

async function freshUser() {
  return prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
}

describe("completeOrderWithWalletCredit — IDR track", () => {
  it("fully covered by IDR credit: delivers immediately, debits exactly the price, method WALLET", async () => {
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.IDR,
      }),
    );

    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.order.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(result.order.currency).toBe(OrderCurrency.IDR);
    expect(new Decimal(result.order.totalAmount).equals(0)).toBe(true);
    expect(new Decimal(result.order.walletUsed).equals("5.00")).toBe(true);
    expect(result.credentials).toHaveLength(1);

    const after = await freshUser();
    expect(Number(after.walletBalance)).toBeCloseTo(5); // 10 - 5.00

    const sold = await prisma.stockItem.findMany({ where: { productId: sample.product.id, status: StockStatus.SOLD } });
    expect(sold).toHaveLength(1);
  });

  it("insufficient IDR balance: throws, makes no wallet or stock change", async () => {
    await adjustWallet(prisma, sample.user.id, "2", { currency: "IDR", reason: "admin_adjust" }); // less than the 5.00 price
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
          productId: sample.product.id,
          quantity: 1,
          currency: OrderCurrency.IDR,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.insufficient_wallet" });

    const after = await freshUser();
    expect(Number(after.walletBalance)).toBeCloseTo(2); // untouched — the transaction rolled back
    const sold = await prisma.stockItem.findMany({ where: { productId: sample.product.id, status: StockStatus.SOLD } });
    expect(sold).toHaveLength(0);
  });

  it("voucher discount + IDR credit combine to reach zero", async () => {
    // SAVE10 = 10% off, minPurchase 3 — product is 5.00, discount 0.50, net 4.50.
    await adjustWallet(prisma, sample.user.id, "4.50", { currency: "IDR", reason: "admin_adjust" });
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        productId: sample.product.id,
        quantity: 1,
        voucherCode: sample.voucher.code,
        currency: OrderCurrency.IDR,
      }),
    );
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(new Decimal(result.order.totalAmount).equals(0)).toBe(true);
    expect(new Decimal(result.order.discountAmount).equals("0.50")).toBe(true);
  });
});

describe("completeOrderWithWalletCredit — USDT track", () => {
  it("fully covered by USDT credit: delivers immediately, debits the converted total, IDR balance untouched", async () => {
    // rate 1 keeps the USDT total numerically equal to the 5.00 central price.
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    await adjustWallet(prisma, sample.user.id, "100", { currency: "IDR", reason: "admin_adjust" });
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalanceUsdt: user.walletBalanceUsdt },
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.USDT,
        rate: 1,
      }),
    );

    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.order.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(result.order.currency).toBe(OrderCurrency.USDT);
    expect(new Decimal(result.order.totalAmount).equals(0)).toBe(true);

    const after = await freshUser();
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(0); // 5 - 5
    expect(Number(after.walletBalance)).toBeCloseTo(100); // IDR untouched
  });

  it("insufficient USDT balance: throws, IDR and USDT balances both untouched", async () => {
    await adjustWallet(prisma, sample.user.id, "1", { currency: "USDT", reason: "admin_adjust" }); // less than 5
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalanceUsdt: user.walletBalanceUsdt },
          productId: sample.product.id,
          quantity: 1,
          currency: OrderCurrency.USDT,
          rate: 1,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.insufficient_wallet" });

    const after = await freshUser();
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(1);
  });

  it("out of stock at completion time: throws, wallet untouched", async () => {
    // Mark all 5 seeded stock items dead so none remain available (same
    // technique as order_creation.test.ts's own out-of-stock test).
    const items = await prisma.stockItem.findMany({ where: { productId: sample.product.id } });
    for (const it of items) await markStockDead(prisma, it.id, "test");
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalanceUsdt: user.walletBalanceUsdt },
          productId: sample.product.id,
          quantity: 1,
          currency: OrderCurrency.USDT,
          rate: 1,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.out_of_stock" });

    const after = await freshUser();
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(5);
  });
});
