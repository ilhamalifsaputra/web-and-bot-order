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

  it("renders ADMIN_PW_RESET as a bilingual DM with the code and TTL", () => {
    const out = render("ADMIN_PW_RESET", { code: "048273", ttl_minutes: 10 });
    expect(out).toContain("<code>048273</code>");
    expect(out).toContain("valid 10 min");
    expect(out).toContain("Web admin password reset");
    expect(out).toContain("Reset password admin web"); // Indonesian line
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
