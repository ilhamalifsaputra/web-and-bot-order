// Backend audit pass 2, A6: assertQuotedTotal is the one comparison behind the
// `expected_total` quote binding on both storefront wallet rails. Pure — no DB.
import { describe, expect, it } from "vitest";
import { Decimal } from "@app/core/money";
import { OrderCurrency } from "@app/core/enums";
import { assertQuotedTotal, QuoteMismatchError } from "./orders";

describe("assertQuotedTotal", () => {
  it("is a no-op when no quote was sent", () => {
    expect(() => assertQuotedTotal(null, new Decimal("40000"))).not.toThrow();
    expect(() => assertQuotedTotal(undefined, new Decimal("40000"))).not.toThrow();
  });

  it("compares IDR by value, not by string", () => {
    expect(() =>
      assertQuotedTotal({ currency: OrderCurrency.IDR, amount: "40000.00" }, new Decimal("40000.0000")),
    ).not.toThrow();
    expect(() => assertQuotedTotal({ currency: OrderCurrency.IDR, amount: new Decimal("4e4") }, new Decimal("40000"))).not.toThrow();
  });

  it("refuses a different IDR total, reporting both figures", () => {
    try {
      assertQuotedTotal({ currency: OrderCurrency.IDR, amount: "40000" }, new Decimal("40000.5"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QuoteMismatchError);
      const q = e as QuoteMismatchError;
      expect([q.currency, q.expectedTotal, q.currentTotal]).toEqual(["IDR", "40000", "40000.5"]);
    }
  });

  it("converts to USDT with the rail's own rounding (ceil to 0.01) at the given rate", () => {
    // 45000 / 16000 = 2.8125 → 2.82
    expect(() =>
      assertQuotedTotal({ currency: OrderCurrency.USDT, amount: "2.82", rate: "16000" }, new Decimal("45000")),
    ).not.toThrow();
    expect(() =>
      assertQuotedTotal({ currency: OrderCurrency.USDT, amount: "2.820", rate: "16000" }, new Decimal("45000")),
    ).not.toThrow();
    expect(() =>
      assertQuotedTotal({ currency: OrderCurrency.USDT, amount: "2.81", rate: "16000" }, new Decimal("45000")),
    ).toThrow(QuoteMismatchError);
  });

  it("treats a moved exchange rate as a changed USDT quote", () => {
    // Quoted at 16000 (2.5), now charged at 15000 (40000 / 15000 = 2.666… → 2.67).
    expect(() =>
      assertQuotedTotal({ currency: OrderCurrency.USDT, amount: "2.5", rate: "15000" }, new Decimal("40000")),
    ).toThrow(QuoteMismatchError);
  });
});
