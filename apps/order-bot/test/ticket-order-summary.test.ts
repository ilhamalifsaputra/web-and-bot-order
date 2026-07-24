// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { describe, it, expect } from "vitest";
import { OrderStatus } from "@app/core/enums";
import { summarizeTicketOrder, type TicketOrderLike } from "../src/util/format";

const baseItem = {
  productId: 1,
  quantity: 1,
  unitPrice: "45000",
  product: { id: 1, name: "Smoke Test Netflix", durationLabel: "1 month" },
};

const baseOrder: TicketOrderLike = {
  orderCode: "ORD-TICK-1",
  status: OrderStatus.DELIVERED,
  deliveredAt: new Date(),
  items: [{ ...baseItem, warrantyDaysSnapshot: 30 }],
};

describe("summarizeTicketOrder", () => {
  it("marks warranty active when delivered within the warranty window", () => {
    const s = summarizeTicketOrder(baseOrder);
    expect(s.orderCode).toBe("ORD-TICK-1");
    expect(s.productLine).toContain("Smoke Test Netflix");
    expect(s.warranty).not.toBeNull();
    expect(s.warranty!.active).toBe(true);
  });

  it("marks warranty expired when the delivery date is well past the warranty window", () => {
    const deliveredAt = new Date(Date.now() - 60 * 86_400_000); // 60 days ago
    const s = summarizeTicketOrder({ ...baseOrder, deliveredAt, items: [{ ...baseItem, warrantyDaysSnapshot: 30 }] });
    expect(s.warranty!.active).toBe(false);
  });

  it("returns warranty: null for an order that hasn't been delivered yet", () => {
    const s = summarizeTicketOrder({ ...baseOrder, status: OrderStatus.PROCESSING, deliveredAt: null });
    expect(s.warranty).toBeNull();
  });

  it("returns warranty: null when status is DELIVERED but deliveredAt is somehow null", () => {
    const s = summarizeTicketOrder({ ...baseOrder, deliveredAt: null });
    expect(s.warranty).toBeNull();
  });

  it("builds the status badge via the existing statusBadge helper", () => {
    const s = summarizeTicketOrder(baseOrder);
    expect(s.statusBadge).toContain("DELIVERED");
  });

  it("escapes HTML-significant characters in the product name", () => {
    const s = summarizeTicketOrder({
      ...baseOrder,
      items: [{ ...baseItem, product: { ...baseItem.product, name: "A & B <Plan>" }, warrantyDaysSnapshot: 30 }],
    });
    expect(s.productLine).not.toContain("<Plan>");
    expect(s.productLine).toContain("&amp;");
  });
});
