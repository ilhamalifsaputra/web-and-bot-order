import { describe, expect, it } from "vitest";
import { customerProgressPhase, getCustomerFacingReference, getOrderFulfillment } from "./orderFulfillment";

const order = { status: "PENDING_PAYMENT", paidAt: null, fulfillmentProvider: "DIGIFLAZZ", items: [] };
describe("canonical transaction presentation", () => {
  it("keeps waiting and human actions static", () => {
    expect(customerProgressPhase(order)).toMatchObject({ spinner: false, progress: null });
    expect(customerProgressPhase({ ...order, status: "UNDERPAID" })).toMatchObject({ phase: "UNDERPAID", spinner: false, progress: null });
    expect(customerProgressPhase({ ...order, status: "PENDING_VERIFICATION" })).toMatchObject({ spinner: false, progress: null });
    expect(customerProgressPhase({ ...order, status: "PROCESSING", paidAt: new Date(), fulfillmentProvider: "MANUAL" })).toMatchObject({ phase: "MANUAL_WAITING", spinner: false, progress: null });
  });
  it.each([
    ["PAYMENT_DETECTED", null], ["CONFIRMING", null], ["CONFIRMED", null], ["PAID", 40],
  ])("uses factual %s payment phase (no percentage until the payment is verified)", (status, progress) => {
    expect(customerProgressPhase({ ...order, status })).toMatchObject({ progress, spinner: true });
  });
  it("maps provider work to fixed backend phases", () => {
    const active = { ...order, status: "PROCESSING", paidAt: new Date() };
    expect(customerProgressPhase(active).progress).toBe(55);
    expect(customerProgressPhase({ ...active, digiflazzDispatchedAt: new Date() }).progress).toBe(65);
    expect(customerProgressPhase({ ...active, digiflazzDispatchedAt: new Date(), digiflazzAttempts: 1 }).progress).toBe(80);
    expect(customerProgressPhase({ ...active, status: "DELIVERED" })).toMatchObject({ progress: 100, spinner: false });
    expect(customerProgressPhase({ ...active, digiflazzStatus: "failed" })).toMatchObject({ progress: null, spinner: false });
  });
  it("never presents an admin override as a fully paid provider payment", () => {
    const override = { ...order, status: "DELIVERED", paidAt: new Date(), paymentState: "UNDERPAID", completionMode: "ADMIN_OVERRIDE" };
    expect(getOrderFulfillment(override).payment_status).toBe("UNDERPAID");
    expect(customerProgressPhase(override)).toMatchObject({ phase: "SUCCESS", spinner: false, progress: null });
  });
  it("distinguishes payment and wallet credit failures", () => {
    const wallet = { ...order, kind: "WALLET_TOPUP", paymentState: "PAID", walletCreditState: "NEEDS_REVIEW" };
    expect(getOrderFulfillment(wallet).payment_status).toBe("PAID");
    expect(customerProgressPhase(wallet)).toMatchObject({ phase: "REVIEW", transactionType: "WALLET_TOPUP", progress: null, spinner: false });
    expect(customerProgressPhase({ ...wallet, walletCreditState: "CREDITING" }).progress).toBe(80);
    expect(customerProgressPhase({ ...wallet, status: "DELIVERED", walletCreditState: "CREDITED" })).toMatchObject({ phase: "WALLET_CREDITED", progress: 100, spinner: false });
  });
  it("uses catalog type independently of the fulfillment supplier", () => {
    const premium = { ...order, items: [{ product: { product: { category: { group: "PREMIUM_APPS" } }, autoDeliverySource: "digiflazz" } }] };
    expect(customerProgressPhase(premium)).toMatchObject({ transactionType: "PREMIUM_APPS", topUp: false });
  });
  it("keeps a late paid wallet credit failure visible after cancellation", () => {
    const wallet = { ...order, status: "CANCELLED", kind: "WALLET_TOPUP", paymentState: "PAID", walletCreditState: "NEEDS_REVIEW" };
    expect(getOrderFulfillment(wallet)).toMatchObject({ payment_status: "PAID", status: "NEEDS_REVIEW", presentation: { phase: "REVIEW", progress: null, spinner: false } });
    expect(customerProgressPhase({ ...wallet, status: "REFUNDED" }).phase).toBe("CANCELLED");
    expect(customerProgressPhase({ ...wallet, status: "CREDITED_TO_BALANCE" }).phase).toBe("CREDITED");
    expect(customerProgressPhase(wallet, { credited: true }).phase).toBe("CREDITED");
  });
  it("retains the full existing reference in every state", () => {
    const orderCode = "WLT-20261008-0000019284";
    for (const status of ["PENDING_PAYMENT", "PAYMENT_DETECTED", "CONFIRMING", "UNDERPAID", "PAID", "DELIVERED"]) {
      expect(getCustomerFacingReference({ kind: "WALLET_TOPUP", orderCode, status })).toBe(orderCode);
    }
  });
});
