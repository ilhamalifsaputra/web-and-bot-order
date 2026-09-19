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

  it("keeps HTML tags balanced when the item list would otherwise be cut mid-tag (Important fix)", () => {
    // Build items whose formatted lines contain <i>...</i> duration tags, then
    // find an item count where a naive `.slice(0, 300)` on the joined lines
    // would land inside one of those tags -- this is the exact bug the fix
    // addresses (a raw char-index cut split `<i>`/`</i>` across the boundary,
    // producing unclosed-tag HTML that made Telegram's `parse_mode: "HTML"`
    // reject the whole message and fail the notification permanently).
    // Fixed-width line (no per-item index) so every line has an identical
    // length and the arithmetic below is exact.
    const makeLine = () => `   • Item <i>(Month)</i> x1`;
    let breakingCount = -1;
    for (let n = 1; n <= 60; n++) {
      const lines = Array.from({ length: n }, () => makeLine());
      const naiveJoined = lines.join("\n");
      if (naiveJoined.length > 300) {
        const cut = naiveJoined.slice(0, 300);
        const openTags = (cut.match(/<i>/g) ?? []).length;
        const closeTags = (cut.match(/<\/i>/g) ?? []).length;
        if (openTags !== closeTags) {
          breakingCount = n;
          break;
        }
      }
    }
    // Sanity check: confirms the naive-slice bug scenario is actually reachable
    // with these inputs, so the assertions below are exercising the real fix.
    expect(breakingCount).toBeGreaterThan(0);

    const items = Array.from({ length: breakingCount }, () => ({
      name: "Item",
      duration: "Month",
      qty: 1,
    }));
    const out = render("ORDER_DELIVERED", { ...payload, items });
    const productsLine = out.split("\n").find((l) => l.startsWith("🛍️"))!;
    const idx = out.indexOf(productsLine);
    const productsBlock = out.slice(idx + productsLine.length + 1, out.indexOf("💳"));
    const openTags = (productsBlock.match(/<i>/g) ?? []).length;
    const closeTags = (productsBlock.match(/<\/i>/g) ?? []).length;
    expect(openTags).toBe(closeTags);
    // No dangling unclosed tag at the very end (e.g. "...<i>(Mo" with no ">").
    expect(productsBlock).not.toMatch(/<[^>]*$/);
  });

  it("does not truncate mid-HTML-entity for the buyer field (minor fix)", () => {
    // Escaped "'" -> "&#x27;" (6 chars); positioning it so the entity straddles
    // the 300-char cut reproduces a naive slice landing mid-entity (e.g.
    // "&#x27" with no trailing ";"), which renders as inert text rather than
    // breaking HTML parsing, but is still worth avoiding.
    const longId = "A".repeat(295) + "'" + "B".repeat(20);
    const out = render("ORDER_DELIVERED", { ...payload, masked_buyer_id: longId });
    const buyerMatch = out.match(/<code>([^<]*)<\/code>/);
    const buyerText = buyerMatch![1]!;
    expect(buyerText.endsWith("&")).toBe(false);
    // No trailing partial entity (a "&...;"-shaped sequence missing its ";").
    expect(buyerText).not.toMatch(/&(?:[a-zA-Z]+|#x?[0-9a-fA-F]+)$/);
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

  it("renders ADMIN_STALE_PAYMENT as a bilingual admin DM with the gateway, order code and trx id", () => {
    const out = render("ADMIN_STALE_PAYMENT", {
      order_code: "ORD-STALE-1",
      gateway: "TokoPay",
      trx_id: "TRX-STALE-1",
    });
    expect(out).toContain("<code>ORD-STALE-1</code>");
    expect(out).toContain("TokoPay");
    expect(out).toContain("<code>TRX-STALE-1</code>");
    expect(out).toMatch(/no longer pending/i);
    expect(out).toMatch(/tidak lagi menunggu pembayaran/i); // Indonesian line
  });

  it("HTML-escapes ADMIN_STALE_PAYMENT interpolated values", () => {
    const out = render("ADMIN_STALE_PAYMENT", {
      order_code: "<b>ORD</b>",
      gateway: "<script>alert(1)</script>",
      trx_id: "<i>trx</i>",
    });
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<b>ORD</b>");
    expect(out).not.toContain("<i>trx</i>");
    expect(out).toContain("&lt;b&gt;ORD&lt;/b&gt;");
  });

  it("renders ADMIN_DIGIFLAZZ_RESYNC_ABORTED as a bilingual admin DM with the sharp-change and considered-row counts for kind sharp_change", () => {
    const out = render("ADMIN_DIGIFLAZZ_RESYNC_ABORTED", {
      kind: "sharp_change",
      sharp_changes: 7,
      considered_rows: 10,
    });
    expect(out).toContain("7");
    expect(out).toContain("10");
    expect(out).toMatch(/aborted/i);
    expect(out).toMatch(/dibatalkan/i); // Indonesian line
    expect(out).toMatch(/moved by more than 50%/i);
  });

  it("HTML-escapes ADMIN_DIGIFLAZZ_RESYNC_ABORTED interpolated values", () => {
    const out = render("ADMIN_DIGIFLAZZ_RESYNC_ABORTED", {
      kind: "sharp_change",
      sharp_changes: "<script>alert(1)</script>",
      considered_rows: "<b>10</b>",
    });
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<b>10</b>");
    expect(out).toContain("&lt;b&gt;10&lt;/b&gt;");
  });

  it("renders a distinct bilingual sentence for ADMIN_DIGIFLAZZ_RESYNC_ABORTED kind no_usable_rows instead of the sharp-change wording", () => {
    const out = render("ADMIN_DIGIFLAZZ_RESYNC_ABORTED", {
      kind: "no_usable_rows",
    });
    expect(out).toMatch(/aborted/i);
    expect(out).toMatch(/dibatalkan/i); // Indonesian header
    // Must not fall back to the misleading "0 of 0 prices" sharp-change sentence.
    expect(out).not.toMatch(/moved by more than 50%/i);
    expect(out).not.toContain("0 of 0");
    expect(out).toMatch(/no usable price data/i);
    expect(out).toMatch(/tidak mengembalikan data harga/i);
  });

  // M13 / audit P0-3. The two FX alerts are deliberately distinct events with
  // distinct wording: one says "nothing broke yet, go check the rate source",
  // the other says "USDT is off right now". Reading the wrong one would send an
  // admin looking for a problem that either does not exist or is worse than
  // they think, so each test pins the sentence that tells them apart.
  it("renders ADMIN_FX_RATE_REJECTED with the deviation figures and the rate still in effect", () => {
    const out = render("ADMIN_FX_RATE_REJECTED", {
      reason: "delta_too_large",
      market: "17500",
      rate: "17500",
      saved: "16200",
      consecutive_failures: 3,
      last_known: "16200",
      delta_pct: "8.02",
      max_delta_pct: "5",
    });
    expect(out).toContain("8.02%");
    expect(out).toContain("16200");
    expect(out).toContain("17500");
    expect(out).toContain("3"); // the failure streak
    expect(out).toMatch(/still in effect/i);
    expect(out).toMatch(/masih dipakai/i); // Indonesian line
  });

  it("names the bound for a band rejection and never claims a deviation it did not measure", () => {
    const out = render("ADMIN_FX_RATE_REJECTED", {
      reason: "above_max",
      market: "16200000",
      rate: "16200000",
      saved: null,
      consecutive_failures: 1,
      max: "40000",
    });
    expect(out).toContain("40000");
    expect(out).toMatch(/above the maximum/i);
    expect(out).not.toMatch(/% away from the saved/i);
    // A shop that has never saved a rate must not be told it is pricing off one.
    expect(out).toMatch(/no saved rate/i);
  });

  it("falls back to a reason-free sentence for a rate that is not a usable number", () => {
    const out = render("ADMIN_FX_RATE_REJECTED", {
      reason: "not_positive",
      market: "16.2",
      rate: "0",
      saved: "16000",
      consecutive_failures: 1,
    });
    expect(out).toMatch(/not a usable price/i);
    expect(out).not.toMatch(/below the minimum|above the maximum/i);
  });

  it("HTML-escapes ADMIN_FX_RATE_REJECTED interpolated values", () => {
    const out = render("ADMIN_FX_RATE_REJECTED", {
      reason: "below_min",
      market: "<script>alert(1)</script>",
      rate: "<b>5000</b>",
      saved: "16000",
      consecutive_failures: 1,
      min: "8000",
    });
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<b>5000</b>");
    expect(out).toContain("&lt;b&gt;5000&lt;/b&gt;");
  });

  it("renders ADMIN_FX_RATE_STALE leading with the consequence, not the cause", () => {
    const out = render("ADMIN_FX_RATE_STALE", {
      confirmed_at: "2026-09-14T00:00:00.000Z",
      age_hours: "72.4",
      max_age_hours: "48",
    });
    expect(out).toMatch(/USDT payments are switched off/i);
    expect(out).toContain("2026-09-14T00:00:00.000Z");
    expect(out).toContain("72.4");
    expect(out).toContain("48");
    // Rupiah must be named as unaffected — otherwise an admin reads this as a
    // total checkout outage and panics.
    expect(out).toMatch(/Rupiah payments are unaffected/i);
    expect(out).toMatch(/dimatikan/i); // Indonesian line
  });

  // Whole-branch review D7: the same event now covers the earlier threshold too,
  // and the two must not share wording. At the quote TTL the shop still DISPLAYS
  // USDT prices, so a message claiming USDT is switched off would send an admin
  // to look at their own shop, see USDT prices, and file the alert as a false
  // alarm.
  it("renders the quote-TTL stage of ADMIN_FX_RATE_STALE as 'not offered', not 'switched off'", () => {
    const out = render("ADMIN_FX_RATE_STALE", {
      stage: "quote_ttl",
      confirmed_at: "2026-09-19T00:00:00.000Z",
      age_hours: "3.5",
      ttl_minutes: "180",
    });
    expect(out).toMatch(/not being offered/i);
    expect(out).not.toMatch(/switched off/i);
    expect(out).toContain("2026-09-19T00:00:00.000Z");
    expect(out).toContain("180");
    expect(out).toMatch(/still see USDT prices/i);
    expect(out).toMatch(/Rupiah payments are unaffected/i);
    expect(out).toMatch(/tidak ditawarkan/i); // Indonesian line
  });

  // Rows enqueued before `stage` existed can still be sitting in the outbox when
  // this deploys, and they meant the outer horizon.
  it("renders a stage-less ADMIN_FX_RATE_STALE payload as the max-age message", () => {
    const out = render("ADMIN_FX_RATE_STALE", {
      confirmed_at: "2026-09-14T00:00:00.000Z",
      age_hours: "72.4",
      max_age_hours: "48",
    });
    expect(out).toMatch(/USDT payments are switched off/i);
  });

  it("returns empty string for unknown events", () => {
    expect(render("something.else", payload)).toBe("");
    // lowercase value form is NOT what is stored -> must not match
    expect(render("order.delivered", payload)).toBe("");
  });

  it("renders ORDER_PROCESSING_DM as a bilingual reassurance DM with the order code and link", () => {
    const out = render("ORDER_PROCESSING_DM", {
      order_code: "ORD-PROC-1",
      order_url: "https://shop.example.com/account/orders/ORD-PROC-1",
    });
    expect(out).toContain("<code>ORD-PROC-1</code>");
    expect(out).toContain("https://shop.example.com/account/orders/ORD-PROC-1");
    expect(out).toMatch(/prepared by hand|being prepared/i);
    expect(out).toMatch(/segera mungkin|disiapkan/i); // Indonesian line
    expect(out).not.toMatch(/1\s*[×x]\s*24/); // no hardcoded SLA in this terse DM
  });

  it("omits the link line when order_url is absent for ORDER_PROCESSING_DM", () => {
    const out = render("ORDER_PROCESSING_DM", { order_code: "ORD-PROC-2" });
    expect(out).toContain("<code>ORD-PROC-2</code>");
    expect(out).not.toContain("http");
  });

  it("renders WALLET_TOPUP_CREDITED_DM as a bilingual DM with the order code and money formatted as Rupiah (IDR)", () => {
    const out = render("WALLET_TOPUP_CREDITED_DM", {
      order_code: "TOPUP-IDR-1",
      amount: "50000",
      currency: "IDR",
      new_balance: "125000",
    });
    expect(out).toContain("TOPUP-IDR-1");
    expect(out).toContain("Rp50.000");
    expect(out).toContain("Rp125.000");
    expect(out).toMatch(/top-?up successful/i);
    expect(out).toMatch(/top up berhasil/i); // Indonesian line
  });

  it("renders WALLET_TOPUP_CREDITED_DM correctly for a USDT top-up — money formatted with an explicit unit, not IDR", () => {
    const out = render("WALLET_TOPUP_CREDITED_DM", {
      order_code: "TOPUP-USDT-1",
      amount: "10.5",
      currency: "USDT",
      new_balance: "30.25",
    });
    expect(out).toContain("TOPUP-USDT-1");
    expect(out).toContain("10.5 USDT");
    expect(out).toContain("30.25 USDT");
    expect(out).not.toContain("Rp");
  });

  it("HTML-escapes a malicious WALLET_TOPUP_CREDITED_DM order_code", () => {
    const out = render("WALLET_TOPUP_CREDITED_DM", {
      order_code: "<script>alert(1)</script>",
      amount: "100",
      currency: "IDR",
      new_balance: "100",
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("omits the 'Order <code>' line for WALLET_TOPUP_CREDITED_DM when order_code is absent (legacy pre-Task-E1 row, Finding 5)", () => {
    // A row enqueued before this event carried an order_code and still
    // PENDING at deploy has none — must not render a dangling
    // `Order <code></code> —` prefix, just the sentence without it.
    const out = render("WALLET_TOPUP_CREDITED_DM", {
      amount: "50000",
      currency: "IDR",
      new_balance: "125000",
    });
    expect(out).not.toContain("Order <code>");
    expect(out).not.toContain("Order <code></code>");
    expect(out).toContain("Rp50.000 has been added to your wallet.");
    expect(out).toContain("Rp50.000 telah ditambahkan ke saldo kamu.");
  });

  it("(deliberate contract, Finding 4) render() THROWS for WALLET_TOPUP_CREDITED_DM when amount/new_balance is non-numeric — formatIdr/formatUsdt reject it, and this template does not swallow that", () => {
    // The old raw-passthrough template could never throw; formatIdr/formatUsdt
    // (money formatters shared with live checkout/settlement code) throw on
    // garbage on purpose. Rendering is not the place to silently coerce a
    // corrupt payload into "0" — the caller (dispatcher.ts's drainBatch) is
    // the one that decides what happens next, and is covered separately in
    // dispatcher.test.ts.
    expect(() =>
      render("WALLET_TOPUP_CREDITED_DM", {
        order_code: "TOPUP-BAD-1",
        amount: "not-a-number",
        currency: "IDR",
        new_balance: "100",
      }),
    ).toThrow();
  });

  it("HTML-escapes ORDER_PROCESSING_DM interpolated values", () => {
    const out = render("ORDER_PROCESSING_DM", {
      order_code: "<b>ORD</b>",
      order_url: "https://x.test/<script>",
    });
    expect(out).not.toContain("<b>ORD</b>");
    expect(out).toContain("&lt;b&gt;ORD&lt;/b&gt;");
    expect(out).not.toContain("<script>");
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

  it("renders PRODUCT_RESTOCKED_BROADCAST with the product name and stock count", () => {
    const out = render("PRODUCT_RESTOCKED_BROADCAST", {
      product_name: "1 Month CapCut Pro",
      stock_count: 42,
    });
    expect(out).toContain("👋 Hello!");
    expect(out).toContain("<b>1 Month CapCut Pro</b>");
    expect(out).toContain("back in stock");
    expect(out).toContain("<b>42</b>");
    expect(out).toContain("Order now while supplies last");
  });

  it("HTML-escapes PRODUCT_RESTOCKED_BROADCAST's product_name", () => {
    const out = render("PRODUCT_RESTOCKED_BROADCAST", {
      product_name: "<script>alert(1)</script>",
      stock_count: 5,
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders FLASH_SALE_BROADCAST with the plan, percent off, new price and end time", () => {
    const out = render("FLASH_SALE_BROADCAST", {
      product_name: "CapCut Pro",
      denomination_name: "1 Month",
      discount_percent: "25",
      old_price: "Rp50.000",
      new_price: "Rp37.500",
      ends_at: "2026-07-21 21:00 GMT+7",
    });
    expect(out).toContain("FLASH SALE — 25% OFF");
    expect(out).toContain("<b>CapCut Pro — 1 Month</b>");
    expect(out).toContain("<b>Now Rp37.500</b>");
    expect(out).toContain("<s>Rp50.000</s>");
    expect(out).toContain("2026-07-21 21:00 GMT+7");
  });

  it("HTML-escapes FLASH_SALE_BROADCAST's product and plan names", () => {
    const out = render("FLASH_SALE_BROADCAST", {
      product_name: "<script>alert(1)</script>",
      denomination_name: "A & B",
      discount_percent: "10",
      old_price: "Rp1",
      new_price: "Rp1",
      ends_at: "x",
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("A &amp; B");
  });

  it("renders BULK_PURCHASE_BROADCAST by substituting the admin's template tokens", () => {
    const out = render("BULK_PURCHASE_BROADCAST", {
      product_name: "CapCut Pro",
      denomination_name: "1 Month",
      qty: 10,
      template: "Someone just purchased x{qty} of {product} - {denomination}!",
    });
    expect(out).toBe("Someone just purchased x10 of CapCut Pro - 1 Month!");
  });

  it("HTML-escapes BULK_PURCHASE_BROADCAST's derived values but not the admin's own template text", () => {
    const out = render("BULK_PURCHASE_BROADCAST", {
      product_name: "<script>alert(1)</script>",
      denomination_name: "A & B",
      qty: 5,
      template: "<b>Hot!</b> x{qty} of {product} - {denomination}",
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("A &amp; B");
    expect(out).toContain("<b>Hot!</b>"); // the admin's own markup is trusted, not escaped
  });

  it("renders ADMIN_MANUAL_ORDER_QUEUED with the order code, item, and total/currency, bilingually", () => {
    const out = render("ADMIN_MANUAL_ORDER_QUEUED", {
      order_code: "ORD-20260719-ABCD",
      items: [{ name: "Netflix Premium", qty: 2 }],
      total: "15.5",
      currency: "USDT",
    });
    expect(out).toContain("ORD-20260719-ABCD");
    expect(out).toContain("Netflix Premium x2");
    expect(out).toContain("15.5 USDT");
    expect(out).toContain("needs manual fulfilment");
    expect(out).toContain("perlu difulfil manual");
  });

  it("HTML-escapes ADMIN_MANUAL_ORDER_QUEUED's item names", () => {
    const out = render("ADMIN_MANUAL_ORDER_QUEUED", {
      order_code: "ORD-1",
      items: [{ name: "A & B <x>", qty: 1 }],
      total: "1",
      currency: "USDT",
    });
    expect(out).not.toContain("<x>");
    expect(out).toContain("A &amp; B &lt;x&gt;");
  });

  // Task 2 (Phase C): TICKET_CLOSED_DM is the one of the three new ticket
  // events rendered through this file's render() — ADMIN_NEW_TICKET and
  // TICKET_REPLY_DM need a reply_markup keyboard (and, for ADMIN_NEW_TICKET,
  // a photo media-group send) render() has no way to carry, so
  // dispatcher.ts builds and sends their text itself (see dispatcher.test.ts
  // for those two).
  it("renders TICKET_CLOSED_DM in English by default", () => {
    const out = render("TICKET_CLOSED_DM", {});
    expect(out).toBe("Your ticket has been closed. Open a new one if you need further help.");
  });

  it("renders TICKET_CLOSED_DM in English when buyer_language is 'en'", () => {
    const out = render("TICKET_CLOSED_DM", { buyer_language: "en" });
    expect(out).toBe("Your ticket has been closed. Open a new one if you need further help.");
  });

  it("renders TICKET_CLOSED_DM in Indonesian when buyer_language is 'id'", () => {
    const out = render("TICKET_CLOSED_DM", { buyer_language: "id" });
    expect(out).toBe("Tiket ditutup. Buka tiket baru jika masih butuh bantuan.");
  });

  it("falls back to English for an unrecognized TICKET_CLOSED_DM buyer_language", () => {
    const out = render("TICKET_CLOSED_DM", { buyer_language: "fr" });
    expect(out).toContain("Your ticket has been closed");
  });
});
