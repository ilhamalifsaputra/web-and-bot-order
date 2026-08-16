/**
 * settledPaymentBubble / settledPaymentKb — the shared mapping from a settled
 * order to its payment-bubble text/keyboard (apps/order-bot/src/util/
 * delivery.ts), used by the Refresh button, the background sweeper, the QRIS
 * reconcile pollers and the three crypto rails' own fast paths alike.
 *
 * Task E1: a WALLET_TOPUP bubble used to render `walletTopupSuccessText`
 * (order code + formatted amount + new balance) — the exact sentence the
 * outbox's WALLET_TOPUP_CREDITED_DM template also renders, which is what let
 * a top-up settled here AND enqueued to the outbox double-notify the buyer.
 * The bubble now renders a neutral status line instead
 * (`checkout.topup_payment_received`); the balance-quoting sentence lives
 * exclusively in the outbox DM. Pure function over static locale JSON — no
 * DB needed.
 *
 * Review follow-up (same task): the wrapper this file used to also cover,
 * `settledPaymentBubbleFor`, existed only to merge a live buyer-balance read
 * into the bubble. Once the balance-quoting sentence moved out to the outbox
 * DM above, nothing read that merged balance any more, so the wrapper (and
 * its buyer-fallback tests) were deleted along with it — every caller now
 * calls `settledPaymentBubble` directly with its order row, which is exactly
 * what the tests below already exercise.
 */
import { describe, it, expect } from "vitest";
import type { InlineKeyboard } from "grammy";
import { OrderKind, OrderStatus } from "@app/core/enums";
import { settledPaymentBubble, settledPaymentKb, bubbleOnPhotoFor } from "../src/util/delivery";

/** Flatten an InlineKeyboard's buttons down to their callback_data, the same
 * shape every other bubble/keyboard test in this suite reads. */
function flatCallbacks(markup: InlineKeyboard): (string | undefined)[] {
  return (markup.inline_keyboard as Array<Array<{ callback_data?: string }>>).flat().map((b) => b.callback_data);
}

const walletUser = (over: Partial<{ language: string }> = {}) => ({
  language: "en",
  ...over,
});

describe("settledPaymentBubble — WALLET_TOPUP", () => {
  it("renders a neutral 'payment received' status line, not a balance-quoting success sentence", () => {
    const order = {
      orderCode: "TOPUP-IDR-1",
      kind: OrderKind.WALLET_TOPUP,
      status: OrderStatus.DELIVERED,
      user: walletUser(),
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
      user: walletUser({ language: "id" }),
    };

    const { text } = settledPaymentBubble(order);

    expect(text).toContain("Pembayaran diterima");
    expect(text).toContain("top up kamu sudah masuk");
  });

  it("stays identical no matter which order code the top-up carries — the neutral text interpolates nothing money- or order-related", () => {
    // `SettledBubbleOrder` (util/delivery.ts) no longer even has a
    // `currency`/`totalAmount` field to vary — nothing has read either since
    // Task E1 (see that type's own doc-comment) — so the strongest remaining
    // proof that the WALLET_TOPUP branch interpolates nothing is that two
    // orders differing only in `orderCode` render byte-identical text.
    const base = {
      kind: OrderKind.WALLET_TOPUP,
      status: OrderStatus.DELIVERED,
      user: walletUser(),
    };
    const first = settledPaymentBubble({ ...base, orderCode: "TOPUP-X" });
    const second = settledPaymentBubble({ ...base, orderCode: "TOPUP-Y" });
    expect(first.text).toBe(second.text);
  });
});

describe("settledPaymentBubble — PRODUCT (regression: must not be reworded by the WALLET_TOPUP change)", () => {
  const productOrder = (status: string) => ({
    orderCode: "PROD-1",
    kind: OrderKind.PRODUCT,
    status,
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

// Task E2: the canonical `onPhoto` choice every editPaymentBubble call site
// derives from `order.kind` through this one function, so none of them can
// drift apart on which order kind gets its QR silently deleted vs. replaced.
// Since Task E3 there is exactly one caller of editPaymentBubble left —
// `flipSettledOrderBubble` (jobs/index.ts) — shared by flipSettledBubble, the
// paid-order bubble sweep, the three reconcile pollers, and the
// payment-bubble flush hook alike.
describe("bubbleOnPhotoFor", () => {
  it("tells a settled WALLET_TOPUP's photo bubble to be deleted, carrying no fallback DM target", () => {
    // `toEqual` already pins the absence of `fallbackDm`. That the combination
    // is *unrepresentable* is a type-level guarantee (`editPaymentBubble`'s
    // argument union), which no runtime assertion here could demonstrate.
    expect(bubbleOnPhotoFor(OrderKind.WALLET_TOPUP)).toEqual({ onPhoto: "delete" });
  });

  it("tells a settled PRODUCT order's photo bubble to be replaced, with no fallback DM", () => {
    expect(bubbleOnPhotoFor(OrderKind.PRODUCT)).toEqual({ onPhoto: "replace", fallbackDm: null });
  });
});
