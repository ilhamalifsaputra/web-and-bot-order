/**
 * Regression tests for the Bybit unique-cents pick in a USDT wallet top-up
 * (`finalizeWalletTopupPayment`, reached through `createWalletTopupOrder`).
 *
 * A top-up and a product order on the same Bybit rail share ONE pending-amount
 * pool: the poller matches a memo-less deposit by amount alone, whatever the
 * order's kind. The top-up path ran its own copy of the clash search with no
 * lock, so two top-ups (or a top-up and a product checkout) finalizing at once
 * could both see "no clash" and both take the same total, and once all 49
 * buckets were taken it silently kept a colliding amount. Both paths now share
 * `writeWithUniqueRailAmount` (./pricing.ts) and its per-rail advisory lock.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { config } from "@app/core/config";
import { PaymentMethod, OrderStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { usdtFromIdr, computeUniqueCents } from "@app/core/formatters";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { addToCart, createOrderFromCart, bulkAddStock } from "@app/db";
import { __clearSettingsCacheForTests } from "./settings";
import { finalizeOrderPayment, setFxRateFetcher } from "./pricing";
import { createWalletTopupOrder } from "./wallet_topup";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let originalUniqueCents: boolean;
const rate = new Decimal("16000");
/** The top-up amount, and the USDT figure the product below converts to. */
const TOPUP_USDT = new Decimal("10");

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
  originalUniqueCents = config.USE_UNIQUE_CENTS;
  config.USE_UNIQUE_CENTS = true;
  await Promise.all(Array.from({ length: 4 }, () => prisma.$queryRaw`SELECT 1 AS ok FROM pg_sleep(0.05)`));
});
afterAll(async () => {
  config.USE_UNIQUE_CENTS = originalUniqueCents;
  await db.cleanup();
});
beforeEach(async () => {
  __clearSettingsCacheForTests(prisma);
  await prisma.setting.deleteMany();
  setFxRateFetcher(async () => new Decimal("16243.7"));
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  // 160000 / 16000 = exactly 10 USDT, the same base as the top-ups below.
  await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "160000" } });
  await bulkAddStock(prisma, sample.product.id, Array.from({ length: 12 }, (_, i) => `wt-uc-cred-${i}`));
});

function topup() {
  return createWalletTopupOrder(prisma, {
    userId: sample.user.id,
    amount: TOPUP_USDT,
    currency: "USDT",
    method: PaymentMethod.BYBIT,
    rate,
  });
}

async function makeProductOrder() {
  await addToCart(prisma, sample.user.id, sample.product.id, 1);
  return (await createOrderFromCart(prisma, { channel: "bot", user: sample.user }))!;
}

/** Occupy the given cents buckets for `base` in the pending Bybit pool. */
async function occupy(base: Decimal, seeds: number[]) {
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await prisma.order.createMany({
    data: seeds.map((seed) => ({
      orderCode: `ORD-FILL-${seed}-${Math.random()}`,
      userId: sample.user.id,
      subtotalAmount: "1",
      totalAmount: base.plus(computeUniqueCents(seed)),
      currency: "USDT",
      paymentMethod: PaymentMethod.BYBIT,
      status: OrderStatus.PENDING_PAYMENT,
      expiresAt,
    })),
  });
}

async function nextOrderId(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ id: number | null }[]>(`SELECT MAX(id) AS id FROM orders`);
  return (rows[0]?.id ?? 0) + 1;
}

function expectDistinctTotals(results: PromiseSettledResult<{ totalAmount: unknown } | null>[]) {
  const totals = results.map((r) => {
    expect(r.status).toBe("fulfilled");
    return new Decimal((r as PromiseFulfilledResult<{ totalAmount: unknown }>).value.totalAmount as Decimal.Value);
  });
  expect(totals[0]!.equals(totals[1]!)).toBe(false);
}

describe("createWalletTopupOrder (USDT, Bybit) — unique cents under concurrency", () => {
  it("two top-ups of the same amount finalized at once never get the same total", async () => {
    for (let round = 0; round < 5; round++) {
      // The two top-ups get ids t and t+1. Occupying buckets t..t+16 makes the
      // one with id t walk t -> t+1 -> ... -> t+17 and the one with id t+1 walk
      // t+1 -> ... -> t+17: without serialization both land on t+17.
      // `createMany` consumes ids, so t is picked past them and pinned after.
      const t = (await nextOrderId()) + 100;
      await occupy(TOPUP_USDT, Array.from({ length: 17 }, (_, k) => t + k));
      await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('orders', 'id'), ${t - 1})`);

      const results = await Promise.allSettled([topup(), topup()]);
      expectDistinctTotals(results);
      await prisma.order.deleteMany({ where: { orderCode: { startsWith: "ORD-FILL-" } } });
    }
  });

  it("a top-up and a product checkout on the same rail and base never get the same total", async () => {
    for (let round = 0; round < 5; round++) {
      const product = await makeProductOrder();
      // Put the top-up's id in the product order's cents bucket (+49), so both
      // start from — and walk through — the same buckets.
      // `createMany` consumes ids too, so pin the sequence after filling.
      await occupy(
        usdtFromIdr(new Decimal(160000), rate),
        Array.from({ length: 17 }, (_, k) => product.id + k),
      );
      await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('orders', 'id'), ${product.id + 48})`);

      const results = await Promise.allSettled([
        finalizeOrderPayment(prisma, product.id, { currency: "USDT", rate, method: PaymentMethod.BYBIT }),
        topup(),
      ]);
      const settled = results[1];
      if (settled.status === "fulfilled") expect(settled.value.id).toBe(product.id + 49);
      expectDistinctTotals(results);
      await prisma.order.deleteMany({ where: { orderCode: { startsWith: "ORD-FILL-" } } });
    }
  });

  it("refuses explicitly once every cents bucket for the amount is taken, instead of reusing one", async () => {
    await occupy(TOPUP_USDT, Array.from({ length: 49 }, (_, k) => k));

    const attempt = topup();
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toMatchObject({ key: "error.unique_amount_exhausted" });

    // No top-up row in the pool now shares an amount with another.
    const pool = await prisma.order.findMany({
      where: { paymentMethod: PaymentMethod.BYBIT, status: OrderStatus.PENDING_PAYMENT },
      select: { totalAmount: true },
    });
    const distinct = new Set(pool.map((o) => new Decimal(o.totalAmount).toString()));
    expect(distinct.size).toBe(pool.length);
    // The bare top-up row createWalletTopupOrder made (committed on its own here,
    // with no caller transaction) is left un-finalized: no Bybit method stamped,
    // so it never enters the matcher's pool.
    const topups = await prisma.order.findMany({ where: { kind: "WALLET_TOPUP" } });
    expect(topups.every((o) => o.paymentMethod !== PaymentMethod.BYBIT)).toBe(true);
  });
});
