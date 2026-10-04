/**
 * Regression tests for the Bybit unique-cents collision avoidance in
 * `finalizeOrderPayment` (./pricing.ts).
 *
 * Neither Bybit rail carries a memo, so the payable amount is the only thing
 * the poller matches a deposit on. The function searched the pending pool for
 * another order with the same total and then wrote its own — a read-then-write
 * with nothing serializing it, so two checkouts finalizing at the same instant
 * for the same base amount could both see "no clash" and both take the same
 * total (one deposit would then be ambiguous between two orders). And once
 * all 49 cents buckets were taken it silently kept a colliding amount.
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

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let originalUniqueCents: boolean;
const rate = new Decimal("16000");

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
  // Large enough to clear the rail minimum once converted to USDT.
  await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "80000" } });
  // Ten orders across the rounds below; each reserves one stock row.
  await bulkAddStock(prisma, sample.product.id, Array.from({ length: 12 }, (_, i) => `uc-cred-${i}`));
});

async function makeOrder() {
  await addToCart(prisma, sample.user.id, sample.product.id, 1);
  return (await createOrderFromCart(prisma, { channel: "bot", user: sample.user }))!;
}

describe("finalizeOrderPayment — Bybit unique cents under concurrency", () => {
  it("two orders whose ids share a cents bucket, finalized at the same instant, never get the same total", async () => {
    // Several rounds: a single race can lose the interleaving by luck, but
    // every round must come out distinct.
    for (let round = 0; round < 5; round++) {
      const a = await makeOrder();
      // Push the id sequence so the next order's id is a.id + 49 — the same
      // computeUniqueCents bucket, i.e. the same first-attempt total.
      await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('orders', 'id'), ${a.id + 48})`);
      const b = await makeOrder();
      expect(b.id).toBe(a.id + 49);
      expect(computeUniqueCents(a.id).equals(computeUniqueCents(b.id))).toBe(true);

      const [fa, fb] = await Promise.all([
        finalizeOrderPayment(prisma, a.id, { currency: "USDT", rate, method: PaymentMethod.BYBIT }),
        finalizeOrderPayment(prisma, b.id, { currency: "USDT", rate, method: PaymentMethod.BYBIT }),
      ]);
      expect(new Decimal(fa!.totalAmount).equals(new Decimal(fb!.totalAmount))).toBe(false);
    }
  });

  it("refuses explicitly once every cents bucket for the amount is taken, instead of reusing one", async () => {
    const target = await makeOrder();
    const baseIdr = new Decimal(target.totalAmount).minus(target.uniqueCents);
    const usdt = usdtFromIdr(baseIdr, rate);
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    // Occupy all 49 buckets in the same pending pool the matcher reads.
    await prisma.order.createMany({
      data: Array.from({ length: 49 }, (_, k) => ({
        orderCode: `ORD-FILL-${k}-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "1",
        totalAmount: usdt.plus(computeUniqueCents(k)),
        currency: "USDT",
        paymentMethod: PaymentMethod.BYBIT,
        status: OrderStatus.PENDING_PAYMENT,
        expiresAt,
      })),
    });

    const attempt = finalizeOrderPayment(prisma, target.id, { currency: "USDT", rate, method: PaymentMethod.BYBIT });
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(
      finalizeOrderPayment(prisma, target.id, { currency: "USDT", rate, method: PaymentMethod.BYBIT }),
    ).rejects.toMatchObject({ key: "error.unique_amount_exhausted" });
    // Nothing was written: the order is still exactly as its creator left it.
    const after = await prisma.order.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.paymentMethod).toBe(target.paymentMethod);
    expect(new Decimal(after.totalAmount).equals(new Decimal(target.totalAmount))).toBe(true);
  });
});
