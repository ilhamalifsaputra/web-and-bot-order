/**
 * Port of tests/test_reconciliation.py — reconcileFinances drift detection
 * across orders, vouchers, and wallet balances. The job is detect-only, so we
 * verify it *finds* the drift we inject, not that it fixes it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  reconcileFinances,
  createOrderDirect,
  createVoucher,
  upsertUser,
  finalizeOrderPayment,
  applyUsdtWalletToOrder,
} from "@app/db";
import { Decimal } from "@app/core/money";
import { VoucherType, OrderCurrency, PaymentMethod } from "@app/core/enums";

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

  // Reproduces the real-world "orders: 3" false positive from prod (order
  // #182, ORD-20260705-LUYV): a USDT order fully paid via applyUsdtWalletToOrder
  // — walletUsed is USDT-denominated (subtracted from the ALREADY-converted
  // totalAmount, orders.ts applyUsdtWalletToOrder), not IDR-denominated
  // subtracted before conversion like the cart/direct-order wallet paths.
  it("USDT order fully paid via USDT wallet credit → no false drift", async () => {
    const { user, product } = sample;
    const created = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
    // Sample product price ("5.00") is too small to survive USDT rounding —
    // bump the order to prod-realistic numbers (order #182 was 28000 IDR).
    await prisma.order.update({
      where: { id: created.id },
      data: { subtotalAmount: "28000", totalAmount: "28000" },
    });
    const rate = new Decimal("18000");
    await finalizeOrderPayment(prisma, created.id, {
      currency: OrderCurrency.USDT,
      rate,
      method: PaymentMethod.NOWPAYMENTS,
    });
    const afterFinalize = await prisma.order.findUniqueOrThrow({ where: { id: created.id } });

    // Give the user exactly enough USDT wallet credit to cover the converted total.
    await prisma.user.update({
      where: { id: user.id },
      data: { walletBalanceUsdt: afterFinalize.totalAmount },
    });
    await applyUsdtWalletToOrder(prisma, created.id, afterFinalize.totalAmount);

    const findings = await reconcileFinances(prisma);
    expect(findings.order_drift).toEqual([]);
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

  it("counts real orders per voucher independently (groupBy refactor, not conflated across vouchers)", async () => {
    const { user, product, voucher } = sample;
    const other = await createVoucher(prisma, {
      code: "SAVE20",
      type: VoucherType.PERCENT,
      value: "20",
      usageLimit: 100,
      minPurchase: "3",
    });
    // A voucher can only be redeemed once per user, so use a second user for
    // the second SAVE10 order.
    const user2 = await upsertUser(prisma, { telegramId: 9301, username: "voucher_user2", fullName: null });

    // `voucher` (SAVE10) gets 2 real non-cancelled orders; `other` (SAVE20) gets 1.
    await createOrderDirect(prisma, { user, productId: product.id, quantity: 1, voucherCode: voucher.code });
    await createOrderDirect(prisma, { user: user2, productId: product.id, quantity: 1, voucherCode: voucher.code });
    await createOrderDirect(prisma, { user, productId: product.id, quantity: 1, voucherCode: other.code });

    // Fake recorded usedCount drift on both so both show up in findings.
    await prisma.voucher.update({ where: { id: voucher.id }, data: { usedCount: 99 } });
    await prisma.voucher.update({ where: { id: other.id }, data: { usedCount: 99 } });

    const findings = await reconcileFinances(prisma);
    const byId = new Map(findings.voucher_drift.map((d) => [d.voucher_id, d]));
    expect(byId.get(voucher.id)?.actual_orders).toBe(2);
    expect(byId.get(other.id)?.actual_orders).toBe(1);
  });

  it("catches negative wallet balance", async () => {
    const { user } = sample;
    await prisma.user.update({ where: { id: user.id }, data: { walletBalance: "-1.0000" } });

    const findings = await reconcileFinances(prisma);
    expect(findings.negative_wallets.length).toBe(1);
    expect(findings.negative_wallets[0]!.user_id).toBe(user.id);
  });
});
