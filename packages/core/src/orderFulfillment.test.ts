import { describe, expect, it } from "vitest";
import { getOrderFulfillment } from "./orderFulfillment";

const order = { status: "PROCESSING", paidAt: new Date(), fulfillmentProvider: "DIGIFLAZZ", items: [{ product: { autoDeliverySource: "digiflazz", deliveryType: "manual_with_info" } }] };
describe("canonical fulfillment state", () => {
  it("describes money returned to credit balance as refunded payment", () => {
    expect(getOrderFulfillment({ ...order, status: "CREDITED_TO_BALANCE" })).toMatchObject({ status: "CANCELLED", payment_status: "REFUNDED" });
  });
  it("routes explicit Digiflazz independently of input/delivery type", () => {
    expect(getOrderFulfillment(order)).toMatchObject({ mode: "AUTO", provider: "DIGIFLAZZ", status: "QUEUED", payment_status: "PAID", can_edit_customer_data: true });
  });
  it("locks edits and reports submitting once dispatched", () => {
    expect(getOrderFulfillment({ ...order, digiflazzDispatchedAt: new Date(), digiflazzAttempts: 0 })).toMatchObject({ status: "SUBMITTING", can_edit_customer_data: false });
  });
  it("reports supplier pending after the first outcome and review after terminal failure", () => {
    expect(getOrderFulfillment({ ...order, digiflazzDispatchedAt: new Date(), digiflazzAttempts: 1, digiflazzStatus: "pending_at_supplier" }).status).toBe("PROCESSING");
    expect(getOrderFulfillment({ ...order, digiflazzStatus: "failed" }).status).toBe("NEEDS_REVIEW");
  });
  it("delivery takes precedence over stale supplier fields", () => {
    expect(getOrderFulfillment({ ...order, status: "DELIVERED", digiflazzStatus: "failed" })).toMatchObject({ status: "SUCCESS", can_edit_customer_data: false });
  });
  it("does not classify a snapshotted manual order from a later provider edit", () => {
    expect(getOrderFulfillment({ ...order, fulfillmentProvider: "MANUAL" })).toMatchObject({ mode: "MANUAL", provider: "MANUAL", status: "QUEUED" });
  });
  it("reports pending payment instead of starting fulfillment", () => {
    expect(getOrderFulfillment({ ...order, paidAt: null, status: "PENDING_PAYMENT" })).toMatchObject({ status: "NOT_STARTED", payment_status: "PENDING", can_edit_customer_data: false });
  });
});
