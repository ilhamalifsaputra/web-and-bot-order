import { describe, it, expect } from "vitest";
import { summarizeTicketOrder } from "./ticketOrderSummary";

const item = (id: number, quantity: number, unitPrice: string, pid: number, name: string) => ({
  id,
  quantity,
  unitPrice,
  product: { id: pid, name },
});

describe("summarizeTicketOrder", () => {
  it("groups by product and unit price, summing units, in insertion order", () => {
    const s = summarizeTicketOrder({
      items: [item(1, 1, "18000", 7, "Diamonds"), item(2, 1, "5000", 8, "Pass"), item(3, 1, "18000", 7, "Diamonds")],
      totalAmount: "41000",
      currency: "IDR",
    });
    expect(s.lines).toEqual([
      { name: "Diamonds", units: 2, unitPriceText: "2 units · Rp18.000 each" },
      { name: "Pass", units: 1, unitPriceText: "Rp5.000" },
    ]);
    expect(s.totalText).toBe("Rp41.000");
  });

  it("keeps the same product at different prices as separate lines", () => {
    const s = summarizeTicketOrder({
      items: [item(1, 1, "10", 7, "A"), item(2, 3, "12", 7, "A")],
      totalAmount: "46",
      currency: "USD",
    });
    expect(s.lines.map((l) => l.unitPriceText)).toEqual(["10.00 USD", "3 units · 12.00 USD each"]);
  });

  it("falls back to raw value plus code for an unknown currency", () => {
    const s = summarizeTicketOrder({ items: [item(1, 1, "5", 1, "A")], totalAmount: "5", currency: "EUR" });
    expect(s.lines[0]!.unitPriceText).toBe("5 EUR");
    expect(s.totalText).toBe("5 EUR");
  });
});
