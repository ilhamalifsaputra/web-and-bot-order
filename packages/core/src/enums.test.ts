import { describe, it, expect } from "vitest";
import {
  OrderStatus,
  customerStatusLabel,
  DisplayCurrency,
  DISPLAY_CURRENCIES,
  parseDisplayCurrency,
} from "./enums";

describe("customerStatusLabel", () => {
  it("maps every stored status to one of the 7 customer-facing buckets", () => {
    const expected: Record<string, string> = {
      [OrderStatus.PENDING_PAYMENT]: "status.label.waiting_payment",
      [OrderStatus.PAYMENT_DETECTED]: "status.label.paid",
      [OrderStatus.CONFIRMING]: "status.label.confirming",
      [OrderStatus.CONFIRMED]: "status.label.confirming",
      [OrderStatus.PENDING_VERIFICATION]: "status.label.processing",
      [OrderStatus.PAID]: "status.label.processing",
      [OrderStatus.UNDERPAID]: "status.label.processing",
      [OrderStatus.DELIVERED]: "status.label.delivered",
      [OrderStatus.CANCELLED]: "status.label.failed",
      [OrderStatus.REJECTED]: "status.label.failed",
      [OrderStatus.FAILED]: "status.label.failed",
      [OrderStatus.REFUNDED]: "status.label.refunded",
    };
    for (const [status, label] of Object.entries(expected)) {
      expect(customerStatusLabel(status)).toBe(label);
    }
  });

  it("falls back to 'processing' for an unrecognized status rather than throwing", () => {
    expect(customerStatusLabel("SOME_FUTURE_STATUS")).toBe("status.label.processing");
  });
});

describe("parseDisplayCurrency", () => {
  it("accepts exactly the two stored codes", () => {
    expect(parseDisplayCurrency("USD")).toBe(DisplayCurrency.USD);
    expect(parseDisplayCurrency("IDR")).toBe(DisplayCurrency.IDR);
  });

  it("is case-strict and rejects symbols, other codes and non-strings", () => {
    for (const bad of ["usd", "idr", "Usd", "$", "Rp", "EUR", "USDT", "", " USD", null, undefined, 123, {}]) {
      expect(parseDisplayCurrency(bad)).toBeNull();
    }
  });

  it("DISPLAY_CURRENCIES lists both codes", () => {
    expect([...DISPLAY_CURRENCIES].sort()).toEqual(["IDR", "USD"]);
  });
});
