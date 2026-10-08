import { describe, expect, it } from "vitest";
import { customerProgressPhase, progressForPhase } from "@app/core/orderFulfillment";
import { renderTransactionStatusMessage } from "./transactionMessage";

const order = { status: "PENDING_PAYMENT", paidAt: null, fulfillmentProvider: "DIGIFLAZZ", items: [] };
const render = (status: string, lang = "en") => renderTransactionStatusMessage({
  orderCode: "ORD-1", presentation: customerProgressPhase({ ...order, status }), lang, frame: "⣾", amount: "Rp10.000",
});

describe("progress bar before the payment is verified", () => {
  it("has no percentage for a detected or verifying payment", () => {
    expect(progressForPhase("PAYMENT_DETECTED")).toBeNull();
    expect(progressForPhase("VERIFYING")).toBeNull();
  });
  it.each([["PAYMENT_DETECTED", "en"], ["CONFIRMING", "en"], ["PAYMENT_DETECTED", "id"], ["CONFIRMING", "id"]])("renders %s (%s) with the spinner but no bar or percent", (status, lang) => {
    const text = render(status, lang);
    expect(text).toContain("⣾");
    expect(text).not.toMatch(/[█░%]/u);
  });
  it("still shows the bar once the payment is confirmed", () => {
    const text = render("PAID");
    expect(text).toContain("40%");
    expect(text).toMatch(/█+░+ 40%/u);
  });
});
