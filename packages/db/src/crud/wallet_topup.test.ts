import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { OrderCurrency, OrderKind, OrderStatus, PaymentMethod } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { getSetting, setSetting, deleteSetting, __clearSettingsCacheForTests } from "./settings";
import { MIN_ORDER_AMOUNT_IDR_KEY } from "./orderMinimums";
import {
  PAYDISINI_MIN_AMOUNT_KEY,
  BYBIT_MIN_AMOUNT_KEY,
  BYBIT_BSC_MIN_AMOUNT_KEY,
  NOWPAYMENTS_MIN_AMOUNT_KEY,
} from "./_minAmount";
import { finalizeOrderPayment } from "./pricing";
import { NotificationEvent } from "@app/core/enums";
import { config } from "@app/core/config";
import { cancelOrder, createOrderDirect } from "./orders";
import { markUnderpaid } from "./binance_internal";
import { markUnderpaidBybit } from "./bybit_deposit";
import { markOrderUnderpaid } from "./orderStatus";
import {
  resolveWalletTopupLimits,
  createWalletTopupOrder,
  settleWalletTopup,
  creditUnderpaidTopupAnyway,
  hasPendingWalletTopupOrder,
  WALLET_TOPUP_MIN_AMOUNT_IDR_KEY,
  WALLET_TOPUP_MAX_AMOUNT_IDR_KEY,
  WALLET_TOPUP_MIN_AMOUNT_USDT_KEY,
  WALLET_TOPUP_MAX_AMOUNT_USDT_KEY,
  walletTopupRailAmounts,
  walletTopupRailMinimumFailure,
  walletTopupClearsRailMinimum,
  resolveWalletTopupRailFloor,
  resolveWalletTopupEffectiveMin,
  type WalletTopupUsdtMethod,
} from "./wallet_topup";

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

async function freshUser() {
  return prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
}

describe("resolveWalletTopupLimits", () => {
  it("absent Settings rows resolve to null (no cap) for all four bounds", async () => {
    const limits = await resolveWalletTopupLimits(prisma);
    expect(limits).toEqual({ minIdr: null, maxIdr: null, minUsdt: null, maxUsdt: null });
  });

  it("blank Settings values resolve to null", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "");
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_USDT_KEY, "   ");
    const limits = await resolveWalletTopupLimits(prisma);
    expect(limits.minIdr).toBeNull();
    expect(limits.maxUsdt).toBeNull();
  });

  it("invalid (non-numeric / non-positive) Settings values resolve to null", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "not-a-number");
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_IDR_KEY, "-100");
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_USDT_KEY, "0");
    const limits = await resolveWalletTopupLimits(prisma);
    expect(limits.minIdr).toBeNull();
    expect(limits.maxIdr).toBeNull();
    expect(limits.minUsdt).toBeNull();
  });

  it("valid Settings values parse to the matching Decimal per currency/bound", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "10000");
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_IDR_KEY, "5000000");
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_USDT_KEY, "1");
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_USDT_KEY, "1000");
    const limits = await resolveWalletTopupLimits(prisma);
    expect(limits.minIdr?.equals("10000")).toBe(true);
    expect(limits.maxIdr?.equals("5000000")).toBe(true);
    expect(limits.minUsdt?.equals("1")).toBe(true);
    expect(limits.maxUsdt?.equals("1000")).toBe(true);
  });
});

describe("createWalletTopupOrder — amount fidelity (regression test for Global Constraint 2)", () => {
  // THE bug this task exists to prevent: finalizeOrderPayment's USDT branch
  // always computes usdt = usdtFromIdr(baseIdr, rate) — correct for a product
  // order (whose stored total IS central-IDR), catastrophically wrong for a
  // top-up (whose typed amount ALREADY IS the USDT figure). At a 16000 rate,
  // usdtFromIdr(50, 16000) ~= 0.003 — "top up 50 USDT" would silently become
  // "top up ~0.003 USDT" if createWalletTopupOrder reused that branch
  // unchanged. These two tests assert the stored totalAmount equals the
  // typed amount (modulo unique-cents noise, which is bounded to the
  // documented 0.002-0.098 bucket range from computeUniqueCents and is
  // asserted EXACTLY via `amount + order.uniqueCents`, not a loose delta) —
  // not a rate-converted figure.

  it("IDR top-up: totalAmount equals the typed amount exactly (uniqueCents always stripped to 0 for IDR)", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "50000",
        currency: "IDR",
        method: PaymentMethod.TOKOPAY,
      }),
    );
    expect(order.kind).toBe(OrderKind.WALLET_TOPUP);
    expect(order.currency).toBe(OrderCurrency.IDR);
    expect(new Decimal(order.uniqueCents).equals(0)).toBe(true);
    expect(new Decimal(order.totalAmount).equals("50000")).toBe(true);
  });

  it("USDT top-up: totalAmount equals the typed amount plus its own uniqueCents — NEVER a rate-converted figure", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "50",
        currency: "USDT",
        method: PaymentMethod.NOWPAYMENTS,
        rate: "16000",
      }),
    );
    expect(order.kind).toBe(OrderKind.WALLET_TOPUP);
    expect(order.currency).toBe(OrderCurrency.USDT);
    // uniqueCents noise is bounded to computeUniqueCents' 0.002-0.098 bucket
    // range — assert it exactly, not loosely.
    expect(new Decimal(order.uniqueCents).greaterThanOrEqualTo(0)).toBe(true);
    expect(new Decimal(order.uniqueCents).lessThan("0.1")).toBe(true);
    expect(new Decimal(order.totalAmount).equals(new Decimal("50").plus(order.uniqueCents))).toBe(true);
    // Explicitly rule out the usdtFromIdr(50, 16000) ~= 0.003 bug — the real
    // total must be far closer to 50 than to that.
    expect(new Decimal(order.totalAmount).greaterThan("40")).toBe(true);
    // fxRate is still stamped for record-keeping even though it played no
    // role in the amount.
    expect(new Decimal(order.fxRate!).equals("16000")).toBe(true);
  });
});

describe("createWalletTopupOrder — creates a bare Order (kind + zero OrderItem rows)", () => {
  it("kind is WALLET_TOPUP and no OrderItem rows are created", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "20000",
        currency: "IDR",
        method: PaymentMethod.TOKOPAY,
      }),
    );
    expect(order.kind).toBe(OrderKind.WALLET_TOPUP);
    expect(order.items).toHaveLength(0);
    const itemRows = await prisma.orderItem.count({ where: { orderId: order.id } });
    expect(itemRows).toBe(0);
    expect(order.voucherId).toBeNull();
  });
});

describe("hasPendingWalletTopupOrder", () => {
  it("is false when the buyer has no pending top-up order at all", async () => {
    const dupe = await hasPendingWalletTopupOrder(prisma, {
      userId: sample.user.id,
      method: PaymentMethod.TOKOPAY,
      sinceMs: 30_000,
    });
    expect(dupe).toBe(false);
  });

  it("is true for a same-rail PENDING_PAYMENT top-up order created within the window", async () => {
    await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
    const dupe = await hasPendingWalletTopupOrder(prisma, {
      userId: sample.user.id,
      method: PaymentMethod.TOKOPAY,
      sinceMs: 30_000,
    });
    expect(dupe).toBe(true);
  });

  it("is false for a DIFFERENT rail — the duplicate guard is per payment method", async () => {
    await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
    const dupe = await hasPendingWalletTopupOrder(prisma, {
      userId: sample.user.id,
      method: PaymentMethod.PAYDISINI,
      sinceMs: 30_000,
    });
    expect(dupe).toBe(false);
  });

  it("is false once the pending top-up order is outside the window", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
    await prisma.order.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    const dupe = await hasPendingWalletTopupOrder(prisma, {
      userId: sample.user.id,
      method: PaymentMethod.TOKOPAY,
      sinceMs: 30_000,
    });
    expect(dupe).toBe(false);
  });

  it("is false once the order is no longer PENDING_PAYMENT (e.g. delivered)", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: "20000" }));
    const dupe = await hasPendingWalletTopupOrder(prisma, {
      userId: sample.user.id,
      method: PaymentMethod.TOKOPAY,
      sinceMs: 30_000,
    });
    expect(dupe).toBe(false);
  });

  it("a PENDING PRODUCT order under the same method never counts as a duplicate top-up", async () => {
    // A plain product order stamped to the same rail (kind defaults to
    // PRODUCT) must not block a top-up — the guard is scoped to
    // kind: WALLET_TOPUP specifically.
    await prisma.order.create({
      data: {
        orderCode: `PRODORDER-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "50000",
        totalAmount: "50000",
        status: OrderStatus.PENDING_PAYMENT,
        paymentMethod: PaymentMethod.TOKOPAY,
      },
    });
    const dupe = await hasPendingWalletTopupOrder(prisma, {
      userId: sample.user.id,
      method: PaymentMethod.TOKOPAY,
      sinceMs: 30_000,
    });
    expect(dupe).toBe(false);
  });
});

describe("createWalletTopupOrder — min/max bound enforcement", () => {
  it("rejects an IDR amount below the configured minimum, creates no order", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "10000");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, { userId: sample.user.id, amount: "5000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_below_min" });
    expect(await prisma.order.count()).toBe(0);
  });

  it("rejects an IDR amount above the configured maximum, creates no order", async () => {
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_IDR_KEY, "1000000");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, { userId: sample.user.id, amount: "2000000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_above_max" });
    expect(await prisma.order.count()).toBe(0);
  });

  it("rejects a USDT amount below the configured minimum, creates no order", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_USDT_KEY, "5");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "1",
          currency: "USDT",
          method: PaymentMethod.NOWPAYMENTS,
          rate: "16000",
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_below_min" });
    expect(await prisma.order.count()).toBe(0);
  });

  it("rejects a USDT amount above the configured maximum, creates no order", async () => {
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_USDT_KEY, "100");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "200",
          currency: "USDT",
          method: PaymentMethod.NOWPAYMENTS,
          rate: "16000",
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_above_max" });
    expect(await prisma.order.count()).toBe(0);
  });
});

/**
 * Whole-branch review D9 — a top-up refused by the SHOP-WIDE rail minimum used
 * to be told to add more items.
 *
 * `min_order_amount_idr` is a different floor from
 * `wallet_topup_min_amount_idr` above: it is the shop's "we will not ask a
 * gateway to collect less than this" figure, enforced inside
 * `finalizeOrderPayment`, which an IDR top-up shares with product checkout. The
 * floor is still shared on purpose — it is a property of the rail, not of what
 * is being bought — but the sentence is not: a top-up buyer has no cart, so
 * "Add more items" was the one instruction they could not follow.
 */
describe("createWalletTopupOrder — an IDR top-up gets top-up wording from the rail minimum (D9)", () => {
  beforeEach(async () => {
    __clearSettingsCacheForTests(prisma);
    // Well clear of the top-up's own minimum, so the failure under test is
    // unambiguously the shop-wide rail floor and not the bound above.
    await deleteSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY);
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "10000");
  });

  it("refuses with the top-up sentence, not the product-order one, and creates no order", async () => {
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, { userId: sample.user.id, amount: "5000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
      ),
    ).rejects.toMatchObject({
      key: "error.wallet_topup_below_rail_minimum",
      // The figure that failed is still carried, even though this key's copy
      // does not print it — the storefront surfaces the key alone.
      formatArgs: { min: "10000", currency: OrderCurrency.IDR },
    });
    expect(await prisma.order.count()).toBe(0);
  });

  it("names a rail's OWN minimum the same way a product order does", async () => {
    await setSetting(prisma, PAYDISINI_MIN_AMOUNT_KEY, "25000");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, { userId: sample.user.id, amount: "5000", currency: "IDR", method: PaymentMethod.PAYDISINI }),
      ),
    ).rejects.toMatchObject({
      key: "error.wallet_topup_below_rail_minimum",
      formatArgs: { min: "25000", currency: OrderCurrency.IDR },
    });
  });

  it("uses the zero-amount backstop's top-up wording for a sub-Rupiah amount", async () => {
    // With every configured floor cleared, the only check left is "we will not
    // ask a gateway to collect nothing" — reachable here because the IDR branch
    // quantizes to whole Rupiah, so Rp0.40 becomes Rp0.
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, { userId: sample.user.id, amount: "0.4", currency: "IDR", method: PaymentMethod.TOKOPAY }),
      ),
    ).rejects.toMatchObject({
      key: "error.wallet_topup_nothing_to_collect",
      formatArgs: { currency: OrderCurrency.IDR },
    });
    expect(await prisma.order.count()).toBe(0);
  });

  it("leaves a PRODUCT order's wording alone — it still has a cart to add to", async () => {
    const order = await createOrderDirect(prisma, {
      user: await freshUser(),
      productId: sample.product.id,
      quantity: 1,
    });
    await expect(
      finalizeOrderPayment(prisma, order!.id, { currency: OrderCurrency.IDR, method: PaymentMethod.TOKOPAY }),
    ).rejects.toMatchObject({ key: "error.amount_below_rail_minimum" });
  });
});

/**
 * Whole-branch review F3 — a USDT top-up never met the rail-minimum guard at
 * all. `createWalletTopupOrder` routes USDT top-ups to
 * `finalizeWalletTopupPayment`, which had no
 * `assertOrderTotalClearsRailMinimum` call, so an amount below a rail's own
 * `<rail>_min_amount` (or below the shop-wide Rupiah floor) was handed to the
 * gateway anyway and refused out of band.
 */
describe("createWalletTopupOrder — a USDT top-up clears the rail minimum too (F3)", () => {
  beforeEach(async () => {
    __clearSettingsCacheForTests(prisma);
    await deleteSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_USDT_KEY);
  });

  it("refuses a USDT amount below the rail's OWN minimum, with the top-up wording, and creates no order", async () => {
    await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "10");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "5",
          currency: "USDT",
          method: PaymentMethod.BYBIT,
          rate: "16000",
        }),
      ),
    ).rejects.toMatchObject({
      key: "error.wallet_topup_below_rail_minimum",
      formatArgs: { min: "10", currency: OrderCurrency.USDT },
    });
    expect(await prisma.order.count()).toBe(0);
  });

  it("refuses a USDT amount whose RUPIAH equivalent is below the shop-wide floor", async () => {
    // 0.5 USDT at 16.000 is Rp8.000, under a Rp10.000 shop floor. The guard's
    // whole point: judge the USDT figure against the USDT floor and the Rupiah
    // equivalent against the Rupiah one, each in its own currency.
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "10000");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "0.5",
          currency: "USDT",
          method: PaymentMethod.BINANCE_INTERNAL,
          rate: "16000",
        }),
      ),
    ).rejects.toMatchObject({
      key: "error.wallet_topup_below_rail_minimum",
      formatArgs: { min: "10000", currency: OrderCurrency.IDR },
    });
    expect(await prisma.order.count()).toBe(0);
  });

  it("accepts a USDT amount whose Rupiah equivalent clears the shop-wide floor", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "10000");
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "1",
        currency: "USDT",
        method: PaymentMethod.BINANCE_INTERNAL,
        rate: "16000",
      }),
    );
    // Rp16.000 equivalent, comfortably over the floor — and the credited figure
    // is still the typed USDT amount, never the Rupiah one it was judged by.
    expect(new Decimal(order.totalAmount).minus(order.uniqueCents).equals("1")).toBe(true);
  });

  it("judges the typed amount, never a rate-converted one — 1 USDT is not 0.01 USDT", async () => {
    // The regression this pairs with: had the guard been handed
    // `usdtFromIdr(amount, rate)` (the product-order derivation) instead of the
    // typed figure, 1 USDT would have been judged as 0.0001 -> 0.01 USDT and
    // refused by any rail floor above a cent.
    await setSetting(prisma, BYBIT_BSC_MIN_AMOUNT_KEY, "0.5");
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "1",
        currency: "USDT",
        method: PaymentMethod.BYBIT_BSC,
        rate: "16000",
      }),
    );
    expect(new Decimal(order.totalAmount).minus(order.uniqueCents).equals("1")).toBe(true);
  });

  it("leaves nothing half-finalized: a refused top-up stamps no payment method, window or reference", async () => {
    // The guard runs before the row is touched, so the rollback has nothing to
    // undo — but assert the observable consequence rather than the ordering.
    await setSetting(prisma, NOWPAYMENTS_MIN_AMOUNT_KEY, "50");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "10",
          currency: "USDT",
          method: PaymentMethod.NOWPAYMENTS,
          rate: "16000",
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_below_rail_minimum" });
    expect(await prisma.order.count()).toBe(0);
  });

  it("the top-up's own USDT bound is checked first, so its wording wins when both would fail", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_USDT_KEY, "20");
    await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "10");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "5",
          currency: "USDT",
          method: PaymentMethod.BYBIT,
          rate: "16000",
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_below_min" });
  });
});

describe("walletTopupRailAmounts — which figure is derived from which (F3)", () => {
  it("a USDT top-up's rail amount is the typed figure and its Rupiah figure is derived", () => {
    const { idrAmount, railAmount } = walletTopupRailAmounts({ currency: "USDT", amount: "2.5", rate: "16000" });
    expect(railAmount.equals("2.5")).toBe(true);
    expect(idrAmount.equals("40000")).toBe(true);
  });

  it("does NOT quantize the Rupiah equivalent — it is a comparison operand, not a stored figure", () => {
    const { idrAmount } = walletTopupRailAmounts({ currency: "USDT", amount: "0.333", rate: "16000" });
    expect(idrAmount.equals("5328")).toBe(true);
  });

  it("an IDR top-up's two figures are the same whole-Rupiah number", () => {
    const { idrAmount, railAmount } = walletTopupRailAmounts({ currency: "IDR", amount: "50000.4" });
    expect(idrAmount.equals("50000")).toBe(true);
    expect(railAmount.equals("50000")).toBe(true);
  });

  it("refuses an unusable rate rather than inventing a Rupiah equivalent", () => {
    expect(() => walletTopupRailAmounts({ currency: "USDT", amount: "5", rate: "0" })).toThrow();
  });
});

describe("resolveWalletTopupRailFloor — the floor in the currency the buyer types (F4b)", () => {
  beforeEach(async () => {
    __clearSettingsCacheForTests(prisma);
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
  });

  it("a rail's own minimum passes through untouched — it is already in the typed currency", async () => {
    await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "12.5");
    const floor = await resolveWalletTopupRailFloor(prisma, {
      currency: "USDT",
      rate: "16000",
      method: PaymentMethod.BYBIT,
    });
    expect(floor?.equals("12.5")).toBe(true);
  });

  it("the shop-wide RUPIAH floor becomes a USDT figure, rounded UP to the cent", async () => {
    // Rp10.000 / 16.000 = 0.625 exactly; Rp10.001 rounds up rather than down,
    // because a floor rounded down is a figure the guard would then refuse.
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "10001");
    const floor = await resolveWalletTopupRailFloor(prisma, {
      currency: "USDT",
      rate: "16000",
      method: PaymentMethod.BINANCE_INTERNAL,
    });
    expect(floor?.equals("0.63")).toBe(true);
    // And the figure it names really does clear the guard it was derived from.
    expect(
      await walletTopupClearsRailMinimum(prisma, {
        currency: "USDT",
        rate: "16000",
        amount: floor!,
        method: PaymentMethod.BINANCE_INTERNAL,
      }),
    ).toBe(true);
  });

  it("an IDR rail's floor is the Rupiah figure as configured", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "15000");
    const floor = await resolveWalletTopupRailFloor(prisma, { currency: "IDR", method: PaymentMethod.TOKOPAY });
    expect(floor?.equals("15000")).toBe(true);
  });

  it("is null when every floor has been cleared", async () => {
    expect(await resolveWalletTopupRailFloor(prisma, { currency: "IDR", method: PaymentMethod.TOKOPAY })).toBeNull();
  });
});

describe("resolveWalletTopupEffectiveMin — what the top-up form should advertise (F4b)", () => {
  beforeEach(async () => {
    __clearSettingsCacheForTests(prisma);
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
    await deleteSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY);
  });

  it("is the rail floor when it is higher than the top-up's own minimum — the Rp1.000-then-refused-at-Rp5.000 bug", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "1000");
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "10000");
    const min = await resolveWalletTopupEffectiveMin(prisma, {
      currency: "IDR",
      methods: [PaymentMethod.TOKOPAY, PaymentMethod.PAYDISINI],
    });
    expect(min?.equals("10000")).toBe(true);
  });

  it("is the top-up's own minimum when that is the higher of the two", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "50000");
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "10000");
    const min = await resolveWalletTopupEffectiveMin(prisma, { currency: "IDR", methods: [PaymentMethod.TOKOPAY] });
    expect(min?.equals("50000")).toBe(true);
  });

  it("takes the LOWEST rail floor among the offered rails — the rails are alternatives", async () => {
    // A Rp10.000 shop floor with PayDisini overriding it down to Rp2.000: a
    // Rp2.000 top-up is payable, just not through QRIS, so the form must not
    // demand Rp10.000.
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "10000");
    await setSetting(prisma, PAYDISINI_MIN_AMOUNT_KEY, "2000");
    const min = await resolveWalletTopupEffectiveMin(prisma, {
      currency: "IDR",
      methods: [PaymentMethod.TOKOPAY, PaymentMethod.PAYDISINI],
    });
    expect(min?.equals("2000")).toBe(true);
  });

  it("an offered rail with no floor of its own makes the rail side vacuous", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "1000");
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
    const min = await resolveWalletTopupEffectiveMin(prisma, { currency: "IDR", methods: [PaymentMethod.TOKOPAY] });
    expect(min?.equals("1000")).toBe(true);
  });

  it("with no rails offered at all, only the top-up's own bound binds", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "1000");
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "99999");
    const min = await resolveWalletTopupEffectiveMin(prisma, { currency: "IDR", methods: [] });
    expect(min?.equals("1000")).toBe(true);
  });

  it("is null when neither floor exists", async () => {
    expect(
      await resolveWalletTopupEffectiveMin(prisma, { currency: "IDR", methods: [PaymentMethod.TOKOPAY] }),
    ).toBeNull();
  });

  it("converts a Rupiah shop floor for a USDT form, and the figure it names is accepted", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "16000");
    const min = await resolveWalletTopupEffectiveMin(prisma, {
      currency: "USDT",
      rate: "16000",
      methods: [PaymentMethod.BINANCE_INTERNAL, PaymentMethod.BYBIT],
    });
    expect(min?.equals("1")).toBe(true);
    expect(
      await walletTopupClearsRailMinimum(prisma, {
        currency: "USDT",
        rate: "16000",
        amount: min!,
        method: PaymentMethod.BINANCE_INTERNAL,
      }),
    ).toBe(true);
  });
});

describe("walletTopupClearsRailMinimum — the form's rail list agrees with the guard (F3)", () => {
  beforeEach(async () => {
    __clearSettingsCacheForTests(prisma);
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
  });

  it("refuses exactly the rail the guard refuses, and accepts the sibling that would take it", async () => {
    await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "10");
    const query = { currency: "USDT", rate: "16000", amount: "5" } as const;
    expect(await walletTopupClearsRailMinimum(prisma, { ...query, method: PaymentMethod.BYBIT })).toBe(false);
    expect(await walletTopupClearsRailMinimum(prisma, { ...query, method: PaymentMethod.BINANCE_INTERNAL })).toBe(true);

    // The predicate's answer is the guard's answer — asserted by actually
    // finalizing through the rail it said yes to.
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "5",
        currency: "USDT",
        method: PaymentMethod.BINANCE_INTERNAL,
        rate: "16000",
      }),
    );
    expect(order.paymentMethod).toBe(PaymentMethod.BINANCE_INTERNAL);
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "5",
          currency: "USDT",
          method: PaymentMethod.BYBIT,
          rate: "16000",
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_below_rail_minimum" });
  });

  it("reports WHY, so a caller can tell a configured floor from the zero-amount backstop", async () => {
    await setSetting(prisma, PAYDISINI_MIN_AMOUNT_KEY, "25000");
    expect(
      await walletTopupRailMinimumFailure(prisma, {
        currency: "IDR",
        amount: "5000",
        method: PaymentMethod.PAYDISINI,
      }),
    ).toMatchObject({ reason: "below_minimum" });
    expect(
      await walletTopupRailMinimumFailure(prisma, {
        currency: "IDR",
        amount: "0.4",
        method: PaymentMethod.TOKOPAY,
      }),
    ).toMatchObject({ reason: "nothing_to_collect" });
  });
});

describe("createWalletTopupOrder — rejects a disabled/unknown method", () => {
  it("rejects an unknown method string", async () => {
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "10000",
          currency: "IDR",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          method: "PAYPAL" as any,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_invalid_method" });
  });

  it("rejects a USDT-only method (BYBIT) for an IDR top-up", async () => {
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "10000",
          currency: "IDR",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          method: PaymentMethod.BYBIT as any,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_invalid_method" });
  });

  it("rejects WALLET as a top-up method (nothing to top up wallet credit WITH)", async () => {
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "10000",
          currency: "IDR",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          method: PaymentMethod.WALLET as any,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_invalid_method" });
  });

  it("rejects BINANCE_PAY (manual bot-only proof flow, not an auto-confirm top-up rail)", async () => {
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "10",
          currency: "USDT",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          method: PaymentMethod.BINANCE_PAY as any,
          rate: "16000",
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_invalid_method" });
  });
});

describe("settleWalletTopup", () => {
  async function makeIdrTopupOrder(amount: string = "20000") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount, currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
  }
  async function makeUsdtTopupOrder(amount: string = "10") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount,
        currency: "USDT",
        method: PaymentMethod.NOWPAYMENTS,
        rate: "16000",
      }),
    );
  }

  it("credits walletBalance for an IDR order; walletBalanceUsdt is untouched (currency isolation)", async () => {
    const order = await makeIdrTopupOrder("20000");
    const result = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.credited.equals(order.totalAmount)).toBe(true);

    const user = await freshUser();
    expect(new Decimal(user.walletBalance).equals(order.totalAmount)).toBe(true);
    expect(new Decimal(user.walletBalanceUsdt).equals(0)).toBe(true);
  });

  it("credits walletBalanceUsdt for a USDT order; walletBalance is untouched (currency isolation)", async () => {
    const order = await makeUsdtTopupOrder("10");
    const result = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.credited.equals(order.totalAmount)).toBe(true);

    const user = await freshUser();
    expect(new Decimal(user.walletBalanceUsdt).equals(order.totalAmount)).toBe(true);
    expect(new Decimal(user.walletBalance).equals(0)).toBe(true);
  });

  it("returns newBalance matching adjustWallet's post-credit balance (Task 7 — feeds the buyer DM payload)", async () => {
    const order = await makeIdrTopupOrder("20000");
    const result = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    expect(result.newBalance.equals(order.totalAmount)).toBe(true);
    const user = await freshUser();
    expect(new Decimal(user.walletBalance).equals(result.newBalance)).toBe(true);
  });

  it("on the no-op double-settlement path, newBalance reflects the buyer's current balance, not zero", async () => {
    const order = await makeIdrTopupOrder("20000");
    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const second = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    expect(second.credited.equals(0)).toBe(true);
    expect(second.newBalance.equals(order.totalAmount)).toBe(true); // unchanged balance, still surfaced correctly
  });

  it("writes a WalletTransaction row with reason wallet_topup, the order's currency, and orderId set", async () => {
    const order = await makeIdrTopupOrder("15000");
    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.reason).toBe("wallet_topup");
    expect(row.currency).toBe("IDR");
    expect(row.orderId).toBe(order.id);
    expect(new Decimal(row.delta).equals(order.totalAmount)).toBe(true);
  });

  it("called twice on the same order is a no-op the second time — adjustWallet's effect happens exactly once", async () => {
    const order = await makeIdrTopupOrder("20000");

    const first = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    expect(first.credited.equals(order.totalAmount)).toBe(true);

    const second = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    expect(second.order.status).toBe(OrderStatus.DELIVERED);
    expect(second.credited.equals(0)).toBe(true); // no-op signal, not a second credit

    // The real assertion: exactly ONE WalletTransaction ledger row for this
    // order, and the balance reflects exactly one credit, not two.
    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(1);

    const user = await freshUser();
    expect(new Decimal(user.walletBalance).equals(order.totalAmount)).toBe(true);
  });

  // Defense-in-depth guard (review finding, fix round 1): Task 3's six
  // gateway-settlement call sites are each expected to check
  // `order.kind === OrderKind.WALLET_TOPUP` before ever calling this
  // function, but settleWalletTopup must not rely on every future caller
  // getting that right — the failure mode (a PRODUCT order silently
  // DELIVERED + wallet-credited, skipping stock/referral/delivery) is a real
  // money+inventory bug.
  it("refuses to settle a PRODUCT-kind order even if it's PENDING_PAYMENT — wallet and status untouched", async () => {
    const productOrder = await prisma.order.create({
      data: {
        orderCode: "TEST-PRODUCT-ORDER",
        userId: sample.user.id,
        // kind defaults to PRODUCT — deliberately not overridden here.
        subtotalAmount: "10000",
        totalAmount: "10000",
        status: OrderStatus.PENDING_PAYMENT,
      },
    });
    expect(productOrder.kind).toBe("PRODUCT");

    await expect(
      prisma.$transaction((tx) => settleWalletTopup(tx, productOrder.id, { amount: "10000" })),
    ).rejects.toMatchObject({ key: "error.order_not_wallet_topup" });

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: productOrder.id } });
    expect(reloaded.status).toBe(OrderStatus.PENDING_PAYMENT); // unchanged — never claimed as DELIVERED

    const user = await freshUser();
    expect(new Decimal(user.walletBalance).equals(0)).toBe(true); // no credit applied
    expect(new Decimal(user.walletBalanceUsdt).equals(0)).toBe(true);
  });
});

describe("createWalletTopupOrder — payment window (Part B)", () => {
  /** Allow a couple of minutes of slack so a slow test box can't flake this. */
  function minutesFromNow(at: Date | null): number {
    if (!at) throw new Error("expiresAt was null");
    return (at.getTime() - Date.now()) / 60_000;
  }

  it("an IDR top-up gets an expiresAt, so the QRIS reconcile pollers can actually see it", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "50000",
        currency: "IDR",
        method: PaymentMethod.TOKOPAY,
      }),
    );
    expect(order.expiresAt).not.toBeNull();
    // Same window product IDR orders use — they pay through the very same two
    // gateways, so there is no reason for a top-up to get a different one.
    expect(minutesFromNow(order.expiresAt)).toBeGreaterThan(config.PAYMENT_WINDOW_MINUTES - 2);
    expect(minutesFromNow(order.expiresAt)).toBeLessThanOrEqual(config.PAYMENT_WINDOW_MINUTES);
  });

  it("a PayDisini IDR top-up gets the same window (the setting is per-currency, not per-gateway)", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "50000",
        currency: "IDR",
        method: PaymentMethod.PAYDISINI,
      }),
    );
    expect(order.expiresAt).not.toBeNull();
    expect(minutesFromNow(order.expiresAt)).toBeGreaterThan(config.PAYMENT_WINDOW_MINUTES - 2);
    expect(minutesFromNow(order.expiresAt)).toBeLessThanOrEqual(config.PAYMENT_WINDOW_MINUTES);
  });

  // Regression: the IDR window must not leak onto the USDT rails, each of
  // which finalizeWalletTopupPayment gives its own, deliberately different
  // auto-confirm window.
  it("a Binance Internal USDT top-up keeps its own per-rail window, not the IDR one", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "10",
        currency: "USDT",
        method: PaymentMethod.BINANCE_INTERNAL,
        rate: "16000",
      }),
    );
    expect(order.expiresAt).not.toBeNull();
    expect(minutesFromNow(order.expiresAt)).toBeGreaterThan(config.INTERNAL_PAYMENT_WINDOW_MINUTES - 2);
    expect(minutesFromNow(order.expiresAt)).toBeLessThanOrEqual(config.INTERNAL_PAYMENT_WINDOW_MINUTES);
  });

  it("a Bybit BSC USDT top-up keeps its own per-rail window too", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "10",
        currency: "USDT",
        method: PaymentMethod.BYBIT_BSC,
        rate: "16000",
      }),
    );
    expect(order.expiresAt).not.toBeNull();
    expect(minutesFromNow(order.expiresAt)).toBeGreaterThan(config.BYBIT_BSC_PAYMENT_WINDOW_MINUTES - 2);
    expect(minutesFromNow(order.expiresAt)).toBeLessThanOrEqual(config.BYBIT_BSC_PAYMENT_WINDOW_MINUTES);
  });
});

describe("settleWalletTopup — money that arrives after the payment window closed (Part A)", () => {
  /** Create a top-up, let its window lapse, and auto-cancel it exactly the way
   * `autoCancelExpiredOrders` does — the state a late-paying buyer's order is
   * really in by the time the gateway confirms. */
  async function makeExpiredCancelledTopup(args: { currency: "IDR" | "USDT"; amount: string }) {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(
        tx,
        args.currency === "IDR"
          ? { userId: sample.user.id, amount: args.amount, currency: "IDR", method: PaymentMethod.TOKOPAY }
          : {
              userId: sample.user.id,
              amount: args.amount,
              currency: "USDT",
              method: PaymentMethod.NOWPAYMENTS,
              rate: "16000",
            },
      ),
    );
    await prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await prisma.$transaction((tx) => cancelOrder(tx, order.id, "expired"));
    const cancelled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    return order;
  }

  it("credits an auto-cancelled IDR top-up whose payment lands late, and marks it DELIVERED", async () => {
    const order = await makeExpiredCancelledTopup({ currency: "IDR", amount: "20000" });

    const result = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    expect(result.credited.equals(order.totalAmount)).toBe(true);
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    const user = await freshUser();
    expect(new Decimal(user.walletBalance).equals(order.totalAmount)).toBe(true);

    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "wallet_topup" } });
    expect(rows).toHaveLength(1);
  });

  it("credits an auto-cancelled USDT top-up whose payment lands late (this rail has been losing money today)", async () => {
    const order = await makeExpiredCancelledTopup({ currency: "USDT", amount: "10" });

    const result = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    expect(result.credited.equals(order.totalAmount)).toBe(true);
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    const user = await freshUser();
    expect(new Decimal(user.walletBalanceUsdt).equals(order.totalAmount)).toBe(true);
    expect(new Decimal(user.walletBalance).equals(0)).toBe(true);
  });

  it("a revived top-up settled a second time is still a no-op — the anti-double-credit claim survives the relaxation", async () => {
    const order = await makeExpiredCancelledTopup({ currency: "IDR", amount: "20000" });

    const first = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    expect(first.credited.equals(order.totalAmount)).toBe(true);

    const second = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    expect(second.credited.equals(0)).toBe(true);
    expect(second.order.status).toBe(OrderStatus.DELIVERED);
    expect(second.newBalance.equals(order.totalAmount)).toBe(true);

    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "wallet_topup" } });
    expect(rows).toHaveLength(1);
  });

  it("still refuses a CANCELLED PRODUCT order — the relaxation is scoped to WALLET_TOPUP only", async () => {
    const productOrder = await prisma.order.create({
      data: {
        orderCode: "TEST-CANCELLED-PRODUCT",
        userId: sample.user.id,
        subtotalAmount: "10000",
        totalAmount: "10000",
        status: OrderStatus.CANCELLED,
      },
    });

    await expect(
      prisma.$transaction((tx) => settleWalletTopup(tx, productOrder.id, { amount: "10000" })),
    ).rejects.toMatchObject({ key: "error.order_not_wallet_topup" });

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: productOrder.id } });
    expect(reloaded.status).toBe(OrderStatus.CANCELLED);
    const user = await freshUser();
    expect(new Decimal(user.walletBalance).equals(0)).toBe(true);
  });

  it("a REJECTED top-up is not revived — only the auto-cancel path is forgiven", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "20000",
        currency: "IDR",
        method: PaymentMethod.TOKOPAY,
      }),
    );
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.REJECTED } });

    const result = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    expect(result.credited.equals(0)).toBe(true);
    expect(result.order.status).toBe(OrderStatus.REJECTED);

    const user = await freshUser();
    expect(new Decimal(user.walletBalance).equals(0)).toBe(true);
  });
});

describe("settleWalletTopup — owner wallet-topup email (Task T3)", () => {
  async function makeIdrTopupOrder(amount: string = "20000") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount, currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
  }
  async function makeUsdtTopupOrder(amount: string = "10") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount,
        currency: "USDT",
        method: PaymentMethod.NOWPAYMENTS,
        rate: "16000",
      }),
    );
  }

  const OWNER_EMAIL_SETTING_KEYS = [
    "owner_email_enabled",
    "owner_email",
    "owner_email_on_wallet_topup",
  ];

  async function configureOwnerEmail() {
    await setSetting(prisma, "owner_email_enabled", "true");
    await setSetting(prisma, "owner_email", "owner@example.com");
    await setSetting(prisma, "owner_email_on_wallet_topup", "true");
  }

  async function disableOwnerEmail() {
    for (const key of OWNER_EMAIL_SETTING_KEYS) await deleteSetting(prisma, key);
  }

  afterEach(async () => {
    await disableOwnerEmail();
  });

  it("enqueues OWNER_EMAIL_WALLET_TOPUP exactly once on a successful settlement, when configured", async () => {
    await configureOwnerEmail();
    const order = await makeIdrTopupOrder("20000");

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP, orderId: order.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("EMAIL");
  });

  it("does not enqueue anything on the no-op double-settlement path (claim.count !== 1) — anti-duplicate-email guard", async () => {
    await configureOwnerEmail();
    const order = await makeIdrTopupOrder("20000");

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    const afterFirst = await prisma.notificationOutbox.count({
      where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP, orderId: order.id },
    });
    expect(afterFirst).toBe(1);

    // Second call settles nothing (claim.count !== 1) — must not enqueue a
    // second email for an already-notified top-up.
    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    const afterSecond = await prisma.notificationOutbox.count({
      where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP, orderId: order.id },
    });
    expect(afterSecond).toBe(1);
  });

  it("a late-paid, auto-cancelled top-up enqueues exactly one owner email, and none on a repeat settlement", async () => {
    await configureOwnerEmail();
    const order = await makeIdrTopupOrder("20000");
    await prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await prisma.$transaction((tx) => cancelOrder(tx, order.id, "expired"));

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP, orderId: order.id },
    });
    expect(rows).toHaveLength(1);
  });

  it("stays completely inert (writes no outbox row at all) when the owner-email feature is unconfigured", async () => {
    await disableOwnerEmail();
    const order = await makeIdrTopupOrder("20000");

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP, orderId: order.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("stays inert when the master toggle is off even though the per-event toggle and address are set", async () => {
    await configureOwnerEmail();
    await setSetting(prisma, "owner_email_enabled", "false");
    const order = await makeIdrTopupOrder("20000");

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP, orderId: order.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("stays inert when owner_email is blank even though both toggles are on", async () => {
    await configureOwnerEmail();
    await setSetting(prisma, "owner_email", "");
    const order = await makeIdrTopupOrder("20000");

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP, orderId: order.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("payload carries amount, currency, new balance, and payment method — money as strings, not numbers (IDR)", async () => {
    await configureOwnerEmail();
    const order = await makeIdrTopupOrder("20000");

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const row = await prisma.notificationOutbox.findFirstOrThrow({
      where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP, orderId: order.id },
    });
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    expect(payload.to).toBe("owner@example.com");
    expect(payload.order_code).toBe(order.orderCode);
    expect(payload.currency).toBe("IDR");
    expect(payload.payment_method).toBe(PaymentMethod.TOKOPAY);
    expect(typeof payload.amount).toBe("string");
    expect(new Decimal(payload.amount as string).equals(order.totalAmount)).toBe(true);
    expect(typeof payload.new_balance).toBe("string");
    expect(new Decimal(payload.new_balance as string).equals(order.totalAmount)).toBe(true);
  });

  it("payload carries amount/currency/new balance correctly for a USDT top-up too", async () => {
    await configureOwnerEmail();
    const order = await makeUsdtTopupOrder("10");

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const row = await prisma.notificationOutbox.findFirstOrThrow({
      where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP, orderId: order.id },
    });
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    expect(payload.currency).toBe("USDT");
    expect(payload.payment_method).toBe(PaymentMethod.NOWPAYMENTS);
    expect(new Decimal(payload.amount as string).equals(order.totalAmount)).toBe(true);
    expect(new Decimal(payload.new_balance as string).equals(order.totalAmount)).toBe(true);
  });
});

// Task E1: settleWalletTopup is now the ONE call site for
// WALLET_TOPUP_CREDITED_DM (the buyer's "top-up successful" Telegram DM)
// across all six top-up rails — moved here, behind the atomic claim, from
// three separate per-rail call sites (TokoPay/PayDisini/NOWPayments enqueued
// it themselves; Binance Internal/Bybit/Bybit BSC DM'd the buyer directly
// from the bot process instead). Mirrors the owner-email coverage above,
// which pins the analogous guarantee for OWNER_EMAIL_WALLET_TOPUP.
describe("settleWalletTopup — buyer WALLET_TOPUP_CREDITED_DM (Task E1)", () => {
  async function makeIdrTopupOrder(amount: string = "20000") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount, currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
  }
  async function makeUsdtTopupOrder(amount: string = "10") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount,
        currency: "USDT",
        method: PaymentMethod.NOWPAYMENTS,
        rate: "16000",
      }),
    );
  }

  it("enqueues WALLET_TOPUP_CREDITED_DM exactly once on a successful settlement", async () => {
    const order = await makeIdrTopupOrder("20000");

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(rows).toHaveLength(1);
  });

  it("does not enqueue anything on the no-op double-settlement path (claim.count !== 1) — anti-duplicate-DM guard", async () => {
    const order = await makeIdrTopupOrder("20000");

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    const afterFirst = await prisma.notificationOutbox.count({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(afterFirst).toBe(1);

    // Second call settles nothing (claim.count !== 1) — must not enqueue a
    // second DM for an already-notified top-up.
    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    const afterSecond = await prisma.notificationOutbox.count({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(afterSecond).toBe(1);
  });

  it("a late-paid, auto-cancelled top-up enqueues exactly one DM, and none on a repeat settlement", async () => {
    const order = await makeIdrTopupOrder("20000");
    await prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await prisma.$transaction((tx) => cancelOrder(tx, order.id, "expired"));

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(rows).toHaveLength(1);
  });

  it("stays inert (no outbox row) when the buyer has no Telegram id — a web-only account", async () => {
    await prisma.user.update({ where: { id: sample.user.id }, data: { telegramId: null } });
    const order = await makeIdrTopupOrder("20000");

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("payload carries chat_id, order_code, amount, currency and new_balance — money as strings, not numbers (IDR)", async () => {
    const order = await makeIdrTopupOrder("20000");

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const row = await prisma.notificationOutbox.findFirstOrThrow({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    expect(payload.chat_id).toBe(Number(sample.user.telegramId));
    expect(payload.order_code).toBe(order.orderCode);
    expect(payload.currency).toBe("IDR");
    expect(typeof payload.amount).toBe("string");
    expect(new Decimal(payload.amount as string).equals(order.totalAmount)).toBe(true);
    expect(typeof payload.new_balance).toBe("string");
    expect(new Decimal(payload.new_balance as string).equals(order.totalAmount)).toBe(true);
  });

  it("payload carries amount/currency/new balance correctly for a USDT top-up too", async () => {
    const order = await makeUsdtTopupOrder("10");

    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const row = await prisma.notificationOutbox.findFirstOrThrow({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    expect(payload.currency).toBe("USDT");
    expect(new Decimal(payload.amount as string).equals(order.totalAmount)).toBe(true);
    expect(new Decimal(payload.new_balance as string).equals(order.totalAmount)).toBe(true);
  });
});

// A top-up whose buyer sent less than they asked to top up cannot simply be
// settled (that would credit the full requested amount, giving away the
// shortfall) and cannot be refunded (nothing was delivered, and the money the
// buyer sent is meant to become balance in the first place). This is the third
// resolution: cancel the order and hand the buyer exactly what arrived, as a
// manual admin adjustment.
describe("creditUnderpaidTopupAnyway", () => {
  const ADMIN_ID = 444;

  async function makeUsdtTopupOrder(
    amount: string,
    method: WalletTopupUsdtMethod = PaymentMethod.BINANCE_INTERNAL,
  ) {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount, currency: "USDT", method, rate: "16000" }),
    );
  }

  it("credits what the buyer actually sent, cancels the order, and logs it as an admin adjustment (Binance rail)", async () => {
    const order = await makeUsdtTopupOrder("10");
    expect(
      await markUnderpaid(prisma, { orderId: order.id, binanceTxId: "bin-topup-underpaid-1", amount: "6.5" }),
    ).toBe(true);

    const { credited, currency } = await creditUnderpaidTopupAnyway(prisma, { orderId: order.id, adminId: ADMIN_ID });

    // The amount received, NOT the 10 USDT the buyer asked to top up.
    expect(credited.toString()).toBe("6.5");
    expect(credited.lessThan(order.totalAmount)).toBe(true);
    // The currency travels back with it: the calling route writes the audit
    // line the shop admin reads, and "6.5" alone does not say which money.
    expect(currency).toBe("USDT");

    const resolved = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(resolved.status).toBe(OrderStatus.CANCELLED);

    const buyer = await freshUser();
    expect(new Decimal(buyer.walletBalanceUsdt).toString()).toBe("6.5");
    // Currency isolation: a USDT top-up must never touch the IDR balance.
    expect(new Decimal(buyer.walletBalance).equals(0)).toBe(true);

    const ledger = await prisma.walletTransaction.findMany({ where: { orderId: order.id } });
    expect(ledger).toHaveLength(1);
    // `admin_adjust`, deliberately: this is the manual "credit balance" admin
    // primitive, not a refund (`underpaid_refund`) and not a normal top-up
    // settlement (`wallet_topup`).
    expect(ledger[0]!.reason).toBe("admin_adjust");
    expect(ledger[0]!.currency).toBe("USDT");
    expect(ledger[0]!.adminId).toBe(ADMIN_ID);
    expect(new Decimal(ledger[0]!.delta).toString()).toBe("6.5");
    expect(ledger[0]!.note).toContain(order.orderCode);
  });

  // Bybit and Bybit BSC record their underpaid ledger row in a different table
  // than Binance Internal does; `findUnderpaidReceived` covers both, and this
  // pins that this call site reads through it rather than a Binance-only lookup.
  it("credits the received amount for a Bybit-flagged top-up too", async () => {
    const order = await makeUsdtTopupOrder("10", PaymentMethod.BYBIT);
    expect(
      await markUnderpaidBybit(prisma, { orderId: order.id, bybitTxId: "byb-topup-underpaid-1", amount: "4.25" }),
    ).toBe(true);

    const { credited } = await creditUnderpaidTopupAnyway(prisma, { orderId: order.id, adminId: ADMIN_ID });

    expect(credited.toString()).toBe("4.25");
    const buyer = await freshUser();
    expect(new Decimal(buyer.walletBalanceUsdt).toString()).toBe("4.25");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CANCELLED);
  });

  // End-to-end regression for the QRIS/IDR gap: the three IDR gateways flag an
  // order underpaid through the shared `markOrderUnderpaid`, with no
  // `order.kind` filter, so a wallet top-up reaches it exactly like a product
  // order does. Until `markOrderUnderpaid` wrote a structured ledger row, the
  // amount received survived only as `adminNote` free text, so this whole path
  // credited the buyer 0 and the money they really sent was lost. Driven
  // through the real `markOrderUnderpaid`, not a hand-inserted ledger row, so
  // the regression can only pass if the two halves stay wired together.
  it("credits the received amount for an IDR top-up flagged underpaid by a QRIS gateway", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "20000",
        currency: "IDR",
        method: PaymentMethod.TOKOPAY,
      }),
    );
    expect(
      await markOrderUnderpaid(prisma, {
        orderId: order.id,
        gateway: "TokoPay",
        receivedAmount: "18500",
        expectedAmount: order.totalAmount,
      }),
    ).toBe(true);

    const { credited, currency } = await creditUnderpaidTopupAnyway(prisma, { orderId: order.id, adminId: ADMIN_ID });

    expect(credited.toString()).toBe("18500");
    // An IDR rail returns IDR — the counterpart to the USDT case above, and
    // the reason a bare amount in the audit log is ambiguous at all.
    expect(currency).toBe("IDR");
    const buyer = await freshUser();
    expect(new Decimal(buyer.walletBalance).toString()).toBe("18500");
    // Currency isolation: an IDR top-up must never touch the USDT balance.
    expect(new Decimal(buyer.walletBalanceUsdt).equals(0)).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CANCELLED);

    const ledger = await prisma.walletTransaction.findMany({ where: { orderId: order.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.reason).toBe("admin_adjust");
    expect(ledger[0]!.currency).toBe("IDR");
    expect(new Decimal(ledger[0]!.delta).toString()).toBe("18500");
  });

  it("refuses a PRODUCT order even when it is UNDERPAID, and changes nothing", async () => {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    expect(
      await markUnderpaid(prisma, { orderId: order.id, binanceTxId: "bin-product-underpaid-1", amount: "3" }),
    ).toBe(true);

    await expect(creditUnderpaidTopupAnyway(prisma, { orderId: order.id, adminId: ADMIN_ID })).rejects.toMatchObject({
      key: "error.order_not_wallet_topup",
    });

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.UNDERPAID);
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id } })).toBe(0);
    const buyer = await freshUser();
    expect(new Decimal(buyer.walletBalance).equals(0)).toBe(true);
    expect(new Decimal(buyer.walletBalanceUsdt).equals(0)).toBe(true);
  });

  it("refuses a top-up that is still PENDING_PAYMENT, and changes nothing", async () => {
    const order = await makeUsdtTopupOrder("10");

    await expect(creditUnderpaidTopupAnyway(prisma, { orderId: order.id, adminId: ADMIN_ID })).rejects.toMatchObject({
      key: "error.order_not_underpaid",
    });

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("refuses a top-up that was already settled and DELIVERED, and credits nothing further", async () => {
    const order = await makeUsdtTopupOrder("10");
    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    const settledBalance = new Decimal((await freshUser()).walletBalanceUsdt);

    await expect(creditUnderpaidTopupAnyway(prisma, { orderId: order.id, adminId: ADMIN_ID })).rejects.toMatchObject({
      key: "error.order_not_underpaid",
    });

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.DELIVERED);
    expect(new Decimal((await freshUser()).walletBalanceUsdt).equals(settledBalance)).toBe(true);
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "admin_adjust" } })).toBe(0);
  });

  // The order's own status is the idempotency gate: the first call leaves it
  // CANCELLED, which no longer satisfies the UNDERPAID precondition. A
  // double-tapped admin button therefore cannot credit the buyer twice.
  it("cannot credit twice — a second call is refused because the order is no longer UNDERPAID", async () => {
    const order = await makeUsdtTopupOrder("10");
    expect(
      await markUnderpaid(prisma, { orderId: order.id, binanceTxId: "bin-topup-underpaid-2", amount: "6.5" }),
    ).toBe(true);

    await creditUnderpaidTopupAnyway(prisma, { orderId: order.id, adminId: ADMIN_ID });
    await expect(creditUnderpaidTopupAnyway(prisma, { orderId: order.id, adminId: ADMIN_ID })).rejects.toMatchObject({
      key: "error.order_not_underpaid",
    });

    expect(new Decimal((await freshUser()).walletBalanceUsdt).toString()).toBe("6.5");
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id } })).toBe(1);
  });

  // No rail recorded what arrived — every automated rail now writes a ledger
  // row, so this is an order somebody moved to UNDERPAID by hand. Cancel it,
  // but write no wallet movement: a 0-amount ledger row would claim money
  // moved when none did. Same gating as `refundUnderpaidOrder`.
  it("cancels the order but credits nothing when no rail recorded a received amount", async () => {
    const order = await makeUsdtTopupOrder("10");
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.UNDERPAID } });

    const { credited } = await creditUnderpaidTopupAnyway(prisma, { orderId: order.id, adminId: ADMIN_ID });

    expect(credited.toString()).toBe("0");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CANCELLED);
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id } })).toBe(0);
    const buyer = await freshUser();
    expect(new Decimal(buyer.walletBalanceUsdt).equals(0)).toBe(true);
  });

  it("refuses an order id that does not exist", async () => {
    await expect(creditUnderpaidTopupAnyway(prisma, { orderId: 999_999, adminId: ADMIN_ID })).rejects.toMatchObject({
      key: "error.order_not_found",
    });
  });
});
