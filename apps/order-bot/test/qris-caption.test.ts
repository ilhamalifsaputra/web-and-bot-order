/**
 * B7 (money audit): the QRIS payment screen's rows must add up. It used to
 * print the gross Subtotal, then the fee, then the NET total + fee as "Total to
 * pay" — Rp100.000 + Rp660 = "Rp80.660" for a 20% voucher, voucher invisible.
 */
import { describe, it, expect } from "vitest";
import { Decimal } from "@app/core/money";
import { t as coreT } from "@app/core/i18n";
import { computeQrisAdminFee } from "@app/core/payments/tokopay";
import { formatIdrFor } from "@app/core/moneyFormat";
import { qrisCaptionAmounts, type QrisCaptionOrder } from "../src/util/qrisCaption";

const order = (over: Partial<QrisCaptionOrder> = {}): QrisCaptionOrder => ({
  subtotalAmount: "100000",
  bulkDiscountAmount: "0",
  discountAmount: "0",
  walletUsed: "0",
  totalAmount: "100000",
  ...over,
});

function render(o: QrisCaptionOrder, lang: "en" | "id") {
  const rows = qrisCaptionAmounts(o, lang);
  return coreT("checkout.qris_instructions", lang, {
    code: "ORD-1",
    subtotal: rows.subtotal,
    discount_lines: rows.discount_lines,
    fee: rows.fee,
    amount: rows.amount,
    expiry: "2026-10-04 12:00 WIB",
  });
}

/** Every Rp figure on the screen, in order, as whole rupiah. */
function figures(text: string): Decimal[] {
  return [...text.matchAll(/(−)?Rp([\d.,]+)/g)].map((m) => {
    const v = new Decimal(m[2]!.replace(/[.,]/g, ""));
    return m[1] ? v.negated() : v;
  });
}

/** Subtotal (+ signed discount rows) + fee === total to pay. */
function addsUp(text: string): boolean {
  const f = figures(text);
  const total = f[f.length - 1]!;
  const sum = f.slice(0, -1).reduce((a, b) => a.plus(b), new Decimal(0));
  return sum.equals(total);
}

describe("QRIS payment screen rows", () => {
  for (const lang of ["en", "id"] as const) {
    it(`[${lang}] no discount: subtotal + fee = total, no discount rows`, () => {
      const text = render(order(), lang);
      expect(text).not.toContain("{");
      expect(text).not.toContain("Voucher");
      expect(addsUp(text)).toBe(true);
    });

    it(`[${lang}] the audit example: Rp100.000 with a 20% voucher shows the voucher and adds up`, () => {
      const text = render(order({ discountAmount: "20000", totalAmount: "80000" }), lang);
      expect(text).toContain(`🎟 Voucher: −${formatIdrFor("20000", lang)}`);
      const fee = computeQrisAdminFee("80000");
      expect(text).toContain(formatIdrFor(new Decimal(80000).plus(fee), lang));
      expect(addsUp(text)).toBe(true);
    });

    it(`[${lang}] bulk + voucher + wallet credit each get a row and add up`, () => {
      const text = render(
        order({ subtotalAmount: "46500", bulkDiscountAmount: "5813", discountAmount: "6103", walletUsed: "1000", totalAmount: "33584" }),
        lang,
      );
      expect(text).toContain(lang === "en" ? "Quantity discount" : "Diskon jumlah");
      expect(text).toContain(lang === "en" ? "IDR Credit" : "Kredit IDR");
      expect(addsUp(text)).toBe(true);
    });

    it(`[${lang}] wallet top-up shape (subtotal = total): subtotal + fee = total`, () => {
      const text = render(order({ subtotalAmount: "50000", totalAmount: "50000" }), lang);
      expect(text).not.toContain("−");
      expect(addsUp(text)).toBe(true);
    });
  }

  it("a legacy order with a fractional stored discount still prints rows that add up (voucher row derived)", () => {
    const text = render(order({ subtotalAmount: "10010", discountAmount: "1501.5", totalAmount: "8509" }), "en");
    expect(text).toContain(`Voucher: −${formatIdrFor("1501", "en")}`);
    expect(addsUp(text)).toBe(true);
  });
});
