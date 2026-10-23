// Price lock (Game Top-up Phase 3, Task 2): the bot quotes every rail in IDR —
// the total after bulk discount and voucher, before wallet credit — so the
// three crypto order wrappers must forward that quote to createOrderDirect, and
// the wallet rail must accept it in IDR even on its USDT track.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { OrderCurrency, OrderStatus } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { adjustWallet } from "@app/db";
import { QuoteMismatchError, type ExpectedTotal } from "./orders";
import { createInternalOrder } from "./binance_internal";
import { createBybitOrder } from "./bybit_deposit";
import { createBybitBscOrder } from "./bybit_bsc_deposit";
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
  sample = await buildSampleData(prisma); // price 5.00 IDR; voucher SAVE10 = 10%
});

const idr = (amount: string): ExpectedTotal => ({ currency: OrderCurrency.IDR, amount });

const WRAPPERS = [
  ["createInternalOrder", createInternalOrder],
  ["createBybitOrder", createBybitOrder],
  ["createBybitBscOrder", createBybitBscOrder],
] as const;

describe.each(WRAPPERS)("%s forwards an IDR quote to createOrderDirect", (_name, create) => {
  const run = (expectedTotal: ExpectedTotal, voucherCode: string | null = null) =>
    prisma.$transaction((tx) =>
      create(tx, {
        channel: "bot",
        user: { id: sample.user.id, role: sample.user.role },
        productId: sample.product.id,
        quantity: 1,
        voucherCode,
        rate: "16000",
        expectedTotal,
      }),
    );

  it("creates the USDT order when the IDR quote equals the current total (4-dp string compares by value)", async () => {
    const order = await run(idr("4.0000"), "SAVE10"); // 5.00 less SAVE10 (rounded to whole rupiah)
    expect(order?.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order?.currency).toBe(OrderCurrency.USDT);
    expect(await prisma.order.count()).toBe(1);
  });

  it("refuses a changed IDR total before anything is written: no order, no voucher bump", async () => {
    await expect(run(idr("4.5"), "SAVE10")).rejects.toBeInstanceOf(QuoteMismatchError);
    expect(await prisma.order.count()).toBe(0);
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: sample.voucher.id } })).usedCount).toBe(0);
  });
});

describe("completeOrderWithWalletCredit accepts an IDR ExpectedTotal on both tracks", () => {
  async function user() {
    return prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
  }

  it("USDT track: an IDR quote equal to the total settles the order", async () => {
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    const u = await user();
    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        channel: "bot",
        user: { id: u.id, role: u.role, walletBalanceUsdt: u.walletBalanceUsdt },
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.USDT,
        rate: 1,
        expectedTotal: idr("5"),
      }),
    );
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
  });

  it("USDT track: a changed IDR quote throws QuoteMismatchError and debits nothing", async () => {
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    const u = await user();
    await expect(
      prisma.$transaction((tx) =>
        completeOrderWithWalletCredit(tx, {
          channel: "bot",
          user: { id: u.id, role: u.role, walletBalanceUsdt: u.walletBalanceUsdt },
          productId: sample.product.id,
          quantity: 1,
          currency: OrderCurrency.USDT,
          rate: 1,
          expectedTotal: idr("4"),
        }),
      ),
    ).rejects.toBeInstanceOf(QuoteMismatchError);
    expect(await prisma.order.count()).toBe(0);
    expect(new Decimal((await user()).walletBalanceUsdt).equals(5)).toBe(true);
  });

  it("IDR track: an IDR quote object is compared before the wallet debit", async () => {
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    const u = await user();
    await expect(
      prisma.$transaction((tx) =>
        completeOrderWithWalletCredit(tx, {
          channel: "bot",
          user: { id: u.id, role: u.role, walletBalance: u.walletBalance },
          productId: sample.product.id,
          quantity: 1,
          currency: OrderCurrency.IDR,
          expectedTotal: idr("6"),
        }),
      ),
    ).rejects.toBeInstanceOf(QuoteMismatchError);
    expect(new Decimal((await user()).walletBalance).equals(10)).toBe(true);

    const ok = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        channel: "bot",
        user: { id: u.id, role: u.role, walletBalance: u.walletBalance },
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.IDR,
        expectedTotal: idr("5.00"),
      }),
    );
    expect(ok.order.status).toBe(OrderStatus.DELIVERED);
  });

  it("the storefront's bare-amount form keeps its meaning: a USDT amount at the given rate", async () => {
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    const u = await user();
    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        channel: "web",
        user: { id: u.id, role: u.role, walletBalanceUsdt: u.walletBalanceUsdt },
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.USDT,
        rate: 1,
        expectedTotal: new Decimal("5"),
      }),
    );
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
  });
});
