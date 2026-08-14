import { describe, it, expect } from "vitest";
import { renderWalletTopupEmail } from "./walletTopup";
import type { WalletTopupInput } from "./walletTopup";
import type { BrandConfig } from "../types";

const brand: BrandConfig = {
  shopName: "Acme Shop",
  logoUrl: "https://example.com/logo.png",
  accentColor: "#4F46E5",
  supportEmail: "support@acme.test",
  storeUrl: "https://acme.test",
};

const fullInput: WalletTopupInput = {
  orderCode: "ORD-20260814-TOPUP",
  customerLabel: "jane@example.com",
  amount: "Rp50.000",
  currency: "IDR",
  newBalance: "Rp125.000",
  paymentMethod: "TOKOPAY",
  transactionId: "TXN-98765",
  toppedUpAt: "2026-08-14 09:30 UTC",
};

describe("renderWalletTopupEmail — full fixture", () => {
  const result = renderWalletTopupEmail(fullInput, brand);

  it("returns subject/html/text", () => {
    expect(result.subject).toBeTypeOf("string");
    expect(result.html).toBeTypeOf("string");
    expect(result.text).toBeTypeOf("string");
  });

  it("represents every fact in the html", () => {
    expect(result.html).toContain("ORD-20260814-TOPUP");
    expect(result.html).toContain("jane@example.com");
    expect(result.html).toContain("Rp50.000");
    expect(result.html).toContain("Rp125.000");
    expect(result.html).toContain("TOKOPAY");
    expect(result.html).toContain("TXN-98765");
    expect(result.html).toContain("2026-08-14 09:30 UTC");
  });

  it("represents every fact in the text", () => {
    expect(result.text).toContain("ORD-20260814-TOPUP");
    expect(result.text).toContain("jane@example.com");
    expect(result.text).toContain("Rp50.000");
    expect(result.text).toContain("Rp125.000");
    expect(result.text).toContain("TOKOPAY");
    expect(result.text).toContain("TXN-98765");
    expect(result.text).toContain("2026-08-14 09:30 UTC");
  });
});

describe("renderWalletTopupEmail — subject is a fixed literal, never interpolated", () => {
  it("returns the exact same subject regardless of the payload's order code/amount/customer", () => {
    const a = renderWalletTopupEmail(fullInput, brand);
    const differentInput: WalletTopupInput = {
      ...fullInput,
      orderCode: "ORD-COMPLETELY-DIFFERENT",
      customerLabel: "someone-else@example.com",
      amount: "Rp999.999",
      newBalance: "Rp1.000.000",
    };
    const b = renderWalletTopupEmail(differentInput, brand);
    expect(a.subject).toBe(b.subject);
    expect(a.subject).not.toContain("ORD-20260814-TOPUP");
    expect(b.subject).not.toContain("ORD-COMPLETELY-DIFFERENT");
  });

  it("does not vary with brand (no {shop_name} substitution either)", () => {
    const otherBrand: BrandConfig = { ...brand, shopName: "A Totally Different Shop" };
    const a = renderWalletTopupEmail(fullInput, brand);
    const b = renderWalletTopupEmail(fullInput, otherBrand);
    expect(a.subject).toBe(b.subject);
  });
});

describe("renderWalletTopupEmail — minimal fixture (no transaction id)", () => {
  const minimalInput: WalletTopupInput = { ...fullInput, transactionId: null };
  const result = renderWalletTopupEmail(minimalInput, brand);

  it("omits the transaction id line entirely, without leaking null/undefined", () => {
    expect(result.html).not.toContain("TXN-98765");
    expect(result.html.toLowerCase()).not.toContain("null");
    expect(result.html.toLowerCase()).not.toContain("undefined");
    expect(result.text.toLowerCase()).not.toContain("null");
    expect(result.text.toLowerCase()).not.toContain("undefined");
  });
});

describe("renderWalletTopupEmail — USDT top-up renders correctly", () => {
  const usdtInput: WalletTopupInput = {
    ...fullInput,
    currency: "USDT",
    amount: "10.50 USDT",
    newBalance: "25.75 USDT",
  };
  const result = renderWalletTopupEmail(usdtInput, brand);

  it("shows the USDT-formatted amount and new balance in both html and text", () => {
    expect(result.html).toContain("10.50 USDT");
    expect(result.html).toContain("25.75 USDT");
    expect(result.text).toContain("10.50 USDT");
    expect(result.text).toContain("25.75 USDT");
  });
});

describe("renderWalletTopupEmail — XSS escaping", () => {
  const maliciousInput: WalletTopupInput = {
    ...fullInput,
    customerLabel: '<script>alert("customer")</script>',
  };
  const result = renderWalletTopupEmail(maliciousInput, brand);

  it("escapes malicious input in html (raw tag string absent)", () => {
    expect(result.html).not.toContain('<script>alert("customer")</script>');
  });

  it("keeps malicious input verbatim (not HTML-escaped) in text", () => {
    expect(result.text).toContain('<script>alert("customer")</script>');
  });
});
