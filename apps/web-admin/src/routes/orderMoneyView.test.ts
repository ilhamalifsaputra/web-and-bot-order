import { describe, it, expect } from "vitest";
import { Decimal } from "@app/core/money";
import { orderMoneyView } from "./orders";

const base = {
  currency: "IDR",
  fxRate: null as Decimal.Value | null,
  subtotalAmount: "54000",
  bulkDiscountAmount: "0",
  discountAmount: "0",
  walletUsed: "0",
  uniqueCents: "0",
  totalAmount: "54000",
};

describe("orderMoneyView", () => {
  it("passes IDR amounts through unconverted and hides every zero row", () => {
    const view = orderMoneyView(base);
    expect(view.currency).toBe("IDR");
    expect(view.itemsTotal.toString()).toBe("54000");
    expect(view.totalToPay.toString()).toBe("54000");
    expect(view.bulkDiscount).toBeNull();
    expect(view.discount).toBeNull();
    expect(view.walletCredit).toBeNull();
    expect(view.amountMarker).toBeNull();
    expect(view.equivalentIdr).toBeNull();
  });

  it("shows a discount/wallet/marker row once it is non-zero", () => {
    const view = orderMoneyView({
      ...base,
      bulkDiscountAmount: "1000",
      discountAmount: "500",
      walletUsed: "2000",
      uniqueCents: "1",
      totalAmount: "50500",
    });
    expect(view.bulkDiscount?.toString()).toBe("1000");
    expect(view.discount?.toString()).toBe("500");
    expect(view.walletCredit?.toString()).toBe("2000");
    expect(view.amountMarker?.toString()).toBe("1");
  });

  it("converts the IDR-catalog rows to USDT for a USDT order, but leaves the already-USDT total/marker/wallet untouched, and reproduces the reported bug as fixed", () => {
    // The exact screenshot scenario: Rp54.000 of items, settled in USDT at a
    // locked rate of 16000 IDR/USDT, with a 0.026 USDT unique-cents marker.
    const view = orderMoneyView({
      currency: "USDT",
      fxRate: "16000",
      subtotalAmount: "54000",
      bulkDiscountAmount: "0",
      discountAmount: "0",
      walletUsed: "0",
      uniqueCents: "0.026",
      totalAmount: "3.426",
    });
    expect(view.currency).toBe("USDT");
    // Items total converts via the catalog fx snapshot — never "Rp3".
    expect(view.itemsTotal.toString()).toBe("3.4");
    // totalAmount/uniqueCents are already USDT-native — must NOT be re-converted.
    expect(view.totalToPay.toString()).toBe("3.426");
    expect(view.amountMarker?.toString()).toBe("0.026");
    // The IDR-equivalent line for admins reconciling against the catalog price.
    expect(view.equivalentIdr?.toString()).toBe("54816");
  });

  it("omits the IDR-equivalent line when there is no fx snapshot", () => {
    const view = orderMoneyView({ ...base, currency: "USDT", fxRate: null, totalAmount: "3.4" });
    expect(view.equivalentIdr).toBeNull();
  });
});
