import "./setup-env"; // FIRST import — sets env before @app/* load
import { describe, expect, it } from "vitest";
import { OrderStatus } from "@app/core/enums";
import { payState } from "../src/routes/checkout";

type PayStateInput = Parameters<typeof payState>[0];
const order = (status: string, expiresAt: Date | null = null) =>
  ({ status, expiresAt }) as unknown as PayStateInput;

describe("payState", () => {
  it("reports a paid order waiting on fulfillment as 'processing', not blockchain 'confirming'", () => {
    expect(payState(order(OrderStatus.PROCESSING))).toBe("processing");
  });

  it.each([
    OrderStatus.PENDING_VERIFICATION,
    OrderStatus.PAID,
    OrderStatus.PAYMENT_DETECTED,
    OrderStatus.CONFIRMING,
    OrderStatus.CONFIRMED,
  ])("keeps %s as 'confirming'", (status) => {
    expect(payState(order(status))).toBe("confirming");
  });

  it("maps the remaining states", () => {
    expect(payState(order(OrderStatus.DELIVERED))).toBe("delivered");
    expect(payState(order(OrderStatus.PENDING_PAYMENT))).toBe("waiting");
    expect(payState(order(OrderStatus.PENDING_PAYMENT, new Date(Date.now() - 1000)))).toBe("expired");
    expect(payState(order(OrderStatus.CANCELLED))).toBe("closed");
  });
});
