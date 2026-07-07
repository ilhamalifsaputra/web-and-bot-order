import { describe, it, expect } from "vitest";
import { render } from "./templates";

const payload = {
  order_code: "ORD-20260528-CYHM",
  masked_buyer_id: "5840XXXXXX",
  items: [{ name: "Netflix Premium Test", duration: "1 Month", qty: 1 }],
  total: "5.0066",
  currency: "USDT",
  delivered_at: "2026-05-28 18:52:19 UTC",
  buyer_language: "en",
};

describe("notifier templates.render", () => {
  it("renders ORDER_DELIVERED (stored enum name) in English", () => {
    const out = render("ORDER_DELIVERED", payload);
    expect(out).toContain("📢 <b>TESTIMONIAL</b>");
    expect(out).toContain("<code>5840XXXXXX</code>");
    expect(out).toContain("   • Netflix Premium Test <i>(1 Month)</i> x1");
    expect(out).toContain("<b>5.0066 USDT</b>");
    expect(out).toContain("📅 Date: 2026-05-28 18:52:19 UTC");
    expect(out).toContain("🎉 Thank you for shopping with us!");
  });

  it("renders Indonesian when buyer_language=id", () => {
    const out = render("ORDER_DELIVERED", { ...payload, buyer_language: "id" });
    expect(out).toContain("<b>TESTIMONI</b>");
    expect(out).toContain("👤 Pembeli:");
    expect(out).toContain("🎉 Terima kasih sudah berbelanja!");
  });

  it("falls back to English for unknown language", () => {
    const out = render("ORDER_DELIVERED", { ...payload, buyer_language: "xx" });
    expect(out).toContain("TESTIMONIAL");
  });

  it("HTML-escapes buyer/product fields", () => {
    const out = render("ORDER_DELIVERED", {
      ...payload,
      masked_buyer_id: "<b>&'\"",
      items: [{ name: "A & B <x>", qty: 2 }],
    });
    expect(out).toContain("&lt;b&gt;&amp;&#x27;&quot;");
    expect(out).toContain("A &amp; B &lt;x&gt; x2");
  });

  it("caps an unusually long product-item list to 300 chars (Outbox-5) so it can't blow past Telegram's message limit", () => {
    const manyItems = Array.from({ length: 200 }, (_, i) => ({ name: `Product number ${i}`, qty: 1 }));
    const out = render("ORDER_DELIVERED", { ...payload, items: manyItems });
    // The rendered products block itself must be capped — not merely "shorter
    // than the uncapped version" (which would still be true at 10x the limit).
    const productsLine = out.split("\n").find((l) => l.startsWith("🛍️"))!;
    const idx = out.indexOf(productsLine);
    const productsBlock = out.slice(idx + productsLine.length + 1, out.indexOf("💳"));
    expect(productsBlock.length).toBeLessThanOrEqual(301); // 300 chars + trailing newline
  });

  it("caps an unusually long masked_buyer_id / total to 300 chars (Outbox-5)", () => {
    const longId = "X".repeat(1000);
    const longTotal = "9".repeat(1000);
    const out = render("ORDER_DELIVERED", { ...payload, masked_buyer_id: longId, total: longTotal });
    expect(out).not.toContain(longId);
    expect(out).not.toContain(longTotal);
    const buyerMatch = out.match(/<code>(X+)<\/code>/);
    expect(buyerMatch![1]!.length).toBeLessThanOrEqual(300);
    const totalMatch = out.match(/<b>(9+) USDT<\/b>/);
    expect(totalMatch![1]!.length).toBeLessThanOrEqual(300);
  });

  it("renders ADMIN_PW_RESET as a bilingual DM with the code and TTL", () => {
    const out = render("ADMIN_PW_RESET", { code: "048273", ttl_minutes: 10 });
    expect(out).toContain("<code>048273</code>");
    expect(out).toContain("valid 10 min");
    expect(out).toContain("Web admin password reset");
    expect(out).toContain("Reset password admin web"); // Indonesian line
  });

  it("renders ADMIN_OVERPAID as a bilingual admin DM with order code, amounts, excess and currency", () => {
    const out = render("ADMIN_OVERPAID", {
      order_code: "ORD-OVERPAY-1",
      paid: "75000.0000",
      expected: "50000.0000",
      excess: "25000.0000",
      currency: "IDR",
    });
    expect(out).toContain("<code>ORD-OVERPAY-1</code>");
    expect(out).toContain("75000.0000");
    expect(out).toContain("50000.0000");
    expect(out).toContain("25000.0000");
    expect(out).toContain("IDR");
    expect(out).toMatch(/overpa(id|yment)/i);
    expect(out).toMatch(/kelebihan|bayar lebih/i); // Indonesian line
  });

  it("HTML-escapes ADMIN_OVERPAID interpolated values", () => {
    const out = render("ADMIN_OVERPAID", {
      order_code: "<b>ORD</b>",
      paid: "<script>",
      expected: "50000",
      excess: "0",
      currency: "IDR",
    });
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<b>ORD</b>");
    expect(out).toContain("&lt;b&gt;ORD&lt;/b&gt;");
  });

  it("renders ORDER_PIPELINE_FAILED as a bilingual admin DM with the order code and reason", () => {
    const out = render("ORDER_PIPELINE_FAILED", {
      order_code: "ORD-BSC-FAIL-1",
      reason: "transaction 0xabc not found on-chain after 10 consecutive lookups",
    });
    expect(out).toContain("<code>ORD-BSC-FAIL-1</code>");
    expect(out).toContain("transaction 0xabc not found on-chain after 10 consecutive lookups");
    expect(out).toMatch(/tracking failed/i);
    expect(out).toMatch(/pelacakan|gagal/i); // Indonesian line
  });

  it("HTML-escapes ORDER_PIPELINE_FAILED interpolated values", () => {
    const out = render("ORDER_PIPELINE_FAILED", {
      order_code: "<b>ORD</b>",
      reason: "<script>alert(1)</script>",
    });
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<b>ORD</b>");
    expect(out).toContain("&lt;b&gt;ORD&lt;/b&gt;");
  });

  it("returns empty string for unknown events", () => {
    expect(render("something.else", payload)).toBe("");
    // lowercase value form is NOT what is stored -> must not match
    expect(render("order.delivered", payload)).toBe("");
  });

  it("appends a via-Website line when the payload flags it", () => {
    const text = render("ORDER_DELIVERED", {
      buyer_language: "en",
      items: [{ name: "Netflix", qty: 1 }],
      masked_buyer_id: "WEB-buXXX",
      total: "40000",
      currency: "IDR",
      delivered_at: "2026-06-12 10:00 UTC",
      via_website: true,
    });
    expect(text).toContain("via Website");
  });

  it("omits the marker when the flag is absent", () => {
    const text = render("ORDER_DELIVERED", {
      buyer_language: "en",
      items: [],
      masked_buyer_id: "1234XXXX",
      total: "1",
      currency: "IDR",
      delivered_at: "x",
    });
    expect(text).not.toContain("via Website");
  });
});
