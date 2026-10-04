/**
 * B5 (money audit): IDR discounts are whole rupiah, so preview == charge ==
 * wallet debit == receipt rows.
 *
 * Unit prices are already whole rupiah (`effectiveUnitPrice`), but a percent
 * discount on them is not: 12.5% of Rp46.500 is Rp5.812,5. That fraction used
 * to ride along until `finalizeOrderPayment` rounded the TOTAL half-up, so the
 * rows on screen (46.500 - 5.813) read 40.687 while the charge was 40.688, and
 * a wallet-covered order debited 40.687,5 and left half a rupiah of dust.
 *
 * The rule pinned here: each IDR discount (bulk, voucher) is rounded half-up to
 * whole rupiah where it is computed (`bulkDiscountFor`,
 * `applyVoucherToSubtotal`), and the net is `subtotal - discounts`, so the rows
 * always add up and everything downstream (wallet, QRIS fee, charge) starts
 * from a whole-rupiah figure.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  addToCart,
  upsertBulkPricing,
  createVoucher,
  createOrderDirect,
  createOrderFromCart,
  finalizeOrderPayment,
  applyVoucherToSubtotal,
  adjustWallet,
} from "@app/db";
import { createDenomination } from "./catalog";
import { bulkDiscountFor } from "@app/core/bulk";
import { computeQrisAdminFee } from "@app/core/payments/tokopay";
import { formatIdrFor } from "@app/core/moneyFormat";
import { VoucherType, VoucherScope, OrderCurrency, PaymentMethod } from "@app/core/enums";
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

async function sku(price: string) {
  return createDenomination(prisma, {
    productId: sample.parentProduct.id,
    name: `SKU ${price}`,
    type: "SHARED",
    durationLabel: "1 Month",
    price,
    deliveryType: "manual",
  });
}

const d = (v: Decimal.Value) => new Decimal(v);

describe("IDR discounts are whole rupiah (pure)", () => {
  it("bulk: 3 x Rp15.500 at 12.5% takes Rp5.813 off, not Rp5.812,5", () => {
    const discount = bulkDiscountFor("46500", { minQuantity: 3, discountPercent: "12.5" }, 3);
    expect(discount.toString()).toBe("5813");
  });

  it("voucher percent: 15% of Rp10.010 is Rp1.502, not Rp1.501,5", () => {
    const discount = applyVoucherToSubtotal(
      {
        isActive: true,
        expiresAt: null,
        usageLimit: null,
        usedCount: 0,
        minPurchase: "0",
        type: VoucherType.PERCENT,
        value: "15",
        scope: VoucherScope.ALL,
        maxDiscount: null,
        startAt: null,
      },
      "10010",
      "10010",
    );
    expect(discount.toString()).toBe("1502");
  });

  it("voucher fixed with a fractional value is whole rupiah too", () => {
    const discount = applyVoucherToSubtotal(
      {
        isActive: true,
        expiresAt: null,
        usageLimit: null,
        usedCount: 0,
        minPurchase: "0",
        type: VoucherType.FIXED,
        value: "1000.5",
        scope: VoucherScope.ALL,
        maxDiscount: null,
        startAt: null,
      },
      "10010",
      "10010",
    );
    expect(discount.toString()).toBe("1001");
  });

  it("invariant sweep: rows add up and the charge equals the preview for many subtotals and percents", () => {
    // Deterministic pseudo-random sweep (no flakiness, same cases every run).
    let seed = 20261004;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 2000; i++) {
      const unit = 1000 + (next() % 200000); // whole rupiah, like effectiveUnitPrice
      const qty = 1 + (next() % 9);
      const bulkPct = d(next() % 10000).div(100); // 0.00 .. 99.99
      const voucherPct = d(next() % 10000).div(100);
      const subtotal = d(unit).times(qty);
      const bulk = bulkDiscountFor(subtotal, { minQuantity: 1, discountPercent: bulkPct.isZero() ? "1" : bulkPct }, qty);
      const voucher = applyVoucherToSubtotal(
        {
          isActive: true,
          expiresAt: null,
          usageLimit: null,
          usedCount: 0,
          minPurchase: "0",
          type: VoucherType.PERCENT,
          value: voucherPct,
          scope: VoucherScope.ALL,
          maxDiscount: null,
          startAt: null,
        },
        subtotal.minus(bulk),
        subtotal.minus(bulk),
      );
      const net = subtotal.minus(bulk).minus(voucher);
      // Every figure is whole rupiah ...
      for (const v of [bulk, voucher, net]) expect(v.isInteger()).toBe(true);
      // ... so the IDR charge (finalizeOrderPayment rounds to 0dp) is the preview,
      expect(net.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).equals(net)).toBe(true);
      // the displayed rows subtract to the displayed total,
      const shown = (v: Decimal) => d(formatIdrFor(v, "en").replace(/[^0-9]/g, ""));
      expect(shown(subtotal).minus(shown(bulk)).minus(shown(voucher)).equals(shown(net))).toBe(true);
      // and the QRIS fee base is the charged amount.
      expect(computeQrisAdminFee(net).equals(computeQrisAdminFee(net.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)))).toBe(true);
    }
  });
});

describe("IDR order creation: preview == charge == wallet debit", () => {
  it("bulk example: 3 x Rp15.500 at 12.5% charges Rp40.687 and stores rows that add up", async () => {
    const p = await sku("15500");
    await upsertBulkPricing(prisma, { denominationId: p.id, minQuantity: 3, discountPercent: 12.5 });
    const order = await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: p.id, quantity: 3 });
    expect(d(order!.subtotalAmount).toString()).toBe("46500");
    expect(d(order!.bulkDiscountAmount).toString()).toBe("5813");
    const paid = await finalizeOrderPayment(prisma, order!.id, { currency: OrderCurrency.IDR });
    expect(d(paid!.totalAmount).toString()).toBe("40687");
    expect(d(paid!.subtotalAmount).minus(paid!.bulkDiscountAmount).minus(paid!.discountAmount).equals(paid!.totalAmount)).toBe(true);
  });

  it("voucher percent example (cart): 15% off Rp10.010 charges Rp8.508", async () => {
    const p = await sku("10010");
    await createVoucher(prisma, { code: "P15", type: VoucherType.PERCENT, value: "15" });
    await addToCart(prisma, sample.user.id, p.id, 1);
    const order = await createOrderFromCart(prisma, { channel: "web", user: sample.user, voucherCode: "P15" });
    expect(d(order!.discountAmount).toString()).toBe("1502");
    const paid = await finalizeOrderPayment(prisma, order!.id, { currency: OrderCurrency.IDR });
    expect(d(paid!.totalAmount).toString()).toBe("8508");
  });

  it("bulk and voucher together (direct): both discounts whole, rows add up to the charge", async () => {
    const p = await sku("15500");
    await upsertBulkPricing(prisma, { denominationId: p.id, minQuantity: 3, discountPercent: 12.5 });
    await createVoucher(prisma, { code: "P15B", type: VoucherType.PERCENT, value: "15" });
    const order = await createOrderDirect(prisma, {
      channel: "bot",
      user: sample.user,
      productId: p.id,
      quantity: 3,
      voucherCode: "P15B",
    });
    // 15% of 40.687 = 6.103,05 -> 6.103
    expect(d(order!.bulkDiscountAmount).toString()).toBe("5813");
    expect(d(order!.discountAmount).toString()).toBe("6103");
    const paid = await finalizeOrderPayment(prisma, order!.id, { currency: OrderCurrency.IDR });
    expect(d(paid!.totalAmount).toString()).toBe("34584");
  });

  it("wallet-covered order debits the whole-rupiah net and leaves no fractional dust", async () => {
    const p = await sku("15500");
    await upsertBulkPricing(prisma, { denominationId: p.id, minQuantity: 3, discountPercent: 12.5 });
    await adjustWallet(prisma, sample.user.id, "50000", { currency: "IDR", reason: "admin_adjust" });
    const order = await createOrderDirect(prisma, {
      channel: "bot",
      user: { ...sample.user, walletBalance: "50000" },
      productId: p.id,
      quantity: 3,
      walletAmount: "50000",
    });
    expect(d(order!.walletUsed).toString()).toBe("40687");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(d(user.walletBalance).toString()).toBe("9313");
  });

  it("a partial wallet credit with a fractional balance spends only whole rupiah, so the rest stays whole", async () => {
    const p = await sku("15500");
    await adjustWallet(prisma, sample.user.id, "1000.5", { currency: "IDR", reason: "admin_adjust" });
    const direct = await createOrderDirect(prisma, {
      channel: "bot",
      user: { ...sample.user, walletBalance: "1000.5" },
      productId: p.id,
      quantity: 1,
      walletAmount: "1000.5",
    });
    expect(d(direct!.walletUsed).toString()).toBe("1000");
    const paid = await finalizeOrderPayment(prisma, direct!.id, { currency: OrderCurrency.IDR, method: PaymentMethod.TOKOPAY });
    expect(d(paid!.totalAmount).toString()).toBe("14500");
    expect(d(paid!.walletUsed).plus(paid!.totalAmount).toString()).toBe("15500");
  });

  it("QRIS fee is computed on the same whole-rupiah total that is charged", async () => {
    const p = await sku("15500");
    await upsertBulkPricing(prisma, { denominationId: p.id, minQuantity: 3, discountPercent: 12.5 });
    const order = await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: p.id, quantity: 3 });
    const preview = d(order!.subtotalAmount).minus(order!.bulkDiscountAmount).minus(order!.discountAmount);
    const paid = await finalizeOrderPayment(prisma, order!.id, { currency: OrderCurrency.IDR });
    expect(computeQrisAdminFee(preview).equals(computeQrisAdminFee(paid!.totalAmount))).toBe(true);
    expect(preview.equals(paid!.totalAmount)).toBe(true);
  });
});
