import { describe, expect, it } from "vitest";
import { fulfillmentPresentation } from "./orderFulfillment";
describe("terminal fulfillment presentation", () => {
  it("shows cancellation even when no payment arrived", () => {
    expect(fulfillmentPresentation({ mode: "AUTO", provider: "DIGIFLAZZ", status: "CANCELLED", payment_status: "PENDING", can_edit_customer_data: false }).badge).toBe("cancelled");
  });
});

describe("manual-only copy keys", () => {
  const statuses = ["NOT_STARTED", "QUEUED", "SUBMITTING", "PROCESSING", "SUCCESS", "FAILED", "NEEDS_REVIEW", "CANCELLED"] as const;
  it("never routes an AUTO or Digiflazz fulfillment to the manual waiting keys", () => {
    for (const status of statuses) {
      for (const provider of ["DIGIFLAZZ", "STOCK"] as const) {
        const p = fulfillmentPresentation({ mode: "AUTO", provider, status, payment_status: "PAID", can_edit_customer_data: false });
        expect(p.titleKey).not.toBe("web.order_processing_title");
        expect(p.bodyKey).not.toBe("web.order_processing_body");
      }
    }
  });
  it("uses the manual waiting keys for a paid MANUAL order awaiting preparation", () => {
    const p = fulfillmentPresentation({ mode: "MANUAL", provider: "MANUAL", status: "QUEUED", payment_status: "PAID", can_edit_customer_data: true });
    expect(p.titleKey).toBe("web.order_processing_title");
  });
});

describe("manual orders never spin", () => {
  it.each(["NOT_STARTED", "QUEUED", "SUBMITTING", "PROCESSING"] as const)("a paid MANUAL order %s is a static wait, not an active spinner", (status) => {
    const p = fulfillmentPresentation({ mode: "MANUAL", provider: "MANUAL", status, payment_status: "PAID", can_edit_customer_data: true });
    expect(p.active).toBe(false);
    expect(p.waiting).toBe(true);
  });
  it("an automatic order in flight still spins", () => {
    const p = fulfillmentPresentation({ mode: "AUTO", provider: "DIGIFLAZZ", status: "PROCESSING", payment_status: "PAID", can_edit_customer_data: false });
    expect(p.active).toBe(true);
    expect(p.waiting).toBe(false);
  });
});
