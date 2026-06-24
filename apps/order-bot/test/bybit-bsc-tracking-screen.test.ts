// setup-db MUST be first — temp DB + push before any @app import (renderBybitBscTrackingScreen
// goes through coreT, which reads the locale files — no DB needed, but the
// shared setup keeps env consistent with every other order-bot test).
import "./setup-db";

import { describe, it, expect } from "vitest";
import { OrderStatus } from "@app/core/enums";
import { renderBybitBscTrackingScreen, statusBadge } from "../src/util/format";
import { bybitBscTrackingKb } from "../src/keyboards/customer";

const base = {
  orderCode: "ORD-20260624-TEST",
  network: "BSC" as string | null,
  confirmations: null as number | null,
  requiredConfirmations: null as number | null,
};

describe("renderBybitBscTrackingScreen", () => {
  it("shows the awaiting-count note when confirmations is null (no fabricated number)", () => {
    const text = renderBybitBscTrackingScreen({ ...base, status: OrderStatus.PAYMENT_DETECTED }, "en");
    expect(text).toContain("Waiting for the first on-chain confirmation");
    expect(text).not.toMatch(/\d+\/\d+/); // no "x/y" count anywhere
  });

  it("shows a real 'x/y' confirmation count + progress bar once confirmations is set", () => {
    const text = renderBybitBscTrackingScreen(
      { ...base, status: OrderStatus.CONFIRMING, confirmations: 6, requiredConfirmations: 15 },
      "en",
    );
    expect(text).toContain("6/15");
    expect(text).toContain("█");
    expect(text).toContain("░");
  });

  it("falls back to a required-confirmations default of 15 when the order's own field is null", () => {
    const text = renderBybitBscTrackingScreen(
      { ...base, status: OrderStatus.CONFIRMING, confirmations: 3, requiredConfirmations: null },
      "en",
    );
    expect(text).toContain("3/15");
  });

  it("marks every stage before the current one done (✅), the current one in-progress (⏳), the rest pending (⬜)", () => {
    const text = renderBybitBscTrackingScreen({ ...base, status: OrderStatus.CONFIRMING, confirmations: 1 }, "en");
    const ROW_LABELS = ["Payment Detected", "Confirming", "Confirmed", "Delivered"];
    const lines = text.split("\n").filter((l) => ROW_LABELS.some((label) => l.endsWith(label)));
    expect(lines).toEqual([
      "✅ Payment Detected",
      "⏳ Confirming",
      "⬜ Confirmed",
      "⬜ Delivered",
    ]);
  });

  it("PAYMENT_DETECTED: only the first row is in-progress, nothing done yet", () => {
    const text = renderBybitBscTrackingScreen({ ...base, status: OrderStatus.PAYMENT_DETECTED }, "en");
    const ROW_LABELS = ["Payment Detected", "Confirming", "Confirmed", "Delivered"];
    const lines = text.split("\n").filter((l) => ROW_LABELS.some((label) => l.endsWith(label)));
    expect(lines).toEqual([
      "⏳ Payment Detected",
      "⬜ Confirming",
      "⬜ Confirmed",
      "⬜ Delivered",
    ]);
  });

  it("CONFIRMED: first two rows done, Confirmed in-progress, Delivered still pending", () => {
    const text = renderBybitBscTrackingScreen({ ...base, status: OrderStatus.CONFIRMED, confirmations: 15, requiredConfirmations: 15 }, "en");
    const ROW_LABELS = ["Payment Detected", "Confirming", "Confirmed", "Delivered"];
    const lines = text.split("\n").filter((l) => ROW_LABELS.some((label) => l.endsWith(label)));
    expect(lines).toEqual([
      "✅ Payment Detected",
      "✅ Confirming",
      "⏳ Confirmed",
      "⬜ Delivered",
    ]);
  });

  it("includes the order code, asset, network, and status badge", () => {
    const text = renderBybitBscTrackingScreen({ ...base, status: OrderStatus.CONFIRMING, network: "BSC" }, "en");
    expect(text).toContain("ORD-20260624-TEST");
    expect(text).toContain("USDT");
    expect(text).toContain("BSC");
    expect(text).toContain(statusBadge(OrderStatus.CONFIRMING));
  });

  it("falls back to 'BSC' when the order's own network field is null", () => {
    const text = renderBybitBscTrackingScreen({ ...base, status: OrderStatus.PAYMENT_DETECTED, network: null }, "en");
    expect(text).toContain("Network: BSC");
  });

  it("renders without throwing in both en and id for every in-flight status", () => {
    for (const lang of ["en", "id"]) {
      for (const status of [OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING, OrderStatus.CONFIRMED]) {
        expect(() => renderBybitBscTrackingScreen({ ...base, status, confirmations: 5, requiredConfirmations: 15 }, lang)).not.toThrow();
      }
    }
  });
});

describe("bybitBscTrackingKb", () => {
  it("shows Refresh + Menu, but never Cancel, for the statuses this screen actually renders", () => {
    for (const status of [OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING, OrderStatus.CONFIRMED]) {
      const kb = bybitBscTrackingKb({ id: 1, status }, "en");
      const flat = kb.inline_keyboard.flat().map((b) => b.text);
      expect(flat.some((t) => t.includes("Refresh"))).toBe(true);
      expect(flat.some((t) => t.includes("Cancel"))).toBe(false);
    }
  });

  it("would show Cancel for PENDING_PAYMENT (defensive — this screen never actually renders for that status)", () => {
    const kb = bybitBscTrackingKb({ id: 1, status: OrderStatus.PENDING_PAYMENT }, "en");
    const flat = kb.inline_keyboard.flat().map((b) => b.text);
    expect(flat.some((t) => t.includes("Cancel"))).toBe(true);
  });
});
