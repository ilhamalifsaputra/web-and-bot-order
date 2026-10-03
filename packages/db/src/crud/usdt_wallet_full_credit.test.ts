/**
 * A3 / money audit P1 — a USDT wallet credit that covers a whole order on a
 * GATEWAY rail must never leave the unique cents behind as the amount due.
 *
 * `applyUsdtWalletToOrder` clamps the credit to `totalAmount − uniqueCents`, so
 * a credit that covers the goods used to leave `totalAmount == uniqueCents`
 * (e.g. 0.046 USDT) on a Binance/Bybit/BSC/NOWPayments order: the balance was
 * debited, and the order sat PENDING_PAYMENT asking the buyer to send dust.
 * `finalizeOrderPayment` deliberately skipped the rail-minimum guard for that
 * case, so nothing refused it. The IDR equivalent was already refused (the
 * rail-minimum guard / `nothing_to_collect` backstop), and a fully covered
 * order has its own rail: WALLET (`completeOrderWithWalletCredit`).
 *
 * Every rejection case re-reads the database afterwards: the requirement is not
 * just "it threw" but "nothing was debited and no order was left behind", which
 * only holds because the whole checkout runs in one transaction.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { config } from "@app/core/config";
import { OrderCurrency, OrderStatus, PaymentMethod } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { adjustWallet } from "./users";
import { createOrderDirect, applyUsdtWalletToOrder, getOrder } from "./orders";
import { finalizeOrderPayment } from "./pricing";
import { createInternalOrder } from "./binance_internal";
import { createBybitOrder } from "./bybit_deposit";
import { createBybitBscOrder } from "./bybit_bsc_deposit";
import { completeOrderWithWalletCredit } from "./wallet_checkout";
import { setSetting, __clearSettingsCacheForTests } from "./settings";
import { MIN_ORDER_AMOUNT_IDR_KEY } from "./orderMinimums";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let originalUniqueCents: boolean;

// Rp160.000 at Rp16.000 per USDT = a round 10 USDT before unique cents.
const RATE = "16000";
const PRICE_IDR = "160000";

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
  originalUniqueCents = config.USE_UNIQUE_CENTS;
});
afterAll(async () => {
  config.USE_UNIQUE_CENTS = originalUniqueCents;
  await db.cleanup();
});
beforeEach(async () => {
  // The bug only exists with unique cents on — which is the production default.
  config.USE_UNIQUE_CENTS = true;
  await resetDb(prisma);
  __clearSettingsCacheForTests(prisma);
  sample = await buildSampleData(prisma);
  await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: PRICE_IDR } });
  // Clear the shop-wide floor so the only thing that can refuse a fully covered
  // order is the "nothing left to collect" rule itself, not a configured figure.
  await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
});

const usdtBalance = async () =>
  new Decimal((await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalanceUsdt);
const idrBalance = async () =>
  new Decimal((await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalance);

type GatewayRail = {
  name: string;
  create: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0], walletAmount: Decimal.Value) => Promise<unknown>;
};

const baseArgs = () => ({
  channel: "bot" as const,
  user: { id: sample.user.id, role: sample.user.role },
  productId: sample.product.id,
  quantity: 1,
  rate: RATE,
});

/** The four USDT gateway rails the bot's buyNow* handlers can reach with credit. */
const RAILS: GatewayRail[] = [
  { name: "Binance Internal", create: (tx, walletAmount) => createInternalOrder(tx, { ...baseArgs(), walletAmount }) },
  { name: "Bybit", create: (tx, walletAmount) => createBybitOrder(tx, { ...baseArgs(), walletAmount }) },
  { name: "Bybit BSC", create: (tx, walletAmount) => createBybitBscOrder(tx, { ...baseArgs(), walletAmount }) },
  {
    // Same composition as the bot's buyNowNowpayments transaction.
    name: "NOWPayments",
    create: async (tx, walletAmount) => {
      const created = await createOrderDirect(tx, { ...baseArgs() });
      await finalizeOrderPayment(tx, created!.id, {
        currency: OrderCurrency.USDT,
        rate: RATE,
        method: PaymentMethod.NOWPAYMENTS,
        walletAmount,
      });
      await applyUsdtWalletToOrder(tx, created!.id, walletAmount);
      return getOrder(tx, created!.id);
    },
  },
];

describe("a USDT credit covering the whole order on a gateway rail", () => {
  for (const rail of RAILS) {
    it(`${rail.name}: is refused before anything is debited — no dust order left PENDING_PAYMENT`, async () => {
      await adjustWallet(prisma, sample.user.id, "12", { currency: "USDT", reason: "admin_adjust" });
      const before = await usdtBalance();

      await expect(prisma.$transaction((tx) => rail.create(tx, before))).rejects.toMatchObject({
        key: "error.amount_too_small_for_rail",
      });

      expect((await usdtBalance()).toString()).toBe(before.toString());
      expect(await prisma.order.count({ where: { userId: sample.user.id } })).toBe(0);
      expect(await prisma.walletTransaction.count({ where: { userId: sample.user.id, reason: "order_payment" } })).toBe(0);
    });
  }

  it("applyUsdtWalletToOrder itself refuses to leave only the unique cents payable on a gateway order", async () => {
    // A caller that forgets to tell finalizeOrderPayment about the credit must
    // still not strand the buyer: the debiting function is the last line.
    await adjustWallet(prisma, sample.user.id, "12", { currency: "USDT", reason: "admin_adjust" });
    const before = await usdtBalance();
    await expect(
      prisma.$transaction(async (tx) => {
        const created = await createOrderDirect(tx, { ...baseArgs() });
        await finalizeOrderPayment(tx, created!.id, {
          currency: OrderCurrency.USDT,
          rate: RATE,
          method: PaymentMethod.BINANCE_INTERNAL,
        });
        await applyUsdtWalletToOrder(tx, created!.id, before);
      }),
    ).rejects.toMatchObject({ key: "error.amount_too_small_for_rail" });
    expect((await usdtBalance()).toString()).toBe(before.toString());
    expect(await prisma.order.count({ where: { userId: sample.user.id } })).toBe(0);
  });

  it("is still settled in full through the WALLET rail, with nothing left to pay", async () => {
    await adjustWallet(prisma, sample.user.id, "12", { currency: "USDT", reason: "admin_adjust" });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalanceUsdt: user.walletBalanceUsdt },
        channel: "bot",
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.USDT,
        rate: RATE,
      }),
    );
    const order = (await getOrder(prisma, result.order.id))!;
    expect(order.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(order.status).not.toBe(OrderStatus.PENDING_PAYMENT);
    expect(new Decimal(order.totalAmount).isZero()).toBe(true);
    expect(new Decimal(order.walletUsed).toString()).toBe("10");
    expect((await usdtBalance()).toString()).toBe("2");
  });
});

describe("a partial USDT credit on a gateway rail still works", () => {
  for (const rail of RAILS) {
    it(`${rail.name}: debits the credit and leaves the remainder plus the unique cents payable`, async () => {
      await adjustWallet(prisma, sample.user.id, "3", { currency: "USDT", reason: "admin_adjust" });

      const created = (await prisma.$transaction((tx) => rail.create(tx, "3"))) as { id: number };
      const order = (await getOrder(prisma, created.id))!;

      const cents = new Decimal(order.uniqueCents);
      expect(cents.greaterThan(0)).toBe(true);
      expect(new Decimal(order.walletUsed).toString()).toBe("3");
      // 10 USDT − 3 USDT credit = 7 USDT, plus this order's own unique cents.
      expect(new Decimal(order.totalAmount).toString()).toBe(new Decimal(7).plus(cents).toString());
      expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect((await usdtBalance()).isZero()).toBe(true);
    });
  }
});

describe("IDR parity", () => {
  it("a full IDR credit on a gateway rail is refused with the same message as the USDT one", async () => {
    await adjustWallet(prisma, sample.user.id, "200000", { currency: "IDR", reason: "admin_adjust" });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    const before = await idrBalance();

    let idrKey: string | undefined;
    try {
      await prisma.$transaction(async (tx) => {
        const created = await createOrderDirect(tx, {
          channel: "bot",
          user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
          productId: sample.product.id,
          quantity: 1,
          walletAmount: user.walletBalance,
        });
        await finalizeOrderPayment(tx, created!.id, { currency: OrderCurrency.IDR, method: PaymentMethod.TOKOPAY });
      });
    } catch (e) {
      idrKey = (e as { key?: string }).key;
    }
    expect((await idrBalance()).toString()).toBe(before.toString());
    expect(await prisma.order.count({ where: { userId: sample.user.id } })).toBe(0);

    await adjustWallet(prisma, sample.user.id, "12", { currency: "USDT", reason: "admin_adjust" });
    let usdtKey: string | undefined;
    try {
      await prisma.$transaction((tx) => RAILS[0]!.create(tx, "12"));
    } catch (e) {
      usdtKey = (e as { key?: string }).key;
    }

    expect(idrKey).toBe("error.amount_too_small_for_rail");
    expect(usdtKey).toBe(idrKey);
  });
});
