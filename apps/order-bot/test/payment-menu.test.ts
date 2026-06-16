import { describe, it, expect } from "vitest";
import { orderConfirmKb, usdtMethodsKb } from "../src/keyboards/customer";

interface FlatBtn {
  text: string;
  callback_data?: string;
}

function data(kb: { inline_keyboard: FlatBtn[][] }): string[] {
  return kb.inline_keyboard.flat().map((b) => b.callback_data ?? "");
}

describe("payment method menu", () => {
  it("lists QRIS before USDT and never the manual Binance Pay / direct rails", () => {
    // all rails configured: internal, bybit, tokopay
    const d = data(orderConfirmKb(1, 1, "en", "", true, true, true));
    const qris = d.findIndex((x) => x.startsWith("v1:payq:"));
    const usdt = d.findIndex((x) => x.startsWith("v1:usdt:"));
    expect(qris).toBeGreaterThanOrEqual(0);
    expect(usdt).toBeGreaterThan(qris); // QRIS first, then USDT submenu entry
    // The manual Binance Pay button and the direct USDT rails are not surfaced here.
    expect(d.some((x) => x.startsWith("v1:pay:"))).toBe(false);
    expect(d.some((x) => x.startsWith("v1:payx:"))).toBe(false);
    expect(d.some((x) => x.startsWith("v1:payb:"))).toBe(false);
  });

  it("shows only QRIS when no USDT rail is configured", () => {
    const d = data(orderConfirmKb(1, 1, "en", "", false, false, true));
    expect(d.some((x) => x.startsWith("v1:payq:"))).toBe(true);
    expect(d.some((x) => x.startsWith("v1:usdt:"))).toBe(false);
  });

  it("USDT submenu lists Binance + Bybit + a Back-to-confirm action", () => {
    const d = data(usdtMethodsKb(1, 1, "en", true, true));
    expect(d.some((x) => x.startsWith("v1:payx:"))).toBe(true); // Binance (internal)
    expect(d.some((x) => x.startsWith("v1:payb:"))).toBe(true); // Bybit
    expect(d.some((x) => x.startsWith("v1:buy:"))).toBe(true); // Back → confirmation
  });

  it("falls back to a plain confirm when nothing is configured", () => {
    const d = data(orderConfirmKb(1, 1, "en", "", false, false, false));
    expect(d.some((x) => x.startsWith("v1:pay:"))).toBe(true);
    expect(d.some((x) => x.startsWith("v1:usdt:"))).toBe(false);
  });
});
