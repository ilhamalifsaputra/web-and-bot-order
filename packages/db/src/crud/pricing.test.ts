import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { config } from "@app/core/config";
import { PaymentMethod } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { addToCart, createOrderFromCart } from "@app/db";
import { getSetting, setSetting } from "./settings";
import {
  refreshUsdIdrRate,
  setFxRateFetcher,
  finalizeOrderPayment,
  USD_IDR_RATE_KEY,
  USD_IDR_RATE_AUTO_KEY,
  USD_IDR_RATE_ROUNDING_KEY,
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

describe("finalizeOrderPayment — PaymentChoice widening (PAYDISINI/NOWPAYMENTS)", () => {
  let sample: SampleData;
  let orderId: number;

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
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
