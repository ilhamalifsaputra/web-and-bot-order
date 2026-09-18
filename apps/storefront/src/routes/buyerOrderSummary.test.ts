import { describe, it, expect } from "vitest";
import { Decimal } from "@app/core/money";
import { buyerOrderSummary, type BuyerOrderSummaryInput } from "./buyerOrderSummary";

const base: BuyerOrderSummaryInput = {
  currency: "IDR",
  fxRate: null,
  subtotalAmount: "80000",
  bulkDiscountAmount: "0",
  discountAmount: "0",
  walletUsed: "0",
  uniqueCents: "0",
  totalAmount: "80000",
};

/** The identity the stacked rows assert to whoever reads the page. The
 * unique-cents term comes from the input, not from a returned field: the summary
 * no longer emits one (nothing on the page ever rendered it), and an IDR order —
 * the only kind this identity is claimed for — has none anyway. */
function reconciles(order: BuyerOrderSummaryInput): boolean {
  const s = buyerOrderSummary(order);
  return s.subtotal
    .minus(s.bulkDiscount)
    .minus(s.discount)
    .minus(s.walletCredit)
    .plus(new Decimal(order.uniqueCents))
    .equals(new Decimal(order.totalAmount));
}

describe("buyerOrderSummary", () => {
  it("passes a plain undiscounted order through untouched", () => {
    const s = buyerOrderSummary(base);
    expect(s.subtotal.toString()).toBe("80000");
    expect(s.bulkDiscount.toString()).toBe("0");
    expect(s.discount.toString()).toBe("0");
    expect(s.walletCredit.toString()).toBe("0");
    expect(reconciles(base)).toBe(true);
  });

  it("prints the wallet credit that used to vanish, so a wallet-paid order adds up", () => {
    // 80.000 gross, 25% quantity deal (20.000), a 50%-of-the-rest voucher
    // (30.000), the remaining 30.000 covered entirely by the balance. The page
    // used to print 80.000 − 20.000 − 30.000 above a Total of Rp0.
    const order = {
      ...base,
      bulkDiscountAmount: "20000",
      discountAmount: "30000",
      walletUsed: "30000",
      totalAmount: "0",
    };
    const s = buyerOrderSummary(order);
    expect(s.walletCredit.toString()).toBe("30000");
    expect(s.discount.toString()).toBe("30000");
    expect(reconciles(order)).toBe(true);
  });

  it("reconciles a bulk discount and a voucher together, the combination that exposed the receipt bug", () => {
    const order = {
      ...base,
      bulkDiscountAmount: "20000",
      discountAmount: "30000",
      totalAmount: "30000",
    };
    const s = buyerOrderSummary(order);
    expect(s.bulkDiscount.toString()).toBe("20000");
    expect(s.discount.toString()).toBe("30000");
    expect(reconciles(order)).toBe(true);
  });

  it("absorbs the sub-Rupiah residue of a percentage discount into the voucher row", () => {
    // A 3.5% voucher on Rp8.900 is Rp311,50, and finalizeOrderPayment rounds
    // the IDR total to whole Rupiah: 8588,5 -> 8589. Printing discountAmount
    // verbatim leaves the page one Rupiah short of its own total; the derived
    // figure (311) is exact against what was charged.
    const order = { ...base, subtotalAmount: "8900", discountAmount: "311.5", totalAmount: "8589" };
    const s = buyerOrderSummary(order);
    expect(s.discount.toString()).toBe("311");
    expect(reconciles(order)).toBe(true);
  });

  it("recovers a reduction it has no row for rather than dropping it off the page", () => {
    // Nothing produces this today — it is the shape of the original bug (a
    // reduction that moved the total with no row printing it), and the derived
    // voucher row is what keeps the page honest if one ever appears again.
    const order = { ...base, totalAmount: "72000" };
    const s = buyerOrderSummary(order);
    expect(s.discount.toString()).toBe("8000");
    expect(reconciles(order)).toBe(true);
  });

  it("never prints a negative adjustment, whatever the stored columns say", () => {
    const order = { ...base, bulkDiscountAmount: "20000", totalAmount: "90000" };
    const s = buyerOrderSummary(order);
    expect(s.discount.toString()).toBe("0");
    expect(s.bulkDiscount.toString()).toBe("20000");
  });

  it("leaves a USDT order's central-IDR figures exactly as they were — the documented L-1 gap, not this function's job", () => {
    const order: BuyerOrderSummaryInput = {
      currency: "USDT",
      fxRate: "16000",
      subtotalAmount: "45000",
      bulkDiscountAmount: "0",
      discountAmount: "9000",
      walletUsed: "0",
      uniqueCents: "0.026",
      totalAmount: "2.276",
    };
    const s = buyerOrderSummary(order);
    // Central-IDR in, central-IDR out: no derivation, no conversion, no
    // mixing of the two scales.
    expect(s.subtotal.toString()).toBe("45000");
    expect(s.discount.toString()).toBe("9000");
  });

  /**
   * Whole-branch review A6. `walletUsed` is stored in the ORDER's currency, and
   * the page prints that row with `formatIdr`, so a USDT order's wallet row was
   * a USDT figure wearing a Rupiah label — "−Rp30.000" for 30 USDT of credit,
   * wrong by the whole exchange rate. Suppressed rather than converted: see the
   * module comment for why hiding beats misprinting here.
   */
  it("emits no wallet row for a USDT order — the stored figure is USDT and the page prints Rupiah", () => {
    const order: BuyerOrderSummaryInput = {
      currency: "USDT",
      fxRate: "16000",
      subtotalAmount: "480000",
      bulkDiscountAmount: "0",
      discountAmount: "0",
      walletUsed: "30", // 30 USDT, not Rp30
      uniqueCents: "0",
      totalAmount: "0",
    };
    expect(buyerOrderSummary(order).walletCredit.toString()).toBe("0");
  });

  /**
   * Whole-branch review A6, second half. The non-IDR branch used to be gated on
   * `currency !== "IDR" && fxRate`, so a USDT-stamped order with no snapshot
   * fell through to the IDR derivation — subtracting Rupiah discounts from a
   * USDT total, the one case where deriving is most wrong. Nothing produces that
   * row today (`finalizeOrderPayment` stamps the currency and the rate in one
   * update), which is exactly why the guard has to be the currency alone: the
   * derivation's precondition is "these figures are all Rupiah", and a currency
   * it does not understand fails that whether or not a rate came with it.
   */
  it("does NOT derive for an order stamped USDT with no fx snapshot — an unknown currency is reason enough", () => {
    const order: BuyerOrderSummaryInput = {
      ...base,
      currency: "USDT",
      fxRate: null,
      discountAmount: "9000",
      walletUsed: "5000",
      totalAmount: "75000",
    };
    const s = buyerOrderSummary(order);
    expect(s.discount.toString()).toBe("9000"); // passed through, not derived
    expect(s.walletCredit.toString()).toBe("0");
  });
});
