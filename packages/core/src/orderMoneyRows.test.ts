import { describe, it, expect } from "vitest";
import { Decimal } from "./money";
import { usdtFromIdr } from "./formatters";
import { reconciledOrderMoneyRows } from "./orderMoneyRows";

/** Build a USDT order exactly as finalizeOrderPayment would stamp it. */
function usdtOrder(subtotal: string, bulk: string, voucher: string, rate: string, cents = "0.03", walletUsdt = "0") {
  const netIdr = new Decimal(subtotal).minus(bulk).minus(voucher);
  const usdt = usdtFromIdr(netIdr, rate);
  return {
    currency: "USDT",
    fxRate: rate,
    subtotalAmount: subtotal,
    bulkDiscountAmount: bulk,
    discountAmount: voucher,
    walletUsed: walletUsdt,
    uniqueCents: cents,
    totalAmount: usdt.plus(cents).minus(walletUsdt).toString(),
  };
}

const adds = (r: ReturnType<typeof reconciledOrderMoneyRows>) =>
  r.itemsTotal.minus(r.bulkDiscount).minus(r.discount).minus(r.walletCredit).plus(r.uniqueCents);

describe("reconciledOrderMoneyRows", () => {
  it.each([
    { discount: "1501.5", wallet: "0", total: "8509", roundedDiscount: "1502", roundedWallet: "0" },
    { discount: "0", wallet: "1000.5", total: "9010", roundedDiscount: "0", roundedWallet: "1001" },
  ])("final review: legacy IDR display absorbs fractional $discount discount/$wallet wallet without changing source", (example) => {
    const order = Object.freeze({ currency: "IDR", fxRate: null, subtotalAmount: "10010", bulkDiscountAmount: "0",
      discountAmount: example.discount, walletUsed: example.wallet, uniqueCents: "0", totalAmount: example.total });
    const rows = reconciledOrderMoneyRows(order);
    expect(rows.itemsTotal.toString()).toBe("10011");
    expect(rows.discount.toString()).toBe(example.roundedDiscount);
    expect(rows.walletCredit.toString()).toBe(example.roundedWallet);
    expect(rows.total.toString()).toBe(example.total);
    expect(adds(rows).toString()).toBe(rows.total.toString());
    expect(order.discountAmount).toBe(example.discount);
    expect(order.walletUsed).toBe(example.wallet);
  });

  it("the audit example: 46.500 with a 5.812,5 bulk discount at 16.000 adds up to the charged total", () => {
    const rows = reconciledOrderMoneyRows(usdtOrder("46500", "5812.5", "0", "16000"));
    expect(rows.bulkDiscount.toString()).toBe("0.37");
    expect(rows.total.toString()).toBe("2.58"); // 2.55 + 0.03 cents
    expect(rows.itemsTotal.toString()).toBe("2.92"); // absorbs the remainder (independent ceil gives 2.91)
    expect(adds(rows).equals(rows.total)).toBe(true);
  });

  it("subtotal + bulk + voucher add up to the total at several rates, with and without USDT wallet credit", () => {
    for (const rate of ["15000", "15873.25", "16000", "16321", "17000.5"]) {
      for (const [sub, bulk, voucher] of [
        ["46500", "5813", "6103"],
        ["10010", "0", "1502"],
        ["32080", "0", "16016"],
        ["123457", "12346", "11111"],
      ]) {
        for (const wallet of ["0", "0.5"]) {
          const rows = reconciledOrderMoneyRows(usdtOrder(sub!, bulk!, voucher!, rate, "0.03", wallet));
          expect(adds(rows).equals(rows.total)).toBe(true);
          // Discounts are converted with the charge's own rule.
          expect(rows.bulkDiscount.equals(usdtFromIdr(bulk!, rate))).toBe(true);
          expect(rows.discount.equals(usdtFromIdr(voucher!, rate))).toBe(true);
        }
      }
    }
  });

  it("a reconciled whole-rupiah IDR order keeps its original rows", () => {
    const rows = reconciledOrderMoneyRows({
      currency: "IDR",
      fxRate: null,
      subtotalAmount: "54000",
      bulkDiscountAmount: "1000",
      discountAmount: "500",
      walletUsed: "2000",
      uniqueCents: "0",
      totalAmount: "50500",
    });
    expect(rows.itemsTotal.toString()).toBe("54000");
    expect(adds(rows).equals(rows.total)).toBe(true);
  });
});
