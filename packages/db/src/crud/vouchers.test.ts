import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { VoucherType, VoucherScope, OrderStatus } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import {
  createVoucher,
  deleteVoucher,
  updateVoucher,
  applyVoucherToSubtotal,
  getVoucherProductIds,
  deriveVoucherStatus,
  getVoucherStats,
  getVoucherPerformance,
  type VoucherLike,
} from "./vouchers";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

describe("deleteVoucher", () => {
  it("deletes a never-used voucher", async () => {
    const v = await createVoucher(prisma, { code: "UNUSED1", type: VoucherType.PERCENT, value: "10" });
    await deleteVoucher(prisma, v.id);
    expect(await prisma.voucher.findUnique({ where: { id: v.id } })).toBeNull();
  });

  it("refuses to delete a voucher that has been used", async () => {
    const v = await createVoucher(prisma, { code: "USED1", type: VoucherType.PERCENT, value: "10" });
    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 1 } });
    await expect(deleteVoucher(prisma, v.id)).rejects.toThrow(/has been used/);
    expect(await prisma.voucher.findUnique({ where: { id: v.id } })).not.toBeNull();
  });
});

// Pricing-4 (security audit, 2026-06-23): a misconfigured PERCENT voucher is
// the only thing standing between an admin typo and a free (Rp0) order.
describe("createVoucher discountPercent bounds (PERCENT type)", () => {
  it("rejects value > 100", async () => {
    await expect(
      createVoucher(prisma, { code: "OVER100", type: VoucherType.PERCENT, value: "150" }),
    ).rejects.toMatchObject({ key: "error.invalid_discount_percent" });
    expect(await prisma.voucher.findUnique({ where: { code: "OVER100" } })).toBeNull();
  });

  it("rejects value === 0 and negative", async () => {
    await expect(
      createVoucher(prisma, { code: "ZEROPCT", type: VoucherType.PERCENT, value: "0" }),
    ).rejects.toMatchObject({ key: "error.invalid_discount_percent" });
    await expect(
      createVoucher(prisma, { code: "NEGPCT", type: VoucherType.PERCENT, value: "-10" }),
    ).rejects.toMatchObject({ key: "error.invalid_discount_percent" });
  });

  it("accepts exactly 100 for PERCENT", async () => {
    const v = await createVoucher(prisma, { code: "FULL100", type: VoucherType.PERCENT, value: "100" });
    expect(Number(v.value)).toBe(100);
  });

  it("does NOT bound a FIXED voucher's value (capped at subtotal elsewhere)", async () => {
    const v = await createVoucher(prisma, { code: "BIGFIXED", type: VoucherType.FIXED, value: "999999" });
    expect(Number(v.value)).toBe(999999);
  });
});

/** Minimal ALL-scope VoucherLike builder — every field applyVoucherToSubtotal
 *  reads, defaulted to "always eligible" so each test only overrides what it's
 *  actually exercising. */
function baseVoucher(overrides: Partial<VoucherLike> = {}): VoucherLike {
  return {
    isActive: true,
    expiresAt: null,
    usageLimit: null,
    usedCount: 0,
    minPurchase: "0",
    type: VoucherType.PERCENT,
    value: "10",
    scope: VoucherScope.ALL,
    maxDiscount: null,
    startAt: null,
    ...overrides,
  };
}

describe("applyVoucherToSubtotal", () => {
  it("PERCENT baseline: eligibleSubtotal === subtotal behaves exactly as the pre-scope function did", () => {
    const v = baseVoucher({ type: VoucherType.PERCENT, value: "10" });
    const discount = applyVoucherToSubtotal(v, "20.00", "20.00");
    expect(discount.equals("2.0000")).toBe(true);
  });

  it("FIXED baseline: value larger than subtotal is capped at the subtotal when eligibleSubtotal === subtotal", () => {
    const v = baseVoucher({ type: VoucherType.FIXED, value: "50.00" });
    const discount = applyVoucherToSubtotal(v, "10.00", "10.00");
    expect(discount.equals("10.0000")).toBe(true);
  });

  it("startAt in the future rejects with error.voucher_not_yet_active", () => {
    const v = baseVoucher({ startAt: new Date(Date.now() + 60_000) });
    expect(() => applyVoucherToSubtotal(v, "20.00", "20.00")).toThrowError(
      expect.objectContaining({ key: "error.voucher_not_yet_active" }),
    );
  });

  it("startAt in the past allows", () => {
    const v = baseVoucher({ startAt: new Date(Date.now() - 60_000) });
    expect(applyVoucherToSubtotal(v, "20.00", "20.00").equals("2.0000")).toBe(true);
  });

  it("startAt null allows (pre-migration vouchers)", () => {
    const v = baseVoucher({ startAt: null });
    expect(applyVoucherToSubtotal(v, "20.00", "20.00").equals("2.0000")).toBe(true);
  });

  it("SELECTED-scope: discount computed off eligibleSubtotal, not subtotal, when they differ", () => {
    // Cart subtotal 100 (net of bulk discount), but only 20 of it is the
    // scoped product's own (bulk-discount-net) line — 10% of 20 = 2, not 10% of 100 = 10.
    const v = baseVoucher({ scope: VoucherScope.SELECTED, type: VoucherType.PERCENT, value: "10" });
    const discount = applyVoucherToSubtotal(v, "100.00", "20.00");
    expect(discount.equals("2.0000")).toBe(true);
  });

  it("SELECTED-scope with eligibleSubtotal <= 0 rejects with error.voucher_not_applicable", () => {
    const v = baseVoucher({ scope: VoucherScope.SELECTED });
    expect(() => applyVoucherToSubtotal(v, "100.00", "0")).toThrowError(
      expect.objectContaining({ key: "error.voucher_not_applicable" }),
    );
  });

  it("SELECTED-scope with a negative eligibleSubtotal also rejects with error.voucher_not_applicable", () => {
    const v = baseVoucher({ scope: VoucherScope.SELECTED });
    expect(() => applyVoucherToSubtotal(v, "100.00", "-5")).toThrowError(
      expect.objectContaining({ key: "error.voucher_not_applicable" }),
    );
  });

  it("minPurchase is checked against the full subtotal even when eligibleSubtotal is smaller", () => {
    // minPurchase=50; full subtotal=60 (qualifies); eligibleSubtotal=10 (the
    // scoped portion) — must still apply, discounting only the eligible slice.
    const v = baseVoucher({ scope: VoucherScope.SELECTED, minPurchase: "50", type: VoucherType.PERCENT, value: "10" });
    const discount = applyVoucherToSubtotal(v, "60.00", "10.00");
    expect(discount.equals("1.0000")).toBe(true);
  });

  it("minPurchase rejects when the full subtotal doesn't qualify, regardless of eligibleSubtotal", () => {
    const v = baseVoucher({ minPurchase: "50" });
    expect(() => applyVoucherToSubtotal(v, "10.00", "10.00")).toThrowError(
      expect.objectContaining({ key: "error.voucher_min_purchase" }),
    );
  });

  it("maxDiscount caps a PERCENT voucher's discount below what the percent alone would compute", () => {
    const v = baseVoucher({ type: VoucherType.PERCENT, value: "50", maxDiscount: "3" });
    // 50% of 20 = 10, but maxDiscount caps it at 3.
    const discount = applyVoucherToSubtotal(v, "20.00", "20.00");
    expect(discount.equals("3.0000")).toBe(true);
  });

  it("maxDiscount has no effect when the uncapped discount is already smaller", () => {
    const v = baseVoucher({ type: VoucherType.PERCENT, value: "10", maxDiscount: "100" });
    const discount = applyVoucherToSubtotal(v, "20.00", "20.00");
    expect(discount.equals("2.0000")).toBe(true);
  });

  it("FIXED voucher whose value exceeds both eligibleSubtotal and maxDiscount: final discount is the smaller of the two", () => {
    const v = baseVoucher({ type: VoucherType.FIXED, value: "999", maxDiscount: "15" });
    const discount = applyVoucherToSubtotal(v, "20.00", "20.00");
    // Capped at eligibleSubtotal (20) first, then at maxDiscount (15) — 15 wins.
    expect(discount.equals("15.0000")).toBe(true);
  });

  it("expired voucher raises error.voucher_expired (existing, unchanged)", () => {
    const v = baseVoucher({ expiresAt: new Date(Date.now() - 24 * 3600 * 1000) });
    expect(() => applyVoucherToSubtotal(v, "10.00", "10.00")).toThrowError(
      expect.objectContaining({ key: "error.voucher_expired" }),
    );
  });

  it("used-up voucher raises error.voucher_used_up (existing, unchanged)", () => {
    const v = baseVoucher({ usageLimit: 1, usedCount: 1 });
    expect(() => applyVoucherToSubtotal(v, "10.00", "10.00")).toThrowError(
      expect.objectContaining({ key: "error.voucher_used_up" }),
    );
  });

  it("inactive voucher raises error.voucher_inactive (existing, unchanged)", () => {
    const v = baseVoucher({ isActive: false });
    expect(() => applyVoucherToSubtotal(v, "10.00", "10.00")).toThrowError(
      expect.objectContaining({ key: "error.voucher_inactive" }),
    );
  });
});

describe("getVoucherProductIds", () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it("returns the scoped product ids for a voucher", async () => {
    const category = await createCategory(prisma, "Streaming", "🎬");
    const p1 = await createCatalogProduct(prisma, { categoryId: category.id, name: "Product A" });
    const p2 = await createCatalogProduct(prisma, { categoryId: category.id, name: "Product B" });
    const v = await createVoucher(prisma, {
      code: "SEL1",
      type: VoucherType.PERCENT,
      value: "10",
      scope: VoucherScope.SELECTED,
      productIds: [p1.id, p2.id],
    });
    const ids = await getVoucherProductIds(prisma, v.id);
    expect(ids.sort()).toEqual([p1.id, p2.id].sort());
  });

  it("returns an empty array for an ALL-scope voucher", async () => {
    const v = await createVoucher(prisma, { code: "ALLSCOPE", type: VoucherType.PERCENT, value: "10" });
    expect(await getVoucherProductIds(prisma, v.id)).toEqual([]);
  });
});

describe("updateVoucher", () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it("rejects a code change once usedCount > 0", async () => {
    const v = await createVoucher(prisma, { code: "CODEA", type: VoucherType.PERCENT, value: "10" });
    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 1 } });
    await expect(updateVoucher(prisma, v.id, { code: "CODEB" })).rejects.toThrow(/has been used/);
    const fresh = await prisma.voucher.findUnique({ where: { id: v.id } });
    expect(fresh!.code).toBe("CODEA");
  });

  it("allows value/limit/date/scope changes regardless of usedCount", async () => {
    const v = await createVoucher(prisma, { code: "CODEC", type: VoucherType.PERCENT, value: "10" });
    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 5 } });
    const expiresAt = new Date(Date.now() + 86_400_000);
    const updated = await updateVoucher(prisma, v.id, {
      value: "25",
      usageLimit: 10,
      expiresAt,
      isActive: false,
    });
    expect(Number(updated!.value)).toBe(25);
    expect(updated!.usageLimit).toBe(10);
    expect(updated!.expiresAt?.getTime()).toBe(expiresAt.getTime());
    expect(updated!.isActive).toBe(false);
  });

  it("allows a no-op code 'change' (same code) on a used voucher", async () => {
    const v = await createVoucher(prisma, { code: "CODED", type: VoucherType.PERCENT, value: "10" });
    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 1 } });
    const updated = await updateVoucher(prisma, v.id, { code: "coded", value: "20" });
    expect(updated!.code).toBe("CODED");
    expect(Number(updated!.value)).toBe(20);
  });

  it("replaces the VoucherProduct set transactionally on a scope change", async () => {
    const category = await createCategory(prisma, "Streaming", "🎬");
    const p1 = await createCatalogProduct(prisma, { categoryId: category.id, name: "Product A" });
    const p2 = await createCatalogProduct(prisma, { categoryId: category.id, name: "Product B" });
    const p3 = await createCatalogProduct(prisma, { categoryId: category.id, name: "Product C" });
    const v = await createVoucher(prisma, {
      code: "SCOPECHG",
      type: VoucherType.PERCENT,
      value: "10",
      scope: VoucherScope.SELECTED,
      productIds: [p1.id, p2.id],
    });
    expect((await getVoucherProductIds(prisma, v.id)).sort()).toEqual([p1.id, p2.id].sort());

    await updateVoucher(prisma, v.id, { scope: VoucherScope.SELECTED, productIds: [p3.id] });
    expect(await getVoucherProductIds(prisma, v.id)).toEqual([p3.id]);

    await updateVoucher(prisma, v.id, { scope: VoucherScope.ALL, productIds: [] });
    expect(await getVoucherProductIds(prisma, v.id)).toEqual([]);
  });
});

describe("deriveVoucherStatus", () => {
  const now = new Date("2026-07-26T00:00:00Z");
  const future = new Date(now.getTime() + 86_400_000);
  const past = new Date(now.getTime() - 86_400_000);

  it("expired: expiresAt in the past, regardless of everything else", () => {
    expect(
      deriveVoucherStatus({ isActive: true, expiresAt: past, usageLimit: null, usedCount: 0, startAt: null }, now),
    ).toBe("expired");
  });

  it("usedUp: usageLimit reached, even when still active and not expired", () => {
    expect(
      deriveVoucherStatus({ isActive: true, expiresAt: null, usageLimit: 1, usedCount: 1, startAt: null }, now),
    ).toBe("usedUp");
  });

  it("disabled: isActive false, not expired/usedUp", () => {
    expect(
      deriveVoucherStatus({ isActive: false, expiresAt: null, usageLimit: null, usedCount: 0, startAt: null }, now),
    ).toBe("disabled");
  });

  it("scheduled: startAt in the future, active, not expired/usedUp/disabled", () => {
    expect(
      deriveVoucherStatus({ isActive: true, expiresAt: null, usageLimit: null, usedCount: 0, startAt: future }, now),
    ).toBe("scheduled");
  });

  it("active: none of the above apply", () => {
    expect(
      deriveVoucherStatus({ isActive: true, expiresAt: null, usageLimit: null, usedCount: 0, startAt: null }, now),
    ).toBe("active");
  });

  it("disabled beats scheduled (an admin-disabled voucher is never reported as scheduled)", () => {
    expect(
      deriveVoucherStatus({ isActive: false, expiresAt: null, usageLimit: null, usedCount: 0, startAt: future }, now),
    ).toBe("disabled");
  });

  it("expired beats disabled", () => {
    expect(
      deriveVoucherStatus({ isActive: false, expiresAt: past, usageLimit: null, usedCount: 0, startAt: null }, now),
    ).toBe("expired");
  });

  it("usedUp beats disabled", () => {
    expect(
      deriveVoucherStatus({ isActive: false, expiresAt: null, usageLimit: 1, usedCount: 1, startAt: null }, now),
    ).toBe("usedUp");
  });
});

describe("getVoucherStats", () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it("returns the new { active, scheduled, expired, totalRedemptions } shape with correct counts", async () => {
    const now = new Date();
    await createVoucher(prisma, { code: "STATACTIVE", type: VoucherType.PERCENT, value: "10" });
    const scheduled = await createVoucher(prisma, {
      code: "STATSCHED",
      type: VoucherType.PERCENT,
      value: "10",
      startAt: new Date(now.getTime() + 86_400_000),
    });
    const expired = await createVoucher(prisma, {
      code: "STATEXP",
      type: VoucherType.PERCENT,
      value: "10",
      expiresAt: new Date(now.getTime() - 86_400_000),
    });
    const disabled = await createVoucher(prisma, { code: "STATDIS", type: VoucherType.PERCENT, value: "10" });
    await prisma.voucher.update({ where: { id: disabled.id }, data: { isActive: false } });
    void scheduled;
    void expired;

    // Two redemption rows for the same voucher, to prove totalRedemptions
    // counts VoucherRedemption rows, not sum(usedCount).
    const category = await createCategory(prisma, "Streaming", "🎬");
    const parentProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "P" });
    const denom = await createDenomination(prisma, {
      productId: parentProduct.id,
      name: "P",
      type: "SHARED",
      durationLabel: "1M",
      price: "10",
    });
    const redeemVoucher = await createVoucher(prisma, { code: "STATREDEEM", type: VoucherType.PERCENT, value: "10" });
    const u1 = await prisma.user.create({ data: { telegramId: 1001, referralCode: "REF1001" } });
    const u2 = await prisma.user.create({ data: { telegramId: 1002, referralCode: "REF1002" } });
    const o1 = await prisma.order.create({
      data: { orderCode: "ORD-STAT-1", userId: u1.id, subtotalAmount: "10", totalAmount: "9", voucherId: redeemVoucher.id, status: OrderStatus.DELIVERED },
    });
    const o2 = await prisma.order.create({
      data: { orderCode: "ORD-STAT-2", userId: u2.id, subtotalAmount: "10", totalAmount: "9", voucherId: redeemVoucher.id, status: OrderStatus.DELIVERED },
    });
    await prisma.voucherRedemption.create({ data: { voucherId: redeemVoucher.id, userId: u1.id, orderId: o1.id } });
    await prisma.voucherRedemption.create({ data: { voucherId: redeemVoucher.id, userId: u2.id, orderId: o2.id } });
    void denom;

    const stats = await getVoucherStats(prisma, now);
    expect(stats.active).toBe(2); // STATACTIVE + STATREDEEM
    expect(stats.scheduled).toBe(1); // STATSCHED
    expect(stats.expired).toBe(1); // STATEXP
    expect(stats.totalRedemptions).toBe(2);
  });

  it("totalRedemptions stays correct even after a redeemed voucher's usedCount is decremented (cancellation)", async () => {
    const category = await createCategory(prisma, "Streaming", "🎬");
    const parentProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "P" });
    await createDenomination(prisma, {
      productId: parentProduct.id,
      name: "P",
      type: "SHARED",
      durationLabel: "1M",
      price: "10",
    });
    const v = await createVoucher(prisma, { code: "DECR", type: VoucherType.PERCENT, value: "10", usageLimit: 5 });
    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 1 } });
    const u = await prisma.user.create({ data: { telegramId: 2001, referralCode: "REF2001" } });
    const o = await prisma.order.create({
      data: { orderCode: "ORD-DECR-1", userId: u.id, subtotalAmount: "10", totalAmount: "9", voucherId: v.id, status: OrderStatus.CANCELLED },
    });
    await prisma.voucherRedemption.create({ data: { voucherId: v.id, userId: u.id, orderId: o.id } });
    // Simulate releaseOrderHolds' usedCount decrement on cancellation.
    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 0 } });

    const stats = await getVoucherStats(prisma);
    expect(stats.totalRedemptions).toBe(1); // the VoucherRedemption row survives the cancellation
  });
});

describe("getVoucherPerformance", () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  async function makeUserAndOrder(opts: {
    telegramId: number;
    referralCode: string;
    voucherId: number | null;
    totalAmount: string;
    currency?: string;
    fxRate?: string | null;
    status?: string;
  }) {
    const user = await prisma.user.create({ data: { telegramId: opts.telegramId, referralCode: opts.referralCode } });
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-PERF-${opts.telegramId}`,
        userId: user.id,
        subtotalAmount: opts.totalAmount,
        totalAmount: opts.totalAmount,
        voucherId: opts.voucherId,
        currency: opts.currency ?? "IDR",
        fxRate: opts.fxRate ?? null,
        status: opts.status ?? OrderStatus.DELIVERED,
      },
    });
    return { user, order };
  }

  it("returns an empty Map for an empty voucherIds input without querying", async () => {
    const result = await getVoucherPerformance(prisma, []);
    expect(result.size).toBe(0);
  });

  it("aggregates orders/revenue/customers across a batch of voucher ids in one query", async () => {
    const v1 = await createVoucher(prisma, { code: "PERF1", type: VoucherType.PERCENT, value: "10" });
    const v2 = await createVoucher(prisma, { code: "PERF2", type: VoucherType.PERCENT, value: "10" });
    await makeUserAndOrder({ telegramId: 3001, referralCode: "P3001", voucherId: v1.id, totalAmount: "100" });
    await makeUserAndOrder({ telegramId: 3002, referralCode: "P3002", voucherId: v1.id, totalAmount: "50" });
    await makeUserAndOrder({ telegramId: 3003, referralCode: "P3003", voucherId: v2.id, totalAmount: "200" });

    const result = await getVoucherPerformance(prisma, [v1.id, v2.id]);
    expect(result.get(v1.id)).toEqual({ ordersCount: 2, revenue: expect.any(Decimal), customers: 2 });
    expect(result.get(v1.id)!.revenue.equals("150.0000")).toBe(true);
    expect(result.get(v2.id)!.revenue.equals("200.0000")).toBe(true);
    expect(result.get(v2.id)!.customers).toBe(1);
  });

  it("excludes non-DELIVERED orders", async () => {
    const v = await createVoucher(prisma, { code: "PERFND", type: VoucherType.PERCENT, value: "10" });
    await makeUserAndOrder({ telegramId: 3101, referralCode: "P3101", voucherId: v.id, totalAmount: "100", status: OrderStatus.DELIVERED });
    await makeUserAndOrder({ telegramId: 3102, referralCode: "P3102", voucherId: v.id, totalAmount: "999", status: OrderStatus.CANCELLED });
    await makeUserAndOrder({ telegramId: 3103, referralCode: "P3103", voucherId: v.id, totalAmount: "999", status: OrderStatus.PENDING_PAYMENT });

    const result = await getVoucherPerformance(prisma, [v.id]);
    expect(result.get(v.id)!.ordersCount).toBe(1);
    expect(result.get(v.id)!.revenue.equals("100.0000")).toBe(true);
  });

  it("converts a USDT order's totalAmount via its fxRate snapshot rather than summing raw", async () => {
    const v = await createVoucher(prisma, { code: "PERFUSDT", type: VoucherType.PERCENT, value: "10" });
    await makeUserAndOrder({ telegramId: 3201, referralCode: "P3201", voucherId: v.id, totalAmount: "100", currency: "IDR" });
    // 10 USDT at fxRate 16000 -> 160000 IDR-equivalent.
    await makeUserAndOrder({ telegramId: 3202, referralCode: "P3202", voucherId: v.id, totalAmount: "10", currency: "USDT", fxRate: "16000" });

    const result = await getVoucherPerformance(prisma, [v.id]);
    expect(result.get(v.id)!.revenue.equals("160100.0000")).toBe(true);
  });

  it("a voucher id with zero delivered orders is simply absent from the returned Map", async () => {
    const v = await createVoucher(prisma, { code: "PERFNONE", type: VoucherType.PERCENT, value: "10" });
    const result = await getVoucherPerformance(prisma, [v.id]);
    expect(result.has(v.id)).toBe(false);
  });
});
