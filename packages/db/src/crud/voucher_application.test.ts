/**
 * Port of tests/test_voucher_application.py — the pure
 * `applyVoucherToSubtotal` helper plus the full path through
 * `createOrderFromCart` with a voucher attached.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  applyVoucherToSubtotal,
  createVoucher,
  addToCart,
  createOrderFromCart,
} from "@app/db";
import { VoucherType } from "@app/core/enums";
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

describe("applyVoucherToSubtotal (pure)", () => {
  it("percent voucher: 10% off 20 = 2", () => {
    const discount = applyVoucherToSubtotal(sample.voucher, "20.00");
    expect(discount.equals("2.0000")).toBe(true);
  });

  it("fixed voucher larger than subtotal is capped at the subtotal", async () => {
    const v = await createVoucher(prisma, {
      code: "BIG",
      type: VoucherType.FIXED,
      value: "50.00",
    });
    const discount = applyVoucherToSubtotal(v, "10.00");
    expect(discount.equals("10.0000")).toBe(true);
  });

  it("expired voucher raises error.voucher_expired", async () => {
    const v = await createVoucher(prisma, {
      code: "OLD",
      type: VoucherType.PERCENT,
      value: "10",
      expiresAt: new Date(Date.now() - 24 * 3600 * 1000),
    });
    expect(() => applyVoucherToSubtotal(v, "10.00")).toThrowError(
      expect.objectContaining({ key: "error.voucher_expired" }),
    );
  });

  it("used-up voucher raises error.voucher_used_up", async () => {
    const v = await createVoucher(prisma, {
      code: "GONE",
      type: VoucherType.PERCENT,
      value: "10",
      usageLimit: 1,
    });
    // Simulate already used.
    const used = { ...v, usedCount: 1 };
    expect(() => applyVoucherToSubtotal(used, "10.00")).toThrowError(
      expect.objectContaining({ key: "error.voucher_used_up" }),
    );
  });

  it("below min purchase raises error.voucher_min_purchase", () => {
    // SAVE10 has min_purchase = 3; subtotal 2 is rejected.
    expect(() => applyVoucherToSubtotal(sample.voucher, "2.00")).toThrowError(
      expect.objectContaining({ key: "error.voucher_min_purchase" }),
    );
  });

  // F-02 (execution/10): the lower side of the boundaries the "used-up"/"expired"
  // tests cover from above — exactly one use left, and not-yet-expired, both apply.
  it("a voucher with one use left (usedCount = usageLimit - 1) still applies", async () => {
    const v = await createVoucher(prisma, {
      code: "LAST1",
      type: VoucherType.PERCENT,
      value: "10",
      usageLimit: 2,
    });
    const almost = { ...v, usedCount: 1 }; // one redemption remaining
    expect(applyVoucherToSubtotal(almost, "20.00").equals("2.0000")).toBe(true);
  });

  it("a voucher expiring in the near future still applies", async () => {
    const v = await createVoucher(prisma, {
      code: "SOON",
      type: VoucherType.PERCENT,
      value: "10",
      expiresAt: new Date(Date.now() + 60_000), // 1 min ahead → still valid
    });
    expect(applyVoucherToSubtotal(v, "20.00").equals("2.0000")).toBe(true);
  });
});

describe("createOrderFromCart with voucher", () => {
  it("applies 10% discount and bumps used_count", async () => {
    const { user, product, voucher } = sample;
    await addToCart(prisma, user.id, product.id, 2); // 10.00
    const order = await createOrderFromCart(prisma, { user, voucherCode: "SAVE10" });

    expect(new Decimal(order!.discountAmount).equals("1.0000")).toBe(true);
    expect(order!.voucherId).toBe(voucher.id);

    const fresh = await prisma.voucher.findUnique({ where: { id: voucher.id } });
    expect(fresh!.usedCount).toBe(1);
  });

  it("unknown voucher raises error.voucher_not_found", async () => {
    const { user, product } = sample;
    await addToCart(prisma, user.id, product.id, 1);
    await expect(
      createOrderFromCart(prisma, { user, voucherCode: "NOPE" }),
    ).rejects.toMatchObject({ key: "error.voucher_not_found" });
  });

  // Pricing-1 (security audit, 2026-06-23): a voucher must not be reusable by
  // the same buyer across multiple orders, even while the GLOBAL usageLimit
  // still has quota left.
  it("records a VoucherRedemption row on first use", async () => {
    const { user, product, voucher } = sample;
    await addToCart(prisma, user.id, product.id, 2);
    const order = await createOrderFromCart(prisma, { user, voucherCode: "SAVE10" });

    const redemption = await prisma.voucherRedemption.findUnique({
      where: { voucherId_userId: { voucherId: voucher.id, userId: user.id } },
    });
    expect(redemption).not.toBeNull();
    expect(redemption!.orderId).toBe(order!.id);
  });

  it("the SAME user reusing a voucher on a second order raises error.voucher_already_redeemed", async () => {
    const { user, product } = sample;
    await addToCart(prisma, user.id, product.id, 2);
    await createOrderFromCart(prisma, { user, voucherCode: "SAVE10" }); // 1st use — succeeds

    await addToCart(prisma, user.id, product.id, 2);
    await expect(
      createOrderFromCart(prisma, { user, voucherCode: "SAVE10" }), // 2nd use — blocked
    ).rejects.toMatchObject({ key: "error.voucher_already_redeemed" });
  });

  it("a DIFFERENT user can still redeem the same voucher (cap is per-user, not global)", async () => {
    const { user, product, voucher } = sample;
    await addToCart(prisma, user.id, product.id, 2);
    await createOrderFromCart(prisma, { user, voucherCode: "SAVE10" });

    const otherUser = await prisma.user.create({ data: { telegramId: 9_988_776, referralCode: "OTHERUSR" } });
    await addToCart(prisma, otherUser.id, product.id, 2);
    const order2 = await createOrderFromCart(prisma, { user: { id: otherUser.id, role: "CUSTOMER", walletBalance: "0" }, voucherCode: "SAVE10" });

    expect(order2!.voucherId).toBe(voucher.id);
    const fresh = await prisma.voucher.findUnique({ where: { id: voucher.id } });
    expect(fresh!.usedCount).toBe(2); // global counter still increments for both
  });

  it("a rejected reuse does NOT double-bump the global usedCount", async () => {
    const { user, product, voucher } = sample;
    await addToCart(prisma, user.id, product.id, 2);
    await createOrderFromCart(prisma, { user, voucherCode: "SAVE10" });

    await addToCart(prisma, user.id, product.id, 2);
    await expect(createOrderFromCart(prisma, { user, voucherCode: "SAVE10" })).rejects.toThrow();

    const fresh = await prisma.voucher.findUnique({ where: { id: voucher.id } });
    expect(fresh!.usedCount).toBe(1); // the blocked attempt never reached the increment
  });
});
