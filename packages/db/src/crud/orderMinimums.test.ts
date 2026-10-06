/**
 * M11 / audit P0-1 — the minimum-order-amount guard.
 *
 * The rejection assertions all re-read the order row afterwards and compare it
 * field by field against the snapshot taken before the call: the whole point of
 * placing the guard before `finalizeOrderPayment`'s first write is that a
 * rejected order stays exactly as its creator left it, so "it threw" is only
 * half the requirement.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { config } from "@app/core/config";
import { OrderCurrency, PaymentMethod } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { addToCart, createOrderFromCart } from "@app/db";
import { setSetting, __clearSettingsCacheForTests } from "./settings";
import { finalizeOrderPayment } from "./pricing";
import {
  MIN_ORDER_AMOUNT_IDR_KEY,
  DEFAULT_MIN_ORDER_AMOUNT_IDR,
  getShopMinOrderAmountIdr,
  resolveRailMinimum,
  orderTotalClearsRailMinimum,
} from "./orderMinimums";
import {
  TOKOPAY_MIN_AMOUNT_KEY,
  BYBIT_MIN_AMOUNT_KEY,
  PAYDISINI_MIN_AMOUNT_KEY,
} from "./_minAmount";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

/** Every field finalizeOrderPayment is capable of writing. */
async function paymentFieldsOf(orderId: number) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  return {
    currency: o.currency,
    fxRate: o.fxRate === null ? null : o.fxRate.toString(),
    paymentMethod: o.paymentMethod,
    uniqueCents: o.uniqueCents.toString(),
    totalAmount: o.totalAmount.toString(),
    paymentRef: o.paymentRef,
    expiresAt: o.expiresAt === null ? null : o.expiresAt.toISOString(),
  };
}

describe("resolveRailMinimum — where each figure comes from", () => {
  beforeEach(async () => {
    __clearSettingsCacheForTests(prisma);
    await prisma.setting.deleteMany();
  });

  it("an unset shop-wide setting means the documented Rp1.000 default", async () => {
    expect((await getShopMinOrderAmountIdr(prisma))!.toString()).toBe(DEFAULT_MIN_ORDER_AMOUNT_IDR);
    const min = await resolveRailMinimum(prisma, { method: PaymentMethod.TOKOPAY, currency: OrderCurrency.IDR });
    expect(min).toMatchObject({ source: "shop", currency: OrderCurrency.IDR, settingKey: MIN_ORDER_AMOUNT_IDR_KEY });
    expect(min!.amount.toString()).toBe("1000");
  });

  it("an admin-cleared shop-wide setting means no shop-wide minimum at all", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
    expect(await getShopMinOrderAmountIdr(prisma)).toBeNull();
    expect(await resolveRailMinimum(prisma, { method: PaymentMethod.TOKOPAY, currency: OrderCurrency.IDR })).toBeNull();
  });

  it("a rail's own <rail>_min_amount overrides the shop-wide figure", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "1000");
    await setSetting(prisma, TOKOPAY_MIN_AMOUNT_KEY, "10000");
    const min = await resolveRailMinimum(prisma, { method: PaymentMethod.TOKOPAY, currency: OrderCurrency.IDR });
    expect(min).toMatchObject({ source: "method", settingKey: TOKOPAY_MIN_AMOUNT_KEY });
    expect(min!.amount.toString()).toBe("10000");
    // PayDisini has no override of its own, so it still falls back to the shop figure.
    const other = await resolveRailMinimum(prisma, { method: PaymentMethod.PAYDISINI, currency: OrderCurrency.IDR });
    expect(other).toMatchObject({ source: "shop" });
    expect(other!.amount.toString()).toBe("1000");
  });

  it("a USDT rail's override is read as USDT, not converted from Rupiah", async () => {
    await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "2.5");
    const min = await resolveRailMinimum(prisma, { method: PaymentMethod.BYBIT, currency: OrderCurrency.USDT });
    expect(min).toMatchObject({ source: "method", currency: OrderCurrency.USDT });
    expect(min!.amount.toString()).toBe("2.5");
  });

  it("the shop-wide fallback on a USDT rail stays a Rupiah comparison", async () => {
    // Rp1.000 at 16.000 converts to 0.0625 USDT, which usdtFromIdr's 0.1 step
    // would round to 0.1 — and a Rp100 minimum would round to 0.0, i.e. no
    // minimum at all. Comparing the order's own Rupiah figure instead means the
    // conversion step can never weaken the floor.
    const min = await resolveRailMinimum(prisma, { method: PaymentMethod.BYBIT, currency: OrderCurrency.USDT });
    expect(min).toMatchObject({ source: "shop", currency: OrderCurrency.IDR });
    expect(min!.amount.toString()).toBe("1000");
    expect(
      await orderTotalClearsRailMinimum(prisma, {
        method: PaymentMethod.BYBIT,
        currency: OrderCurrency.USDT,
        idrAmount: "700",
        railAmount: "0",
      }),
    ).toBe(false);
    expect(
      await orderTotalClearsRailMinimum(prisma, {
        method: PaymentMethod.BYBIT,
        currency: OrderCurrency.USDT,
        idrAmount: "16000",
        railAmount: "1",
      }),
    ).toBe(true);
  });

  it("WALLET has no minimum in either currency, whatever is configured", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "50000");
    for (const currency of [OrderCurrency.IDR, OrderCurrency.USDT] as const) {
      expect(await resolveRailMinimum(prisma, { method: PaymentMethod.WALLET, currency })).toBeNull();
      expect(
        await orderTotalClearsRailMinimum(prisma, {
          method: PaymentMethod.WALLET,
          currency,
          idrAmount: "0",
          railAmount: "0",
        }),
      ).toBe(true);
    }
  });

  it("a total that rounds away in the rail's own currency is refused even with every minimum cleared", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
    expect(
      await orderTotalClearsRailMinimum(prisma, {
        method: PaymentMethod.BYBIT,
        currency: OrderCurrency.USDT,
        idrAmount: "700",
        railAmount: "0",
      }),
    ).toBe(false);
  });
});

describe("finalizeOrderPayment — rejects a gateway-bound total below the rail minimum", () => {
  let sample: SampleData;
  let orderId: number;

  beforeEach(async () => {
    await resetDb(prisma);
    __clearSettingsCacheForTests(prisma);
    sample = await buildSampleData(prisma);
    // The shared fixture's product is Rp5.00 — comfortably under any real
    // minimum, which is exactly what these cases need.
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    orderId = (await createOrderFromCart(prisma, { channel: "bot", user: sample.user }))!.id;
  });

  it("IDR: throws error.amount_below_rail_minimum and leaves the order row untouched", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "1000");
    const before = await paymentFieldsOf(orderId);
    await expect(
      finalizeOrderPayment(prisma, orderId, { currency: OrderCurrency.IDR }),
    ).rejects.toMatchObject({ key: "error.amount_below_rail_minimum" });
    expect(await paymentFieldsOf(orderId)).toEqual(before);
  });

  it("IDR: the rejection reports the rail's OWN minimum when one is set", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "1");
    await setSetting(prisma, PAYDISINI_MIN_AMOUNT_KEY, "25000");
    await expect(
      finalizeOrderPayment(prisma, orderId, { currency: OrderCurrency.IDR, method: PaymentMethod.PAYDISINI }),
    ).rejects.toMatchObject({
      key: "error.amount_below_rail_minimum",
      formatArgs: { min: "25000", currency: OrderCurrency.IDR },
    });
  });

  it("USDT: throws before any gateway state exists — no paymentRef, no expiry", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "1000");
    const before = await paymentFieldsOf(orderId);
    await expect(
      finalizeOrderPayment(prisma, orderId, {
        currency: OrderCurrency.USDT,
        rate: "16000",
        method: PaymentMethod.BINANCE_INTERNAL,
      }),
    ).rejects.toMatchObject({ key: "error.amount_below_rail_minimum" });
    const after = await paymentFieldsOf(orderId);
    expect(after).toEqual(before);
    expect(after.paymentRef).toBeNull();
  });

  it("USDT: a rail's own USDT minimum is compared against the converted total", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "1");
    await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "5");
    await expect(
      finalizeOrderPayment(prisma, orderId, {
        currency: OrderCurrency.USDT,
        rate: "16000",
        method: PaymentMethod.BYBIT,
      }),
    ).rejects.toMatchObject({
      key: "error.amount_below_rail_minimum",
      formatArgs: { min: "5", currency: OrderCurrency.USDT },
    });
  });

  // This case used to be "Rp5 converts to 0.0 USDT, so the backstop fires".
  // M13 / P2-1 changed `usdtFromIdr` to round UP to the next cent, so no
  // positive Rupiah total converts away to nothing any more and that scenario
  // is unreachable — the fixture's Rp5 now converts to 0.01 and is accepted.
  // Both halves are pinned here so nobody "restores" the old expectation by
  // reading the module doc alone.
  it("USDT: a tiny Rupiah total is now accepted with every minimum cleared, because it no longer rounds to 0.0", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
    const order = await finalizeOrderPayment(prisma, orderId, {
      currency: OrderCurrency.USDT,
      rate: "16000",
      method: PaymentMethod.BYBIT_BSC,
    });
    expect(order!.currency).toBe(OrderCurrency.USDT);
    // Rp5 / 16.000 = 0.0003125, ceilinged to one cent.
    expect(new Decimal(order!.totalAmount).minus(order!.uniqueCents).toString()).toBe("0.01");
  });

  it("USDT: the nothing-to-collect backstop still fires on a genuinely zero rail total", async () => {
    // What the backstop now guards: a total that really is zero, not one that
    // rounded away. Asserted through the shared predicate rather than through
    // `finalizeOrderPayment`, because a zero-value order is routed to the
    // wallet-settlement path before it can reach the finalize guard (M11).
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
    expect(
      await orderTotalClearsRailMinimum(prisma, {
        method: PaymentMethod.BYBIT_BSC,
        currency: OrderCurrency.USDT,
        idrAmount: "0",
        railAmount: "0",
      }),
    ).toBe(false);
  });

  it("a total AT the minimum is accepted (the floor is inclusive)", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "5");
    const order = await finalizeOrderPayment(prisma, orderId, { currency: OrderCurrency.IDR });
    expect(order!.paymentMethod).toBe(PaymentMethod.TOKOPAY);
    expect(new Decimal(order!.totalAmount).toString()).toBe("5");
  });

  it("WALLET is exempt in both currencies, at any configured minimum", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "1000000");
    const idr = await finalizeOrderPayment(prisma, orderId, {
      currency: OrderCurrency.IDR,
      method: PaymentMethod.WALLET,
    });
    expect(idr!.paymentMethod).toBe(PaymentMethod.WALLET);

    // A second order for the USDT half — the first is no longer PENDING-eligible
    // for a re-finalize in a meaningful way once stamped.
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const second = (await createOrderFromCart(prisma, { channel: "bot", user: sample.user }))!;
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    try {
      const usdt = await finalizeOrderPayment(prisma, second.id, {
        currency: OrderCurrency.USDT,
        rate: "16000",
        method: PaymentMethod.WALLET,
      });
      expect(usdt!.paymentMethod).toBe(PaymentMethod.WALLET);
      // Rp5 converts to 0.01 USDT (M13 / P2-1 — it was 0.0 under the old
      // 0.1-half-up step). WALLET carries no unique cents, so the total is the
      // converted figure exactly, and no minimum of any kind may touch it.
      expect(new Decimal(usdt!.totalAmount).toString()).toBe("0.01");
      expect(new Decimal(usdt!.uniqueCents).isZero()).toBe(true);
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
  });
});

/**
 * Whole-branch review D6 — the guard runs against what is LEFT TO COLLECT.
 *
 * Every USDT caller (`createInternalOrder`, `createBybitOrder`,
 * `createBybitBscOrder`, the bot's NOWPayments handler) finalizes the order and
 * THEN spends the buyer's USDT credit on it with `applyUsdtWalletToOrder`. The
 * minimum guard used to sit in between, judging the total before the credit —
 * so an order whose credit left a sliver behind was finalized against a rail
 * that then refused that sliver out of band, and the buyer was parked on a
 * payment screen that could never succeed. Exactly the failure M11 exists to
 * prevent, reintroduced by the ordering.
 *
 * `finalizeOrderPayment` is called directly here, with `walletAmount` in the
 * choice, because that is the seam under test: the credit is not spent by these
 * cases at all, so no balance needs seeding.
 */
describe("finalizeOrderPayment — the USDT minimum is judged after the buyer's credit, not before", () => {
  let sample: SampleData;
  let orderId: number;

  beforeEach(async () => {
    await resetDb(prisma);
    __clearSettingsCacheForTests(prisma);
    sample = await buildSampleData(prisma);
    // Rp160.000 at the Rp16.000 rate every case below uses = a round 10 USDT,
    // so each expectation is arithmetic a reader can check without a calculator.
    await prisma.denomination.update({
      where: { id: sample.product.id },
      data: { price: "160000" },
    });
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    orderId = (await createOrderFromCart(prisma, { channel: "bot", user: sample.user }))!.id;
  });

  const finalizeUsdt = (walletAmount?: string) =>
    finalizeOrderPayment(prisma, orderId, {
      currency: OrderCurrency.USDT,
      rate: "16000",
      method: PaymentMethod.BYBIT,
      ...(walletAmount === undefined ? {} : { walletAmount }),
    });

  it("refuses a rail whose USDT minimum only the pre-credit total cleared", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
    await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "5");
    // 10 USDT clears a 5 USDT floor; 10 − 6 = 4 USDT does not, and 4 is all the
    // gateway would ever be asked for.
    const before = await paymentFieldsOf(orderId);
    await expect(finalizeUsdt("6")).rejects.toMatchObject({
      key: "error.amount_below_rail_minimum",
      formatArgs: { min: "5", currency: OrderCurrency.USDT },
    });
    expect(await paymentFieldsOf(orderId)).toEqual(before);
  });

  it("refuses against the shop-wide RUPIAH floor too, at the credit's own Rupiah equivalent", async () => {
    // The shop-wide minimum is a Rupiah figure, so the credit has to be
    // converted back to be comparable: 6 USDT × Rp16.000 = Rp96.000 off a
    // Rp160.000 order leaves Rp64.000, under the Rp100.000 floor.
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "100000");
    await expect(finalizeUsdt("6")).rejects.toMatchObject({
      key: "error.amount_below_rail_minimum",
      formatArgs: { min: "100000", currency: OrderCurrency.IDR },
    });
    // …and the same order with no credit at all still clears it.
    const order = await finalizeUsdt();
    expect(order!.currency).toBe(OrderCurrency.USDT);
  });

  it("accepts a credit that leaves enough behind, and does not itself spend it", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
    await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "5");
    const order = await finalizeUsdt("2"); // 10 − 2 = 8, still over the floor
    expect(order!.currency).toBe(OrderCurrency.USDT);
    // Spending the credit is `applyUsdtWalletToOrder`'s job, which the caller
    // runs next: the total stamped here is still the full converted figure.
    expect(new Decimal(order!.totalAmount).minus(order!.uniqueCents).toString()).toBe("10");
    expect(new Decimal(order!.walletUsed).isZero()).toBe(true);
  });

  it("refuses a gateway rail for an order the credit covers entirely — nothing would be left but the unique cents", async () => {
    // A3 / money audit P1: this used to be exempt, and the credit then left the
    // order asking the buyer to send only its unique cents. A fully covered
    // order belongs on the WALLET rail; on a gateway it is refused untouched.
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
    const before = await paymentFieldsOf(orderId);
    await expect(finalizeUsdt("10")).rejects.toMatchObject({
      key: "error.amount_too_small_for_rail",
      formatArgs: { currency: OrderCurrency.USDT },
    });
    expect(await paymentFieldsOf(orderId)).toEqual(before);
  });

  it("still lets the WALLET rail take an order the credit covers entirely, whatever the floor", async () => {
    // Deliberately a floor nothing could clear: WALLET collects nothing through
    // a gateway, so no rail minimum applies to it.
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "1000000");
    const order = await finalizeOrderPayment(prisma, orderId, {
      currency: OrderCurrency.USDT,
      rate: "16000",
      method: PaymentMethod.WALLET,
      walletAmount: "10",
    });
    expect(order!.currency).toBe(OrderCurrency.USDT);
    expect(new Decimal(order!.uniqueCents).isZero()).toBe(true);
  });

  it("never lets a credit weaken the IDR rail's own floor", async () => {
    // The IDR branch takes no credit: `createOrderFromCart` spends Rupiah credit
    // BEFORE the order is created, so by the time the guard runs the total is
    // already net of it and there is nothing left to subtract.
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "200000");
    await expect(
      finalizeOrderPayment(prisma, orderId, { currency: OrderCurrency.IDR }),
    ).rejects.toMatchObject({ key: "error.amount_below_rail_minimum" });
  });
});
