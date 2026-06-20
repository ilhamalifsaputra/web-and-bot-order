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

  it("offers no payable action when nothing is configured (manual fallback retired)", () => {
    const d = data(orderConfirmKb(1, 1, "en", "", false, false, false));
    // No gateway → no pay button at all (the legacy manual Binance Pay fallback
    // was removed); only the voucher + cancel actions remain.
    expect(d.some((x) => x.startsWith("v1:pay:"))).toBe(false);
    expect(d.some((x) => x.startsWith("v1:payq:"))).toBe(false);
    expect(d.some((x) => x.startsWith("v1:usdt:"))).toBe(false);
  });

  it("shows the PayDisini button only when paydisiniEnabled is true", () => {
    const withPaydisini = data(orderConfirmKb(1, 1, "en", "", false, false, false, true));
    expect(withPaydisini.some((x) => x.startsWith("v1:payd:"))).toBe(true);
    // No fallback plain-confirm button once a payment rail is available.
    expect(withPaydisini.some((x) => x.startsWith("v1:pay:"))).toBe(false);

    const withoutPaydisini = data(orderConfirmKb(1, 1, "en", "", false, false, false, false));
    expect(withoutPaydisini.some((x) => x.startsWith("v1:payd:"))).toBe(false);
  });

  it("lists QRIS before PayDisini before USDT when all rails are configured", () => {
    const d = data(orderConfirmKb(1, 1, "en", "", true, true, true, true));
    const qris = d.findIndex((x) => x.startsWith("v1:payq:"));
    const paydisini = d.findIndex((x) => x.startsWith("v1:payd:"));
    const usdt = d.findIndex((x) => x.startsWith("v1:usdt:"));
    expect(qris).toBeGreaterThanOrEqual(0);
    expect(paydisini).toBeGreaterThan(qris);
    expect(usdt).toBeGreaterThan(paydisini);
  });

  it("shows the top-level USDT button when NOWPayments is the only USDT rail enabled", () => {
    // internalEnabled=false, bybitEnabled=false, tokopayEnabled=false,
    // paydisiniEnabled=false, nowpaymentsEnabled=true — USDT must still show.
    const d = data(orderConfirmKb(1, 1, "en", "", false, false, false, false, true));
    expect(d.some((x) => x.startsWith("v1:usdt:"))).toBe(true);
    // No fallback plain-confirm button once a payment rail is available.
    expect(d.some((x) => x.startsWith("v1:pay:"))).toBe(false);

    const withoutNowpayments = data(orderConfirmKb(1, 1, "en", "", false, false, false, false, false));
    expect(withoutNowpayments.some((x) => x.startsWith("v1:usdt:"))).toBe(false);
    // Nothing configured → no payable action (the manual fallback was retired).
    expect(withoutNowpayments.some((x) => x.startsWith("v1:pay:"))).toBe(false);
  });

  it("USDT submenu lists NOWPayments only when nowpaymentsEnabled is true", () => {
    const withNowpayments = data(usdtMethodsKb(1, 1, "en", false, false, true));
    expect(withNowpayments.some((x) => x.startsWith("v1:payn:"))).toBe(true);
    expect(withNowpayments.some((x) => x.startsWith("v1:buy:"))).toBe(true); // Back → confirmation

    const withoutNowpayments = data(usdtMethodsKb(1, 1, "en", false, false, false));
    expect(withoutNowpayments.some((x) => x.startsWith("v1:payn:"))).toBe(false);
  });

  it("USDT submenu lists Binance + Bybit + NOWPayments together when all three are enabled", () => {
    const d = data(usdtMethodsKb(1, 1, "en", true, true, true));
    expect(d.some((x) => x.startsWith("v1:payx:"))).toBe(true);
    expect(d.some((x) => x.startsWith("v1:payb:"))).toBe(true);
    expect(d.some((x) => x.startsWith("v1:payn:"))).toBe(true);
  });
});
