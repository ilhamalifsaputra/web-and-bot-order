import { describe, it, expect } from "vitest";
import { renderOrderPaidEmail } from "./orderPaid";
import type { OrderPaidInput } from "./orderPaid";
import type { BrandConfig, EmailCopy } from "../types";

const brand: BrandConfig = {
  shopName: "Acme Shop",
  logoUrl: "https://example.com/logo.png",
  accentColor: "#4F46E5",
  supportEmail: "support@acme.test",
  storeUrl: "https://acme.test",
};

const defaultCopy: EmailCopy = {
  subject: "New paid order",
  title: "You've got a new order",
  subtitle: "A customer just completed payment.",
  message: "Here are the details.",
};

const fullInput: OrderPaidInput = {
  orderCode: "ORD-20260807-ABCD",
  orderId: 42,
  customerLabel: "john@example.com",
  items: [
    { name: "Netflix Premium", variant: "1 Month", quantity: 2, unitPrice: "Rp50.000" },
    { name: "Spotify", variant: null, quantity: 1, unitPrice: "Rp20.000" },
  ],
  subtotal: "Rp120.000",
  discount: "Rp10.000",
  total: "Rp110.000",
  paymentMethod: "TOKOPAY",
  transactionId: "TXN-98765",
  voucherCode: "SAVE10",
  paidAt: "2026-08-07 10:00 UTC",
  orderUrl: "https://acme.test/orders/42",
};

describe("renderOrderPaidEmail — full fixture", () => {
  const result = renderOrderPaidEmail(fullInput, brand, defaultCopy);

  it("returns subject/html/text", () => {
    expect(result.subject).toBeTypeOf("string");
    expect(result.html).toBeTypeOf("string");
    expect(result.text).toBeTypeOf("string");
  });

  it("represents every fact in the html", () => {
    expect(result.html).toContain("ORD-20260807-ABCD");
    expect(result.html).toContain("Netflix Premium");
    expect(result.html).toContain("1 Month");
    expect(result.html).toContain("Spotify");
    expect(result.html).toContain("Rp120.000");
    expect(result.html).toContain("Rp10.000");
    expect(result.html).toContain("Rp110.000");
    expect(result.html).toContain("TOKOPAY");
    expect(result.html).toContain("TXN-98765");
    expect(result.html).toContain("SAVE10");
    expect(result.html).toContain("2026-08-07 10:00 UTC");
    expect(result.html).toContain("https://acme.test/orders/42");
    expect(result.html).toContain("john@example.com");
    expect(result.html).toContain("PAID");
  });

  it("represents every fact in the text", () => {
    expect(result.text).toContain("ORD-20260807-ABCD");
    expect(result.text).toContain("Netflix Premium");
    expect(result.text).toContain("1 Month");
    expect(result.text).toContain("Spotify");
    expect(result.text).toContain("Rp120.000");
    expect(result.text).toContain("Rp10.000");
    expect(result.text).toContain("Rp110.000");
    expect(result.text).toContain("TOKOPAY");
    expect(result.text).toContain("TXN-98765");
    expect(result.text).toContain("SAVE10");
    expect(result.text).toContain("2026-08-07 10:00 UTC");
    expect(result.text).toContain("https://acme.test/orders/42");
    expect(result.text).toContain("john@example.com");
  });
});

describe("renderOrderPaidEmail — zero discount (empty string, caller-hidden)", () => {
  it("omits the Discount row/line entirely when discount is an empty string", () => {
    const noDiscountInput: OrderPaidInput = { ...fullInput, discount: "" };
    const result = renderOrderPaidEmail(noDiscountInput, brand, defaultCopy);
    expect(result.html).not.toContain("Discount");
    expect(result.text).not.toContain("Discount");
  });
});

describe("renderOrderPaidEmail — minimal fixture (no voucher, no transaction id, no order URL)", () => {
  const minimalInput: OrderPaidInput = {
    ...fullInput,
    transactionId: null,
    voucherCode: null,
    orderUrl: null,
  };
  const result = renderOrderPaidEmail(minimalInput, brand, defaultCopy);

  it("omits transaction id / voucher lines and the button entirely, without leaking null/undefined", () => {
    expect(result.html).not.toContain("TXN-98765");
    expect(result.html).not.toContain("SAVE10");
    expect(result.html.toLowerCase()).not.toContain("null");
    expect(result.html.toLowerCase()).not.toContain("undefined");
    expect(result.html).not.toContain('href=""');
  });

  it("omits the primaryButton and its fallbackLinkLine when orderUrl is null", () => {
    expect(result.html).not.toContain("View Order");
    expect(result.html).not.toContain("If the button doesn't work");
  });

  it("does not leak null/undefined into the text either", () => {
    expect(result.text.toLowerCase()).not.toContain("null");
    expect(result.text.toLowerCase()).not.toContain("undefined");
  });
});

describe("renderOrderPaidEmail — XSS escaping", () => {
  const maliciousInput: OrderPaidInput = {
    ...fullInput,
    customerLabel: '<script>alert("customer")</script>',
    items: [{ name: '<script>alert("item")</script>', variant: null, quantity: 1, unitPrice: "Rp1.000" }],
    voucherCode: '<script>alert("voucher")</script>',
  };
  const result = renderOrderPaidEmail(maliciousInput, brand, defaultCopy);

  it("escapes malicious input in html (raw tag string absent)", () => {
    expect(result.html).not.toContain('<script>alert("customer")</script>');
    expect(result.html).not.toContain('<script>alert("item")</script>');
    expect(result.html).not.toContain('<script>alert("voucher")</script>');
  });

  it("keeps malicious input verbatim (not HTML-escaped, not double-escaped) in text", () => {
    expect(result.text).toContain('<script>alert("customer")</script>');
    expect(result.text).toContain('<script>alert("item")</script>');
    expect(result.text).toContain('<script>alert("voucher")</script>');
    // Not double-escaped: no literal "&amp;lt;" artifact from re-escaping an
    // already-escaped string.
    expect(result.text).not.toContain("&amp;lt;");
  });
});

describe("renderOrderPaidEmail — subject handling", () => {
  it("uses the default copy subject verbatim: exactly 'New paid order'", () => {
    const result = renderOrderPaidEmail(fullInput, brand, defaultCopy);
    expect(result.subject).toBe("New paid order");
  });

  it("substitutes {shop_name} in a copy override", () => {
    const copy: EmailCopy = { ...defaultCopy, subject: "{shop_name} has a new order!" };
    const result = renderOrderPaidEmail(fullInput, brand, copy);
    expect(result.subject).toBe("Acme Shop has a new order!");
  });

  it("substitutes {order_code} when literally present in the copy override — the deliberate, narrowly-scoped exception for this one template", () => {
    const copy: EmailCopy = { ...defaultCopy, subject: "New order {order_code}" };
    const result = renderOrderPaidEmail(fullInput, brand, copy);
    expect(result.subject).toBe("New order " + fullInput.orderCode);
    expect(result.subject).toContain("ORD-20260807-ABCD");
  });

  it("puts the real order code in the subject as well as the body", () => {
    const copy: EmailCopy = { ...defaultCopy, subject: "New order {order_code}" };
    const result = renderOrderPaidEmail(fullInput, brand, copy);
    expect(result.subject).toContain("ORD-20260807-ABCD");
    expect(result.html).toContain("ORD-20260807-ABCD");
    expect(result.text).toContain("ORD-20260807-ABCD");
  });
});

describe("renderOrderPaidEmail — preheader", () => {
  it("includes preheader text with 'New Paid Order!' and the order code", () => {
    const result = renderOrderPaidEmail(fullInput, brand, defaultCopy);
    expect(result.html).toContain("New Paid Order! - ORD-20260807-ABCD");
  });
});

describe("renderOrderPaidEmail — brand accent color", () => {
  it("uses the brand's accent color as the View Order button background", () => {
    const brandedAccent: BrandConfig = { ...brand, accentColor: "#00A86B" };
    const result = renderOrderPaidEmail(fullInput, brandedAccent, defaultCopy);
    // Matches primaryButton's exact bulletproof-button markup, not just any
    // "background-color:#00A86B" occurrence (the header accent rule also
    // carries the accent color, so a bare toContain would false-positive).
    expect(result.html).toContain('background-color:#00A86B;" class="email-button-bg"');
  });

  it("falls back to the default accent color for the button when brand.accentColor is an empty string, instead of an invisible button", () => {
    const emptyAccent: BrandConfig = { ...brand, accentColor: "" };
    const result = renderOrderPaidEmail(fullInput, emptyAccent, defaultCopy);
    expect(result.html).not.toContain('background-color:;" class="email-button-bg"');
    expect(result.html).toContain('background-color:#4F46E5;" class="email-button-bg"');
  });
});
