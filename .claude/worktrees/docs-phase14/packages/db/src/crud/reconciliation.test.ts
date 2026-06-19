/**
 * Port of tests/test_reconciliation.py — reconcileFinances drift detection
 * across orders, vouchers, and wallet balances. The job is detect-only, so we
 * verify it *finds* the drift we inject, not that it fixes it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { reconcileFinances, createOrderDirect } from "@app/db";
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
  sample = await buildSampleData(prisma);
});

describe("reconcileFinances", () => {
  it("pristine sample data → no drift", async () => {
    const findings = await reconcileFinances(prisma);
    expect(findings).toEqual({
      order_drift: [],
      voucher_drift: [],
      negative_wallets: [],
    });
  });

  it("catches order total drift", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, {
      user,
      productId: product.id,
      quantity: 2,
    }))!;

    // Tamper with the stored total.
    await prisma.order.update({
      where: { id: order.id },
      data: { totalAmount: new Decimal(order.totalAmount).plus("99.0000").toString() },
    });

    const findings = await reconcileFinances(prisma);
    expect(findings.order_drift.length).toBe(1);
    expect(findings.order_drift[0]!.order_id).toBe(order.id);
  });

  it("catches voucher usage drift", async () => {
    const { voucher } = sample;
    // No orders reference it, but bump used_count to fake history.
    await prisma.voucher.update({ where: { id: voucher.id }, data: { usedCount: 5 } });

    const findings = await reconcileFinances(prisma);
    expect(findings.voucher_drift.length).toBe(1);
    expect(findings.voucher_drift[0]!.voucher_id).toBe(voucher.id);
    expect(findings.voucher_drift[0]!.recorded_used).toBe(5);
    expect(findings.voucher_drift[0]!.actual_orders).toBe(0);
  });

  it("catches negative wallet balance", async () => {
    const { user } = sample;
    await prisma.user.update({ where: { id: user.id }, data: { walletBalance: "-1.0000" } });

    const findings = await reconcileFinances(prisma);
    expect(findings.negative_wallets.length).toBe(1);
    expect(findings.negative_wallets[0]!.user_id).toBe(user.id);
  });
});
