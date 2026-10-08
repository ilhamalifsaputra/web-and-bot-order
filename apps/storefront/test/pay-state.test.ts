import "./setup-env"; // FIRST import — sets env before @app/* load
import { describe, expect, it } from "vitest";
import { OrderStatus } from "@app/core/enums";
import { payState } from "../src/routes/checkout";
import { customerProgressPhase, paymentStatusFor } from "@app/core/orderFulfillment";

type PayStateInput = Parameters<typeof payState>[0];
const order = (status: string, expiresAt: Date | null = null) =>
  ({ status, expiresAt }) as unknown as PayStateInput;

describe("payState", () => {
  it.each([OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.FAILED, OrderStatus.REJECTED])(
    "closes a %s transaction even when its payment was previously confirmed",
    (status) => {
      const paid = { ...order(status), paymentState: "PAID", paidAt: new Date() };
      expect(payState(paid)).toBe("closed");
    },
  );

  it("keeps a paid wallet credit failure visible as a static review without losing its payment fact", () => {
    const wallet = { ...order(OrderStatus.PENDING_PAYMENT), kind: "WALLET_TOPUP", paymentState: "PAID", walletCreditState: "NEEDS_REVIEW", items: [] };
    expect(payState(wallet)).toBe("processing");
    expect(paymentStatusFor(wallet)).toBe("PAID");
    expect(customerProgressPhase(wallet)).toMatchObject({ phase: "REVIEW", spinner: false, progress: null });
  });

  it("shows review for a verified late wallet payment after cancellation until credited or refunded", () => {
    const lateWallet = { ...order(OrderStatus.CANCELLED), kind: "WALLET_TOPUP", paymentState: "PAID", walletCreditState: "NEEDS_REVIEW", items: [] };
    expect(payState(lateWallet)).toBe("processing");
    expect(paymentStatusFor(lateWallet)).toBe("PAID");
    expect(customerProgressPhase(lateWallet)).toMatchObject({ phase: "REVIEW", spinner: false, progress: null });
    expect(payState({ ...lateWallet, status: OrderStatus.REFUNDED })).toBe("closed");
    expect(customerProgressPhase({ ...lateWallet, status: OrderStatus.REFUNDED })).toMatchObject({ phase: "CANCELLED", spinner: false });
    expect(payState({ ...lateWallet, status: OrderStatus.DELIVERED, walletCreditState: "CREDITED" })).toBe("delivered");
    expect(customerProgressPhase({ ...lateWallet, status: OrderStatus.DELIVERED, walletCreditState: "CREDITED" })).toMatchObject({ phase: "WALLET_CREDITED", spinner: false });
  });

  it("reports a paid order waiting on fulfillment as 'processing', not blockchain 'confirming'", () => {
    expect(payState(order(OrderStatus.PROCESSING))).toBe("processing");
  });

  it.each([
    OrderStatus.PENDING_VERIFICATION,
    OrderStatus.PAYMENT_DETECTED,
    OrderStatus.CONFIRMING,
    OrderStatus.CONFIRMED,
  ])("keeps %s as 'confirming'", (status) => {
    expect(payState(order(status))).toBe("confirming");
  });

  it("maps the remaining states", () => {
    expect(payState(order(OrderStatus.PAID))).toBe("processing");
    expect(payState(order(OrderStatus.UNDERPAID))).toBe("underpaid");
    expect(payState(order(OrderStatus.DELIVERED))).toBe("delivered");
    expect(payState(order(OrderStatus.PENDING_PAYMENT))).toBe("waiting");
    expect(payState(order(OrderStatus.PENDING_PAYMENT, new Date(Date.now() - 1000)))).toBe("expired");
    expect(payState(order(OrderStatus.CANCELLED))).toBe("closed");
  });
});
