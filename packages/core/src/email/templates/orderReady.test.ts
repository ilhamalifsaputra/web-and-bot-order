/**
 * Tests for the BUYER-facing "your order is ready" email template.
 *
 * Unlike orderPaid/walletTopup (both owner-facing), this one goes to a guest
 * shopper's own inbox, so two properties matter more here than anywhere else
 * and are asserted as explicit guards rather than left as assumptions:
 *
 *  1. The subject NEVER carries the order code. The order code is the entire
 *     credential for a guest order (POST /api/v1/track exchanges it for a
 *     session), and `sendMail` logs every subject it sends.
 *  2. The body carries all THREE ways back into the order — the button, the
 *     printed order code, and the /track link — because the button alone
 *     lands on a session-gated page that is useless to the exact reader who
 *     needs it most (expired cookie, different device).
 */
import { describe, it, expect } from "vitest";
import { Decimal } from "../../money";
import { renderOrderReadyEmail } from "./orderReady";
import type { OrderReadyInput } from "./orderReady";
import type { BrandConfig } from "../types";

const brand: BrandConfig = {
  shopName: "Acme Shop",
  logoUrl: "https://example.com/logo.png",
  accentColor: "#4F46E5",
  supportEmail: "support@acme.test",
  storeUrl: "https://acme.test",
};

const ORDER_CODE = "ORD-20260814-READY01";

const fullInput: OrderReadyInput = {
  orderCode: ORDER_CODE,
  items: [
    { name: "Netflix Premium", variant: "1 Month", quantity: 2, unitPrice: "Rp50.000", lineTotal: "Rp100.000" },
    { name: "Spotify Family", variant: null, quantity: 1, unitPrice: "Rp30.000", lineTotal: "Rp30.000" },
  ],
  subtotal: "Rp130.000",
  discount: "Rp13.000",
  // An IDR order carries no unique code (finalizeOrderPayment zeroes it on the
  // IDR branch), so the row is hidden by the same empty-string convention the
  // discount uses — and Rp130.000 - Rp13.000 = Rp117.000 already balances.
  uniqueCode: "",
  total: "Rp117.000",
  warranty: "30 days / 30 hari",
  orderUrl: "https://shop.test/checkout/ORD-20260814-READY01/pay",
  trackUrl: "https://shop.test/track",
};

describe("renderOrderReadyEmail — full fixture", () => {
  const result = renderOrderReadyEmail(fullInput, brand);

  it("returns subject/html/text", () => {
    expect(result.subject).toBeTypeOf("string");
    expect(result.html).toBeTypeOf("string");
    expect(result.text).toBeTypeOf("string");
  });

  it("represents the order summary in the html", () => {
    expect(result.html).toContain(ORDER_CODE);
    expect(result.html).toContain("Netflix Premium");
    expect(result.html).toContain("1 Month");
    expect(result.html).toContain("Spotify Family");
    expect(result.html).toContain("Rp50.000");
    expect(result.html).toContain("Rp130.000");
    expect(result.html).toContain("Rp13.000");
    expect(result.html).toContain("Rp117.000");
    expect(result.html).toContain("30 days / 30 hari");
  });

  it("represents the order summary in the text", () => {
    expect(result.text).toContain(ORDER_CODE);
    expect(result.text).toContain("Netflix Premium");
    expect(result.text).toContain("Spotify Family");
    expect(result.text).toContain("Rp130.000");
    expect(result.text).toContain("Rp13.000");
    expect(result.text).toContain("Rp117.000");
    expect(result.text).toContain("30 days / 30 hari");
  });

  it("shows an explicit line total for a multi-quantity item, not just the unit price", () => {
    // A bare "2x Netflix Premium — Rp50.000" reads as if Rp50.000 were the
    // line total; it is the per-unit price. The line must spell out both the
    // unit price and the computed total so a buyer cannot misread it.
    expect(result.html).toContain("2 × Rp50.000 = Rp100.000");
    expect(result.text).toContain("2 × Rp50.000 = Rp100.000");
  });

  it("is bilingual in the scannable parts too — summary labels, banner heading, and button", () => {
    expect(result.html).toContain("Discount / Diskon");
    expect(result.html).toContain("Total / Total");
    expect(result.html).toContain("Warranty / Garansi");
    expect(result.html).toContain("View Your Order / Lihat Pesanan");
    expect(result.html).toContain("Your order is ready / Pesanan kamu sudah siap");
    expect(result.text).toContain("Discount / Diskon");
    expect(result.text).toContain("Total / Total");
    expect(result.text).toContain("Warranty / Garansi");
  });

  it("hides the discount line entirely when it is the empty string", () => {
    const noDiscount = renderOrderReadyEmail({ ...fullInput, discount: "" }, brand);
    expect(noDiscount.html).not.toContain("Discount");
    expect(noDiscount.text).not.toContain("Discount");
    // The rest of the summary is untouched.
    expect(noDiscount.html).toContain("Rp117.000");
  });

  it("omits the warranty line when there is no warranty, without leaking null", () => {
    const noWarranty = renderOrderReadyEmail({ ...fullInput, warranty: null }, brand);
    expect(noWarranty.html).not.toContain("Warranty");
    expect(noWarranty.text).not.toContain("Warranty");
    expect(noWarranty.html.toLowerCase()).not.toContain("null");
    expect(noWarranty.text.toLowerCase()).not.toContain("null");
  });

  it("is bilingual — English and Indonesian in one body, in both html and text", () => {
    // The Indonesian half of the body, same one-body-two-languages shape as
    // the guest order-code email in apps/storefront/src/routes/api.ts.
    expect(result.html).toContain("Pesanan kamu sudah siap");
    expect(result.text).toContain("Pesanan kamu sudah siap");
    expect(result.html).toContain("Your order is ready");
    expect(result.text).toContain("Your order is ready");
  });
});

/**
 * The receipt has to RECONCILE, not merely be roughly right: a customer who
 * paid reads these four figures stacked on top of each other, and a summary
 * that does not add up reads as an overcharge and becomes a support ticket.
 *
 * The unique code is the reason it never could before: on a USDT order
 * `finalizeOrderPayment` adds 0.002-0.098 USDT of deterministic noise so the
 * payment poller can match the transfer by amount, that noise is part of
 * `totalAmount`, and nothing printed it. "Kode unik" is also the exact word an
 * Indonesian buyer already expects on a transfer/QRIS payment, so it belongs
 * on the page rather than hidden inside the total.
 */
describe("renderOrderReadyEmail — the unique code, and a summary that adds up", () => {
  /** The value the plain-text receipt actually PRINTS for a summary row —
   * the digits the buyer reads, not the input handed to the renderer. */
  function printedRow(text: string, label: string): string | null {
    const line = text.split("\n").find((l) => l.startsWith(`${label}: `));
    return line ? line.slice(label.length + 2) : null;
  }

  /** "2.34 USDT" -> Decimal(2.34). */
  function amountOf(printed: string): Decimal {
    return new Decimal(printed.replace(/[^0-9.-]/g, ""));
  }

  // A USDT order as the dispatcher formats one: every figure at 2dp with a
  // "USDT" suffix. Rp45.000 with a 20% voucher at an fxRate of 16.000 —
  // see the enqueue-side test in packages/db/src/crud/settlePaidOrder.test.ts
  // for where these particular numbers come from.
  const usdtInput: OrderReadyInput = {
    ...fullInput,
    items: [
      { name: "Netflix Premium", variant: "1 Month", quantity: 1, unitPrice: "2.80 USDT", lineTotal: "2.80 USDT" },
    ],
    subtotal: "2.80 USDT",
    discount: "0.50 USDT",
    uniqueCode: "0.04 USDT",
    total: "2.34 USDT",
  };

  it("prints the unique code as its own bilingually labelled row, in html and text", () => {
    const result = renderOrderReadyEmail(usdtInput, brand);
    expect(result.html).toContain("Unique code / Kode unik");
    expect(result.html).toContain("0.04 USDT");
    expect(result.text).toContain("Unique code / Kode unik");
    expect(printedRow(result.text, "Unique code / Kode unik")).toBe("0.04 USDT");
  });

  it("prints figures that reconcile: Subtotal - Discount + Unique code = Total", () => {
    const result = renderOrderReadyEmail(usdtInput, brand);
    const subtotal = amountOf(printedRow(result.text, "Subtotal / Subtotal")!);
    const discount = amountOf(printedRow(result.text, "Discount / Diskon")!);
    const unique = amountOf(printedRow(result.text, "Unique code / Kode unik")!);
    const total = amountOf(printedRow(result.text, "Total / Total")!);
    expect(subtotal.minus(discount).plus(unique).toString()).toBe(total.toString());
  });

  it("hides the unique-code row entirely when it is the empty string, like the discount row", () => {
    const noUnique = renderOrderReadyEmail({ ...usdtInput, uniqueCode: "" }, brand);
    expect(noUnique.html).not.toContain("Unique code");
    expect(noUnique.html).not.toContain("Kode unik");
    expect(noUnique.text).not.toContain("Unique code");
    expect(noUnique.text).not.toContain("Kode unik");
    // The rest of the summary is untouched.
    expect(noUnique.html).toContain("2.80 USDT");
    expect(noUnique.text).toContain("2.34 USDT");
  });

  it("orders the summary the way it is read: subtotal, discount, unique code, then total", () => {
    const result = renderOrderReadyEmail(usdtInput, brand);
    const at = (needle: string) => result.text.indexOf(needle);
    expect(at("Subtotal / Subtotal")).toBeLessThan(at("Discount / Diskon"));
    expect(at("Discount / Diskon")).toBeLessThan(at("Unique code / Kode unik"));
    expect(at("Unique code / Kode unik")).toBeLessThan(at("Total / Total"));
  });
});

describe("renderOrderReadyEmail — subject never carries the order code", () => {
  it("is a fixed literal, identical for two completely different orders", () => {
    const a = renderOrderReadyEmail(fullInput, brand);
    const b = renderOrderReadyEmail(
      {
        ...fullInput,
        orderCode: "ORD-SOMETHING-ELSE",
        total: "Rp999.999",
        items: [{ name: "Other", variant: null, quantity: 9, unitPrice: "Rp1", lineTotal: "Rp9" }],
        orderUrl: "https://other.test/x",
        trackUrl: "https://other.test/track",
      },
      brand,
    );
    expect(a.subject).toBe(b.subject);
    expect(a.subject).not.toContain(ORDER_CODE);
    expect(b.subject).not.toContain("ORD-SOMETHING-ELSE");
  });

  it("does not vary with brand either — no shop name interpolation to smuggle payload in through", () => {
    const other = renderOrderReadyEmail(fullInput, { ...brand, shopName: "Totally Different Shop" });
    expect(other.subject).toBe(renderOrderReadyEmail(fullInput, brand).subject);
  });
});

describe("renderOrderReadyEmail — the three ways back into the order", () => {
  const result = renderOrderReadyEmail(fullInput, brand);

  it("renders the primary order-page button", () => {
    expect(result.html).toContain(fullInput.orderUrl!);
    expect(result.text).toContain(fullInput.orderUrl!);
  });

  it("prints the order code in the body, where the button cannot reach", () => {
    expect(result.html).toContain(ORDER_CODE);
    expect(result.text).toContain(ORDER_CODE);
  });

  it("renders the /track fallback link — the only recovery path for an expired guest session", () => {
    expect(result.html).toContain("https://shop.test/track");
    expect(result.text).toContain("https://shop.test/track");
  });
});

describe("renderOrderReadyEmail — orderUrl is null (no PUBLIC_URL configured)", () => {
  const result = renderOrderReadyEmail({ ...fullInput, orderUrl: null }, brand);

  it("still renders, with no broken/empty button href", () => {
    expect(result.html).toBeTypeOf("string");
    expect(result.html).not.toContain('href=""');
    expect(result.html.toLowerCase()).not.toContain("undefined");
    expect(result.html.toLowerCase()).not.toContain("null");
    expect(result.text.toLowerCase()).not.toContain("undefined");
  });

  it("still gives the reader the order code and the /track link", () => {
    expect(result.html).toContain(ORDER_CODE);
    expect(result.html).toContain("https://shop.test/track");
    expect(result.text).toContain(ORDER_CODE);
    expect(result.text).toContain("https://shop.test/track");
  });
});

describe("renderOrderReadyEmail — trackUrl is null too", () => {
  it("renders with neither link, still printing the order code", () => {
    const result = renderOrderReadyEmail({ ...fullInput, orderUrl: null, trackUrl: null }, brand);
    expect(result.html).not.toContain('href=""');
    expect(result.html.toLowerCase()).not.toContain("null");
    expect(result.html).toContain(ORDER_CODE);
    expect(result.text).toContain(ORDER_CODE);
  });
});

describe("renderOrderReadyEmail — carries no credentials, ever", () => {
  // The email is deliberately a summary plus a way in, never the goods:
  // email is unencrypted and sits in an inbox forever (the rule stated at
  // apps/storefront/src/routes/api.ts's sendGuestOrderCodeEmail). The input
  // type has no field for delivered content, so the strongest guard the
  // template itself can offer is that nothing resembling a credential can
  // reach the output through the fields it does accept.
  it("has no field for delivered content — a credential-looking item name is still only a name", () => {
    const result = renderOrderReadyEmail(fullInput, brand);
    expect(result.html).not.toContain("deliveredContent");
    expect(result.html).not.toContain("credentials");
    expect(result.text).not.toContain("deliveredContent");
    expect(result.text).not.toContain("credentials");
  });

  it("tells the reader the goods are on the order page, not in this email", () => {
    const result = renderOrderReadyEmail(fullInput, brand);
    expect(result.text).toContain("never sent by email");
  });
});
