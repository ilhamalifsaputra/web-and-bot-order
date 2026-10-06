import { describe, expect, it } from "vitest";
import { fulfillmentPresentation } from "./orderFulfillment";
describe("terminal fulfillment presentation", () => {
  it("shows cancellation even when no payment arrived", () => {
    expect(fulfillmentPresentation({ mode: "AUTO", provider: "DIGIFLAZZ", status: "CANCELLED", payment_status: "PENDING", can_edit_customer_data: false }).badge).toBe("cancelled");
  });
});
