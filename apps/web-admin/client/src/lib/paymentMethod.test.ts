import { describe, it, expect } from "vitest";
import { PAYMENT_METHOD_LABELS, paymentMethodLabel } from "./paymentMethod";

describe("paymentMethod", () => {
  it("maps every documented backend payment method to a human-readable label", () => {
    const methods = [
      "BINANCE_PAY",
      "BINANCE_INTERNAL",
      "BYBIT",
      "BYBIT_BSC",
      "TOKOPAY",
      "PAYDISINI",
      "NOWPAYMENTS",
      "WALLET",
    ];
    for (const method of methods) {
      expect(PAYMENT_METHOD_LABELS[method]).toBeTruthy();
      // No label should still be SCREAMING_SNAKE_CASE.
      expect(PAYMENT_METHOD_LABELS[method]).not.toMatch(/_/);
      expect(paymentMethodLabel(method)).toBe(PAYMENT_METHOD_LABELS[method]);
    }
  });

  it("falls back to the raw value for an unmapped method", () => {
    expect(paymentMethodLabel("SOME_NEW_RAIL")).toBe("SOME_NEW_RAIL");
  });
});
