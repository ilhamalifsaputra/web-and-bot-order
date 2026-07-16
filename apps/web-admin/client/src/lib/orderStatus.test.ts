import { describe, it, expect } from "vitest";
import { ORDER_STATUS_LABELS, orderStatusLabel } from "./orderStatus";

describe("orderStatus", () => {
  it("maps every documented backend status to a human-readable label (F-003)", () => {
    const statuses = [
      "PENDING_PAYMENT",
      "PAYMENT_DETECTED",
      "CONFIRMING",
      "CONFIRMED",
      "PENDING_VERIFICATION",
      "PAID",
      "PROCESSING",
      "DELIVERED",
      "CANCELLED",
      "REJECTED",
      "REFUNDED",
      "UNDERPAID",
      "FAILED",
    ];
    for (const status of statuses) {
      expect(ORDER_STATUS_LABELS[status]).toBeTruthy();
      // No label should still be SCREAMING_SNAKE_CASE / contain an underscore.
      expect(ORDER_STATUS_LABELS[status]).not.toMatch(/_/);
      expect(orderStatusLabel(status)).toBe(ORDER_STATUS_LABELS[status]);
    }
  });

  it("falls back to the raw value for an unmapped status", () => {
    expect(orderStatusLabel("SOME_NEW_STATUS")).toBe("SOME_NEW_STATUS");
  });
});
