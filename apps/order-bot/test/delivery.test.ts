/**
 * settledPaymentBubble / settledPaymentBubbleFor / settledPaymentKb — the
 * shared mapping from a settled order to its payment-bubble text/keyboard
 * (apps/order-bot/src/util/delivery.ts), used by the Refresh button, the
 * background sweeper and the QRIS reconcile pollers alike.
 *
 * Task E1: a WALLET_TOPUP bubble used to render `walletTopupSuccessText`
 * (order code + formatted amount + new balance) — the exact sentence the
 * outbox's WALLET_TOPUP_CREDITED_DM template also renders, which is what let
 * a top-up settled here AND enqueued to the outbox double-notify the buyer.
 * The bubble now renders a neutral status line instead
 * (`checkout.topup_payment_received`); the balance-quoting sentence lives
 * exclusively in the outbox DM. Pure function over static locale JSON — no
 * DB needed.
 */
import { describe, it, expect } from "vitest";
import type { InlineKeyboard } from "grammy";
import { Decimal } from "@app/core/money";
import { OrderKind, OrderStatus } from "@app/core/enums";
import { settledPaymentBubble, settledPaymentBubbleFor, settledPaymentKb } from "../src/util/delivery";

/** Flatten an InlineKeyboard's buttons down to their callback_data, the same
 * shape every other bubble/keyboard test in this suite reads. */
function flatCallbacks(markup: InlineKeyboard): (string | undefined)[] {
  return (markup.inline_keyboard as Array<Array<{ callback_data?: string }>>).flat().map((b) => b.callback_data);
}

const walletUser = (over: Partial<{ language: string; walletBalance: Decimal.Value; walletBalanceUsdt: Decimal.Value }> = {}) => ({
  language: "en",
  walletBalance: "0",
  walletBalanceUsdt: "0",
  ...over,
});

describe("settledPaymentBubble — WALLET_TOPUP", () => {
  it("renders a neutral 'payment received' status line, not a balance-quoting success sentence", () => {
    const order = {
      orderCode: "TOPUP-IDR-1",
      kind: OrderKind.WALLET_TOPUP,
      status: OrderStatus.DELIVERED,
      currency: "IDR",
      totalAmount: new Decimal("50000"),
      user: walletUser({ walletBalance: "125000" }),
    };

    const { text } = settledPaymentBubble(order);

    expect(text).toContain("Payment received");
    expect(text).toContain("top-up has been credited");
    // Never the order code, the credited amount, or the new balance — those
    // now live exclusively in the outbox's WALLET_TOPUP_CREDITED_DM.
    expect(text).not.toContain("TOPUP-IDR-1");
    expect(text).not.toContain("Rp50.000");
    expect(text).not.toContain("Rp125.000");
    expect(text).not.toMatch(/top-?up successful/i);
  });

  it("gives every WALLET_TOPUP order the wallet keyboard, regardless of status", () => {
    const order = {
      orderCode: "TOPUP-2",
      kind: OrderKind.WALLET_TOPUP,
      status: OrderStatus.PROCESSING,
      currency: "USDT",
      totalAmount: new Decimal("10"),
      user: walletUser(),
    };

    const { markup } = settledPaymentBubble(order);
    const flat = flatCallbacks(markup);
    expect(flat).toContain("v1:topup:open");
    expect(flat).not.toContain("v1:order:list");
  });

  it("localizes into Indonesian when lang is 'id'", () => {
    const order = {
      orderCode: "TOPUP-ID-1",
      kind: OrderKind.WALLET_TOPUP,
      status: OrderStatus.DELIVERED,
      currency: "USDT",
      totalAmount: new Decimal("5"),
      user: walletUser({ language: "id" }),
    };

    const { text } = settledPaymentBubble(order);

    expect(text).toContain("Pembayaran diterima");
    expect(text).toContain("top up kamu sudah masuk");
  });

  it("stays identical no matter which currency or balance the order/buyer carry — the neutral text interpolates nothing money-related", () => {
    const base = {
      orderCode: "TOPUP-X",
      kind: OrderKind.WALLET_TOPUP,
      status: OrderStatus.DELIVERED,
      user: walletUser(),
    };
    const idr = settledPaymentBubble({ ...base, currency: "IDR", totalAmount: new Decimal("999999") });
    const usdt = settledPaymentBubble({ ...base, currency: "USDT", totalAmount: new Decimal("0.0001") });
    expect(idr.text).toBe(usdt.text);
  });
});

describe("settledPaymentBubble — PRODUCT (regression: must not be reworded by the WALLET_TOPUP change)", () => {
  const productOrder = (status: string) => ({
    orderCode: "PROD-1",
    kind: OrderKind.PRODUCT,
    status,
    currency: "IDR",
    totalAmount: new Decimal("50000"),
    user: walletUser(),
  });

  it("DELIVERED — items are on their way, order code included, product keyboard", () => {
    const { text, markup } = settledPaymentBubble(productOrder(OrderStatus.DELIVERED));
    expect(text).toContain("PROD-1");
    expect(text).toContain("being delivered now");
    expect(flatCallbacks(markup)).not.toContain("v1:topup:open");
  });

  it("PROCESSING — manual fulfilment notice, order code included, product keyboard", () => {
    const { text, markup } = settledPaymentBubble(productOrder(OrderStatus.PROCESSING));
    expect(text).toContain("PROD-1");
    expect(text).toContain("being prepared for delivery manually");
    expect(flatCallbacks(markup)).not.toContain("v1:topup:open");
  });
});

describe("settledPaymentKb", () => {
  it("picks the wallet keyboard for WALLET_TOPUP and the product keyboard for PRODUCT", () => {
    const walletFlat = flatCallbacks(settledPaymentKb(OrderKind.WALLET_TOPUP, "en"));
    const productFlat = flatCallbacks(settledPaymentKb(OrderKind.PRODUCT, "en"));
    expect(walletFlat).toContain("v1:topup:open");
    expect(productFlat).not.toContain("v1:topup:open");
  });
});

describe("settledPaymentBubbleFor", () => {
  it("delegates to settledPaymentBubble using the row's own kind/status/orderCode", () => {
    const row = {
      orderCode: "TOPUP-ROW-1",
      kind: OrderKind.WALLET_TOPUP,
      status: OrderStatus.DELIVERED,
      currency: "USDT",
      totalAmount: new Decimal("1"),
      user: { language: "en" },
    };

    const withBuyer = settledPaymentBubbleFor(row, { walletBalance: "999", walletBalanceUsdt: "999" });
    const withoutBuyer = settledPaymentBubbleFor(row, null);

    // The neutral top-up text interpolates no balance at all, so a missing
    // buyer read (the `null` fallback path) renders identically to a
    // successful one.
    expect(withBuyer.text).toBe(withoutBuyer.text);
    expect(withBuyer.text).toContain("Payment received");
  });

  it("still reflects a PRODUCT order's own status/order code with no buyer read needed", () => {
    const row = {
      orderCode: "PROD-ROW-1",
      kind: OrderKind.PRODUCT,
      status: OrderStatus.DELIVERED,
      currency: "IDR",
      totalAmount: new Decimal("10000"),
      user: { language: "en" },
    };

    const { text } = settledPaymentBubbleFor(row, null);
    expect(text).toContain("PROD-ROW-1");
    expect(text).toContain("being delivered now");
  });
});
