import { describe, expect, it } from "vitest";
import { canonicalProduct } from "@app/core/canonicalProduct";
import { presentCanonicalCatalog, visualWidth, compactQuantity } from "../src/util/canonicalPresenter";

const item = (id: number, name: string, price = "21000", currency: "IDR" | "USD" = "IDR", locale = "id") => canonicalProduct({
  denomination: { id, name, durationLabel: name, supplierRawName: name, supplierSku: `sku-${id}`, autoDeliverySource: "digiflazz", isActive: true },
  product: { id: 3, name: "Mobile Legends", isActive: true, gameRegion: "Indonesia" },
  category: { id: 1, name: "Top Up", isActive: true },
}, { effectivePriceIDR: price, preferredCurrency: currency, rate: "16000", locale });

describe("canonical Telegram catalog", () => {
  it("keeps a qualifier even when its letters appear inside a different word", () => {
    const product = item(1, "86 Diamonds");
    product.qualifiers = ["A"];
    expect(presentCanonicalCatalog([product]).pages[0]!.text).toContain(" · A");
  });
  it("does not let an unknown name impersonate another item's fallback identifier", () => {
    const long = item(17, "Unknown ".repeat(20));
    const unknown = item(18, "#17");
    long.qualifiers = unknown.qualifiers = [];
    const labels = presentCanonicalCatalog([long, unknown]).pages[0]!.rows.flat().map((b) => b.text);
    expect(new Set(labels).size).toBe(2);
  });
  it("pairs short final labels but switches to single rows for wider USD figures", () => {
    const idr = [item(1, "5 Diamonds", "1000000", "IDR", "en"), item(2, "6 Diamonds", "1000000", "IDR", "en")];
    for (const p of idr) p.qualifiers = [];
    const usd = idr.map((p) => ({ ...p, displayPrice: { currency: "USD" as const, amountMinor: "100000000", scale: 2 as const }, formattedPrice: "$1,000,000.00", conversion: { basis: "USDT" as const, direction: "IDR_PER_USDT" as const, rate: "1", rounding: "CEIL_2DP" as const, source: "caller" as const, asOf: null } }));
    expect(presentCanonicalCatalog(idr, { locale: "en" }).pages[0]!.rows.map((row) => row.length)).toEqual([2]);
    expect(presentCanonicalCatalog(usd, { locale: "en" }).pages[0]!.rows.map((row) => row.length)).toEqual([1, 1]);
  });
  it("preserves bonus, qualifier and exact price beside stable callbacks", () => {
    const result = presentCanonicalCatalog([item(17, "Mobile Legends 86 Diamonds + 8 Bonus via ID Promo", "21000.1254")]);
    expect(result.pages[0]!.text).toContain("86 Diamonds + 8 Bonus via ID Promo");
    expect(result.pages[0]!.text).toContain("Indonesia");
    expect(result.pages[0]!.text).toContain("Rp21.000,1254");
    expect(result.pages[0]!.rows.flat()[0]!.callback_data).toBe("v1:browse:denom:17");
    expect(result.pages[0]!.rows.flat()[0]!.text).not.toContain("…");
  });
  it("resolves rounded-price collisions with stable IDs and remeasures final labels", () => {
    const result = presentCanonicalCatalog([item(17, "86 Diamonds", "20001"), item(18, "86 Diamonds", "20002")]);
    const buttons = result.pages[0]!.rows.flat();
    expect(buttons[0]!.text).not.toBe(buttons[1]!.text);
    expect(buttons[0]!.text).toContain("#17");
    expect(buttons[1]!.text).toContain("#18");
    expect(result.pages[0]!.text).toContain("Rp20.001");
    expect(result.pages[0]!.text).toContain("Rp20.002");
  });
  it("uses lossless compact quantities including 9375 and large safe integers", () => {
    expect(compactQuantity(10000)).toBe("10K");
    expect(compactQuantity(9375)).toBe("9.375K");
    expect(compactQuantity(10001)).toBe("10.001K");
    expect(compactQuantity(Number.MAX_SAFE_INTEGER)).toBe("9007199254.740991M");
  });
  it("measures CJK and emoji graphemes conservatively", () => {
    expect(visualWidth("你好")).toBe(4);
    expect(visualWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(visualWidth("e\u0301")).toBe(1);
  });
  it("uses final currency/locale price before layout and exact fallback", () => {
    const idr = presentCanonicalCatalog([item(1, "5 Diamonds", "1000000", "IDR", "id"), item(2, "6 Diamonds", "1000000", "IDR", "id")], { locale: "id" });
    const usd = presentCanonicalCatalog([item(1, "5 Diamonds", "1000000", "USD", "id"), item(2, "6 Diamonds", "1000000", "USD", "id")], { locale: "id" });
    expect(idr.pages[0]!.rows.flat()[0]!.text).toContain("Rp1M");
    expect(usd.pages[0]!.rows.flat()[0]!.text).toContain("$62,50");
    expect(usd.pages[0]!.text).toContain("$62,50");
  });
  it("paginates unknown and huge names without semantic clipping or callback byte overflow", () => {
    const products = Array.from({ length: 35 }, (_, i) => item(i + 1, `Unknown ${i} ${"你好 👨‍👩‍👧‍👦 qualifier ".repeat(12)}`));
    products.push(item(99, `Mystery ${"x".repeat(9000)} final qualifier`));
    const result = presentCanonicalCatalog(products);
    expect(result.pages.length).toBeGreaterThan(1);
    const full = result.pages.map((p) => p.text).join("");
    expect(full).toContain("final qualifier");
    for (const p of result.pages) {
      expect(p.text.length).toBeLessThanOrEqual(3000);
      for (const row of p.rows) {
        expect(row).toHaveLength(1);
        for (const button of row) expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
      }
    }
    expect(result.pages.flatMap((p) => p.rows.flat()).map((b) => b.callback_data)).toContain("v1:browse:denom:99");
  });

  it("bounds a single oversized combining grapheme without losing text or creating a huge button", () => {
    const name = `x${"\u0301".repeat(5000)} <&> final qualifier \u{1F642}`;
    const product = item(91, name);
    product.qualifiers = [];

    const result = presentCanonicalCatalog([product]);
    const blocks = result.pages.flatMap((page) => {
      expect(page.text.length).toBeLessThanOrEqual(3000);
      return [...page.text.matchAll(/#91 · Rp21\.000\n([\s\S]*?)\n\n/g)].map((match) => match[1]!);
    });
    expect(blocks.join("")).toBe(`x${"\u0301".repeat(5000)} &lt;&amp;&gt; final qualifier \u{1F642}`);
    const buttons = result.pages.flatMap((page) => page.rows.flat());
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.text).toBe("#91");
      expect(button.callback_data).toBe("v1:browse:denom:91");
    }
  });
});
