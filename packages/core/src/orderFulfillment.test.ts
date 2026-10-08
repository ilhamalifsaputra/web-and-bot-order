import { describe, expect, it } from "vitest";
import { customerProgressPhase, getOrderFulfillment } from "./orderFulfillment";

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

describe("customerProgressPhase (Telegram progress message)", () => {
  const stock = { status: "DELIVERED", paidAt: new Date(), fulfillmentProvider: "STOCK", items: [{ product: { deliveryType: "auto" } }] };
  const manual = { status: "PROCESSING", paidAt: new Date(), fulfillmentProvider: "MANUAL", items: [{ product: { deliveryType: "manual" } }] };
  it.each(["PAYMENT_DETECTED", "CONFIRMING", "CONFIRMED"])("%s is a detected payment that is never shown as paid", status => {
    // paidAt may already be stamped inside a settling transaction; status wins.
    expect(customerProgressPhase({ ...order, status, paidAt: new Date() })).toMatchObject({ phase: status === "PAYMENT_DETECTED" ? "PAYMENT_DETECTED" : "VERIFYING", spinner: true, topUp: true });
  });
  it("shows nothing for an order whose payment was never seen", () => {
    expect(customerProgressPhase({ ...order, status: "PENDING_PAYMENT", paidAt: null }).phase).toBe("NONE");
  });
  it("maps the Digiflazz pipeline to queued, submitting and processing spinners", () => {
    expect(customerProgressPhase(order)).toMatchObject({ phase: "AUTO_QUEUED", spinner: true, topUp: true });
    expect(customerProgressPhase({ ...order, digiflazzDispatchedAt: new Date(), digiflazzAttempts: 0 }).phase).toBe("AUTO_SUBMITTING");
    expect(customerProgressPhase({ ...order, digiflazzDispatchedAt: new Date(), digiflazzAttempts: 1 }).phase).toBe("AUTO_PROCESSING");
    expect(customerProgressPhase({ ...order, digiflazzStatus: "failed" })).toMatchObject({ phase: "REVIEW", spinner: false });
  });
  it("uses generic product wording for stock orders", () => {
    expect(customerProgressPhase({ ...stock, status: "PROCESSING" })).toMatchObject({ phase: "PREPARING", spinner: true, topUp: false });
    expect(customerProgressPhase(stock)).toMatchObject({ phase: "SUCCESS", spinner: false, topUp: false });
    expect(customerProgressPhase({ ...order, status: "DELIVERED" })).toMatchObject({ phase: "SUCCESS", spinner: false, topUp: true });
  });
  it("keeps a manual order static before and after a message exists", () => {
    expect(customerProgressPhase(manual, { messageSent: false })).toMatchObject({ phase: "MANUAL_WAITING", spinner: false, progress: null, topUp: false });
    expect(customerProgressPhase(manual, { messageSent: true })).toMatchObject({ phase: "MANUAL_WAITING", spinner: false, topUp: false });
  });
  it("reports failed and cancelled outcomes without a spinner", () => {
    expect(customerProgressPhase({ ...manual, status: "REJECTED" })).toMatchObject({ phase: "FAILED", spinner: false });
    expect(customerProgressPhase({ ...manual, status: "EXPIRED" })).toMatchObject({ phase: "CANCELLED", spinner: false });
  });
  it("says a credited order went to the wallet balance, not that it was simply cancelled", () => {
    expect(customerProgressPhase({ ...manual, status: "CREDITED_TO_BALANCE" })).toMatchObject({ phase: "CREDITED", spinner: false });
    // creditOrderToBalance ends the order CANCELLED; the caller knows a credit row exists.
    expect(customerProgressPhase({ ...manual, status: "CANCELLED" }, { credited: true })).toMatchObject({ phase: "CREDITED", spinner: false });
    expect(customerProgressPhase({ ...manual, status: "CANCELLED" })).toMatchObject({ phase: "CANCELLED", spinner: false });
  });
  it("never shows an underpaid order as a payment still being verified", () => {
    expect(customerProgressPhase({ ...order, status: "UNDERPAID", paidAt: null })).toMatchObject({ phase: "UNDERPAID", spinner: false, progress: null, topUp: true });
  });
});
