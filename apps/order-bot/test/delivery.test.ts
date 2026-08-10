/**
 * walletTopupSuccessText — the shared "top-up successful" DM/bubble text
 * (binanceInternal.ts / bybitDeposit.ts / bybitBscDeposit.ts onDelivered).
 * Money-adjacent display logic: picking the right currency field and the
 * right formatter (formatIdr vs formatUsdt) is exactly the kind of thing
 * that silently crosses wires when IDR/USDT branches get copy-pasted. Pure
 * function over static locale JSON — no DB needed.
 */
import { describe, it, expect } from "vitest";
import { Decimal } from "@app/core/money";
import { walletTopupSuccessText } from "../src/util/delivery";

describe("walletTopupSuccessText", () => {
  it("formats an IDR top-up with Rupiah amount and balance (reads the IDR branch, not USDT)", () => {
    const order = { orderCode: "TOPUP-IDR-1", currency: "IDR", totalAmount: new Decimal("50000") };
    const text = walletTopupSuccessText(order, new Decimal("125000"), "en");

    expect(text).toContain("TOPUP-IDR-1");
    // Credited amount in Rupiah.
    expect(text).toContain("Rp50.000");
    // New balance in Rupiah — proves the IDR branch, not the USDT one.
    expect(text).toContain("Rp125.000");
    expect(text).not.toContain("USDT");
  });

  it("formats a USDT top-up with a USDT-suffixed amount and balance (reads the USDT branch, not IDR)", () => {
    const order = { orderCode: "TOPUP-USDT-1", currency: "USDT", totalAmount: new Decimal("10") };
    const text = walletTopupSuccessText(order, new Decimal("42.5"), "en");

    expect(text).toContain("TOPUP-USDT-1");
    // Credited amount, USDT-formatted (orderAmount fixes 2dp: "10.00 USDT").
    expect(text).toContain("10.00 USDT");
    // New balance, USDT-formatted with an explicit unit (formatUsdt strips
    // trailing zeros: "42.5 USDT") — proves the USDT branch, not the IDR one
    // (which would render "Rp42.5" / "Rp43").
    expect(text).toContain("42.5 USDT");
    expect(text).not.toContain("Rp");
  });

  it("falls back to USDT formatting when currency is null (createWalletTopupOrder always sets one, but the function defends anyway)", () => {
    const order = { orderCode: "TOPUP-NULL-1", currency: null, totalAmount: new Decimal("3") };
    const text = walletTopupSuccessText(order, new Decimal("3"), "en");

    expect(text).toContain("3.00 USDT"); // credited amount (orderAmount, fixed 2dp)
    expect(text).toContain("3 USDT"); // new balance (formatUsdt, trailing zeros stripped)
    expect(text).not.toContain("Rp");
  });

  it("localizes into Indonesian when lang is 'id'", () => {
    const order = { orderCode: "TOPUP-ID-1", currency: "USDT", totalAmount: new Decimal("5") };
    const text = walletTopupSuccessText(order, new Decimal("5"), "id");

    expect(text).toContain("Top up berhasil");
    expect(text).toContain("Saldo baru");
  });
});
