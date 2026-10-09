import { describe, expect, it } from "vitest";
import { customerProgressPhase, progressForPhase } from "@app/core/orderFulfillment";
import { renderTransactionStatusMessage, SUPPORT_PHASES, supportButtonFor } from "./transactionMessage";

const order = { status: "PENDING_PAYMENT", paidAt: null, fulfillmentProvider: "DIGIFLAZZ", items: [] };
const render = (status: string, lang = "en") => renderTransactionStatusMessage({
  orderCode: "ORD-1", presentation: customerProgressPhase({ ...order, status }), lang, frame: "⣾", amount: "Rp10.000",
});

describe("progress bar before the payment is verified", () => {
  it("has no percentage for a detected or verifying payment", () => {
    expect(progressForPhase("PAYMENT_DETECTED")).toBeNull();
    expect(progressForPhase("VERIFYING")).toBeNull();
  });
  it.each([["PAYMENT_DETECTED", "en"], ["CONFIRMING", "en"], ["PAYMENT_DETECTED", "id"], ["CONFIRMING", "id"]])("renders %s (%s) with the spinner but no bar or percent", (status, lang) => {
    const text = render(status, lang);
    expect(text).toContain("⣾");
    expect(text).not.toMatch(/[█░%]/u);
  });
  it.each([
    ["UNDERPAID", { status: "UNDERPAID" }],
    ["REVIEW", { status: "PROCESSING", paidAt: new Date(), digiflazzStatus: "failed" }],
    ["FAILED", { status: "FAILED" }],
    ["CANCELLED", { status: "CANCELLED" }],
  ] as const)("ends a %s status with the hint at the Support button", (phase, over) => {
    for (const [lang, hint] of [["en", "Need help? Tap 💬 Support below."], ["id", "Butuh bantuan? Ketuk 💬 Bantuan di bawah."]] as const) {
      const presentation = customerProgressPhase({ ...order, ...over });
      expect(presentation.phase).toBe(phase);
      const text = renderTransactionStatusMessage({ orderCode: "ORD-1", presentation, lang, frame: "⣾", amount: "Rp10.000" });
      expect(text.endsWith(hint)).toBe(true);
      expect(text).not.toMatch(/bot description|deskripsi bot/);
    }
  });
  it.each(["PENDING_PAYMENT", "PAYMENT_DETECTED", "PAID", "DELIVERED"])("adds no Support hint to a %s status", status => {
    expect(render(status)).not.toContain("Need help?");
  });
  it("still shows the bar once the payment is confirmed", () => {
    const text = render("PAID");
    expect(text).toContain("40%");
    expect(text).toMatch(/█+░+ 40%/u);
  });
});

describe("a delivered stock order whose credentials file is still being sent", () => {
  const stock = { status: "DELIVERED", paidAt: new Date(), fulfillmentProvider: "STOCK", items: [{ product: { deliveryType: "auto" } }] };
  const delivering = customerProgressPhase(stock, { credentialsDelivered: false });
  it.each([["en", "Sending your account details…"], ["id", "Mengirim detail akunmu…"]])("spins at 90%% without claiming completion (%s)", (lang, title) => {
    const text = renderTransactionStatusMessage({ orderCode: "ORD-1", presentation: delivering, lang, frame: "⣾", amount: "Rp10.000" });
    expect(text).toContain(`⣾ <b>${title}</b>`);
    expect(text).toContain("90%");
    expect(text).not.toMatch(/completed|selesai|✅/);
  });
  it.each([
    ["en", "Your account details are still being sent. If you have not received a file, tap 💬 Support below."],
    ["id", "Detail akunmu masih dalam proses pengiriman. Jika kamu belum menerima file, ketuk 💬 Bantuan di bawah."],
  ])("turns into one static honest line once slow (%s)", (lang, line) => {
    const text = renderTransactionStatusMessage({ orderCode: "ORD-1", presentation: delivering, lang, frame: "⣾", amount: "Rp10.000", slow: true });
    expect(text.endsWith(line)).toBe(true);
    expect(text).not.toContain("⣾");
    expect(text).not.toMatch(/[█░%]/u);
    expect(text).not.toMatch(/verifying|memverifikasi/i);
    expect(text.match(/💬/gu)).toHaveLength(1); // no second Support hint under the line
  });
  it("offers the Support button only for a slow delivery or a support phase", () => {
    expect(supportButtonFor("DELIVERING", false)).toBe(false);
    expect(supportButtonFor("DELIVERING", true)).toBe(true);
    expect(supportButtonFor("VERIFYING", true)).toBe(false);
    for (const phase of SUPPORT_PHASES) expect(supportButtonFor(phase, false)).toBe(true);
    expect(supportButtonFor("SUCCESS", false)).toBe(false);
  });
});
