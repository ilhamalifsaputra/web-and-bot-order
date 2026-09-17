import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { config } from "@app/core/config";
import { PaymentMethod } from "@app/core/enums";
import { usdtFromIdr, computeUniqueCents } from "@app/core/formatters";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { addToCart, createOrderFromCart } from "@app/db";
import { getSetting, setSetting, __clearSettingsCacheForTests } from "./settings";
import {
  refreshUsdIdrRate,
  setFxRateFetcher,
  finalizeOrderPayment,
  setUsdIdrRate,
  USD_IDR_RATE_KEY,
  USD_IDR_RATE_AUTO_KEY,
  USD_IDR_RATE_ROUNDING_KEY,
  USD_IDR_RATE_UPDATED_AT_KEY,
  FX_QUOTE_TTL_MINUTES_KEY,
  DEFAULT_FX_QUOTE_TTL_MINUTES,
} from "./pricing";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  __clearSettingsCacheForTests(prisma);
  await prisma.setting.deleteMany();
  setFxRateFetcher(async () => new Decimal("16243.7"));
});

describe("refreshUsdIdrRate (market rate + rounding — plan.md §15.8)", () => {
  it("saves the market rate rounded to the default Rp100 step", async () => {
    const r = await refreshUsdIdrRate(prisma);
    expect(r.status).toBe("updated");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16200");
  });

  it("honors a custom rounding step", async () => {
    await setSetting(prisma, USD_IDR_RATE_ROUNDING_KEY, "500");
    await refreshUsdIdrRate(prisma);
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16000"); // nearest 500
  });

  it("reports unchanged when the rounded rate already matches", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16200");
    const r = await refreshUsdIdrRate(prisma);
    expect(r.status).toBe("unchanged");
  });

  it("auto switch: 'false' disables the scheduled path, force overrides it", async () => {
    await setSetting(prisma, USD_IDR_RATE_AUTO_KEY, "false");
    expect((await refreshUsdIdrRate(prisma)).status).toBe("disabled");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBeNull(); // untouched
    expect((await refreshUsdIdrRate(prisma, { force: true })).status).toBe("updated");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16200");
  });

  it("a failing fetch throws and leaves the saved rate alone", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
    setFxRateFetcher(async () => {
      throw new Error("network down");
    });
    await expect(refreshUsdIdrRate(prisma, { force: true })).rejects.toThrow();
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16000");
  });
});

// ---- M12 / audit P0-2: how fresh is the shop's own rate? --------------------

describe("usd_idr_rate_updated_at — when the rate's freshness is re-stamped", () => {
  it("setUsdIdrRate writes the value and its freshness stamp together", async () => {
    const before = Date.now();
    await setUsdIdrRate(prisma, new Decimal("16500"));
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16500");
    const stamp = await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY);
    expect(stamp).toBeTruthy();
    expect(Date.parse(stamp!)).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("an 'updated' refresh stamps the rate as freshly confirmed", async () => {
    const before = Date.now();
    expect((await refreshUsdIdrRate(prisma)).status).toBe("updated");
    const stamp = await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY);
    expect(stamp).toBeTruthy();
    expect(Date.parse(stamp!)).toBeGreaterThanOrEqual(before - 1_000);
  });

  // An "unchanged" outcome is a real re-confirmation against the market — the
  // rate was fetched and compared, it simply had not moved — so it refreshes
  // the freshness claim exactly like a changed value does.
  it("an 'unchanged' refresh re-stamps freshness even though the number did not move", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16200");
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, new Date(Date.now() - 86_400_000).toISOString());
    const before = Date.now();
    expect((await refreshUsdIdrRate(prisma)).status).toBe("unchanged");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16200"); // value untouched
    expect(Date.parse((await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY))!)).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("a 'disabled' refresh checks nothing, so it claims no freshness", async () => {
    await setSetting(prisma, USD_IDR_RATE_AUTO_KEY, "false");
    const stale = new Date(Date.now() - 86_400_000).toISOString();
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, stale);
    expect((await refreshUsdIdrRate(prisma)).status).toBe("disabled");
    expect(await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY)).toBe(stale);
  });

  it("a failing fetch leaves both the rate and its freshness stamp alone", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
    const stale = new Date(Date.now() - 86_400_000).toISOString();
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, stale);
    setFxRateFetcher(async () => {
      throw new Error("network down");
    });
    await expect(refreshUsdIdrRate(prisma, { force: true })).rejects.toThrow();
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16000");
    expect(await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY)).toBe(stale);
  });
});

/**
 * M12 / audit P0-2 — the FX quote TTL.
 *
 * Same contract as M11's rail-minimum guard right beside it in
 * `finalizeOrderPayment`: a rejected order must come back exactly as its
 * creator left it, so every rejection case re-reads the row and compares it
 * field by field against the snapshot taken before the call.
 */
describe("finalizeOrderPayment — refuses to convert at a rate nobody has confirmed lately", () => {
  let sample: SampleData;
  let orderId: number;

  /** Every field finalizeOrderPayment is capable of writing. */
  async function paymentFieldsOf(id: number) {
    const o = await prisma.order.findUniqueOrThrow({ where: { id } });
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

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
    // Same reason as the sibling describes above: the fixture SKU's Rp5 would
    // convert to 0.0 USDT and trip M11's guard before this one is reached.
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "80000" } });
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const created = await createOrderFromCart(prisma, { user: sample.user });
    orderId = created!.id;
  });

  it("rejects a quote older than the default TTL and leaves the order row untouched", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(Number(DEFAULT_FX_QUOTE_TTL_MINUTES) + 5));
    const before = await paymentFieldsOf(orderId);
    await expect(
      finalizeOrderPayment(prisma, orderId, { currency: "USDT", rate: "16000" }),
    ).rejects.toMatchObject({ key: "error.fx_quote_expired" });
    expect(await paymentFieldsOf(orderId)).toEqual(before);
  });

  it("honors a custom fx_quote_ttl_minutes", async () => {
    await setSetting(prisma, FX_QUOTE_TTL_MINUTES_KEY, "10");
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(30));
    const before = await paymentFieldsOf(orderId);
    await expect(
      finalizeOrderPayment(prisma, orderId, { currency: "USDT", rate: "16000" }),
    ).rejects.toMatchObject({ key: "error.fx_quote_expired" });
    expect(await paymentFieldsOf(orderId)).toEqual(before);

    // …and the same age passes once the TTL is widened past it.
    await setSetting(prisma, FX_QUOTE_TTL_MINUTES_KEY, "120");
    const order = await finalizeOrderPayment(prisma, orderId, { currency: "USDT", rate: "16000" });
    expect(order!.currency).toBe("USDT");
  });

  it("accepts a quote inside the TTL", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(5));
    const order = await finalizeOrderPayment(prisma, orderId, { currency: "USDT", rate: "16000" });
    expect(order!.currency).toBe("USDT");
    expect(new Decimal(order!.fxRate!).equals(16000)).toBe(true);
  });

  // The deliberate grace path: a shop that has not written the stamp yet has an
  // UNKNOWN freshness, not a stale one, and must not be refused.
  it("accepts when the freshness stamp has never been written", async () => {
    expect(await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY)).toBeNull();
    const order = await finalizeOrderPayment(prisma, orderId, { currency: "USDT", rate: "16000" });
    expect(order!.currency).toBe("USDT");
  });

  it("accepts when the stamp is unreadable — an unparseable value is still not proof of staleness", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, "not a timestamp");
    const order = await finalizeOrderPayment(prisma, orderId, { currency: "USDT", rate: "16000" });
    expect(order!.currency).toBe("USDT");
  });

  it("a blank or non-positive fx_quote_ttl_minutes turns the check off rather than expiring everything", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(60 * 24 * 30));
    for (const ttl of ["", "0", "-5", "abc"]) {
      await setSetting(prisma, FX_QUOTE_TTL_MINUTES_KEY, ttl);
      await addToCart(prisma, sample.user.id, sample.product.id, 1);
      const fresh = (await createOrderFromCart(prisma, { user: sample.user }))!;
      const order = await finalizeOrderPayment(prisma, fresh.id, { currency: "USDT", rate: "16000" });
      expect(order!.currency, `ttl ${JSON.stringify(ttl)} should disable the check`).toBe("USDT");
    }
  });

  // The IDR rail derives nothing from the exchange rate, so a stale quote is
  // none of its business.
  it("never blocks an IDR order, however stale the rate is", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(60 * 24 * 30));
    const order = await finalizeOrderPayment(prisma, orderId, { currency: "IDR" });
    expect(order!.currency).toBe("IDR");
  });
});

describe("finalizeOrderPayment — PaymentChoice widening (PAYDISINI/NOWPAYMENTS)", () => {
  let sample: SampleData;
  let orderId: number;

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
    // M11: the fixture SKU costs Rp5, which converts to 0.0 USDT at the 16000
    // rate these cases use — and finalizeOrderPayment now refuses to put a
    // nothing-to-collect total on a gateway. Price it realistically; every
    // assertion below is about which fields get stamped, not about the amount.
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "80000" } });
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const created = await createOrderFromCart(prisma, { user: sample.user });
    orderId = created!.id;
  });

  it("regression: IDR with no method still stamps TOKOPAY (existing callers unaffected)", async () => {
    const order = await finalizeOrderPayment(prisma, orderId, { currency: "IDR" });
    expect(order!.paymentMethod).toBe(PaymentMethod.TOKOPAY);
    expect(new Decimal(order!.uniqueCents).equals(0)).toBe(true);
  });

  it("IDR + method: PAYDISINI stamps PAYDISINI with unique cents stripped", async () => {
    const order = await finalizeOrderPayment(prisma, orderId, {
      currency: "IDR",
      method: PaymentMethod.PAYDISINI,
    });
    expect(order!.paymentMethod).toBe(PaymentMethod.PAYDISINI);
    expect(new Decimal(order!.uniqueCents).equals(0)).toBe(true);
  });

  it("USDT + method: NOWPAYMENTS stamps NOWPAYMENTS, sets the NOWPayments window, no paymentRef", async () => {
    const before = Date.now();
    const order = await finalizeOrderPayment(prisma, orderId, {
      currency: "USDT",
      rate: "16000",
      method: PaymentMethod.NOWPAYMENTS,
    });
    expect(order!.paymentMethod).toBe(PaymentMethod.NOWPAYMENTS);
    expect(order!.paymentRef).toBeNull();
    expect(order!.expiresAt).not.toBeNull();
    const expectedMs =
      before + config.NOWPAYMENTS_PAYMENT_WINDOW_MINUTES * 60_000;
    const actualMs = order!.expiresAt!.getTime();
    // Allow a small skew for test execution time between `before` and the call.
    expect(Math.abs(actualMs - expectedMs)).toBeLessThan(5_000);
  });
});

describe("finalizeOrderPayment — WALLET method never attaches unique cents", () => {
  let sample: SampleData;
  let orderId: number;

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const created = await createOrderFromCart(prisma, { user: sample.user });
    orderId = created!.id;
  });

  it("IDR + method: WALLET strips unique cents (same as the no-method default)", async () => {
    const order = await finalizeOrderPayment(prisma, orderId, {
      currency: "IDR",
      method: PaymentMethod.WALLET,
    });
    expect(order!.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(new Decimal(order!.uniqueCents).equals(0)).toBe(true);
  });

  it("USDT + method: WALLET stays at exactly the converted total even with USE_UNIQUE_CENTS on", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    try {
      const order = await finalizeOrderPayment(prisma, orderId, {
        currency: "USDT",
        rate: "16000",
        method: PaymentMethod.WALLET,
      });
      expect(order!.paymentMethod).toBe(PaymentMethod.WALLET);
      expect(new Decimal(order!.uniqueCents).equals(0)).toBe(true);
      expect(new Decimal(order!.totalAmount).equals(usdtFromIdr(new Decimal("5.00"), "16000"))).toBe(true);
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
  });
});

// Checkout-4's collision-avoidance generalized from a BYBIT-only literal to
// `paymentMethod: method` so it covers BYBIT_BSC too. These prove the pool
// scoping is genuinely per-method: a same-amount pending order under the
// OTHER Bybit rail must never be treated as a collision, while one under the
// SAME rail still is.
describe("finalizeOrderPayment — BYBIT vs BYBIT_BSC collision-avoidance is scoped per method", () => {
  let sample: SampleData;

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
    // M11: see the sibling describe above — Rp5 converts to 0.0 USDT at this
    // rate, which finalizeOrderPayment now refuses. The collision-avoidance
    // behaviour under test is unaffected by the size of the amount.
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "80000" } });
  });

  async function makeOrder() {
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    return (await createOrderFromCart(prisma, { user: sample.user }))!;
  }

  /** What finalizeOrderPayment computes on its FIRST attempt, before any
   * collision-avoidance retry — matches its own baseIdr/usdt/cents math. */
  function firstAttemptTotal(order: { totalAmount: Decimal.Value; uniqueCents: Decimal.Value; id: number }, rate: Decimal.Value) {
    const baseIdr = new Decimal(order.totalAmount).minus(order.uniqueCents);
    return usdtFromIdr(baseIdr, rate).plus(computeUniqueCents(order.id));
  }

  it("a same-amount pending order under the OTHER Bybit method never triggers a bump", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    try {
      const target = await makeOrder();
      const rate = new Decimal("16000");
      const expectedTotal = firstAttemptTotal(target, rate);

      // Seed a PENDING, not-expired BYBIT order with the EXACT amount
      // BYBIT_BSC's first attempt will compute — without per-method scoping
      // this would force target's totalAmount to bump away from it.
      const decoy = await makeOrder();
      await prisma.order.update({
        where: { id: decoy.id },
        data: { paymentMethod: PaymentMethod.BYBIT, currency: "USDT", totalAmount: expectedTotal, expiresAt: new Date(Date.now() + 60_000) },
      });

      const finalized = await finalizeOrderPayment(prisma, target.id, { currency: "USDT", rate, method: PaymentMethod.BYBIT_BSC });
      expect(new Decimal(finalized!.totalAmount).equals(expectedTotal)).toBe(true);
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
  });

  it("control: a same-amount pending order under the SAME method does trigger a bump", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    try {
      const target = await makeOrder();
      const rate = new Decimal("16000");
      const expectedTotal = firstAttemptTotal(target, rate);

      const decoy = await makeOrder();
      await prisma.order.update({
        where: { id: decoy.id },
        data: { paymentMethod: PaymentMethod.BYBIT_BSC, currency: "USDT", totalAmount: expectedTotal, expiresAt: new Date(Date.now() + 60_000) },
      });

      const finalized = await finalizeOrderPayment(prisma, target.id, { currency: "USDT", rate, method: PaymentMethod.BYBIT_BSC });
      expect(new Decimal(finalized!.totalAmount).equals(expectedTotal)).toBe(false);
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
  });
});
