import { describe, expect, it } from "vitest";
import { canonicalProduct } from "@app/core/canonicalProduct";
import { presentCanonicalCatalog, visualWidth, compactQuantity, MAX_LABEL_WIDTH, NARROW_LABEL_WIDTH } from "../src/util/canonicalPresenter";

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
  it("shows quantities in full unless they are a clean multiple of 1000 from 10K", () => {
    expect(compactQuantity(999)).toBe("999");
    expect(compactQuantity(1186)).toBe("1186");
    expect(compactQuantity(9375)).toBe("9375");
    expect(compactQuantity(10000)).toBe("10K");
    expect(compactQuantity(10001)).toBe("10001");
    expect(compactQuantity(1234000)).toBe("1234K");
    expect(compactQuantity(1500000, "en")).toBe("1.5M");
    expect(compactQuantity(1500000, "id")).toBe("1,5M");
    expect(compactQuantity(25000000)).toBe("25M");
    expect(compactQuantity(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
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
    // An item already clear on its button is not repeated in the body.
    expect(usd.pages[0]!.rows.flat()[0]!.text).toBe("5 💎 · $62,50");
    expect(usd.pages[0]!.text).not.toContain("$62,50");
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

// Synthetic fixtures. Names mirror supplier shapes seen in
// packages/core/src/detection/__fixtures__/catalogSnapshot.json; prices are made up.
interface Opts { price?: string; currency?: "IDR" | "USD"; locale?: string; product?: { name?: string; gameVariant?: string | null; gameRegion?: string | null } }
const make = (id: number, raw: string, opts: Opts = {}) => canonicalProduct({
  denomination: { id, name: raw, durationLabel: raw, supplierRawName: raw, supplierSku: `sku-${id}`, autoDeliverySource: "digiflazz", isActive: true },
  product: { id: 3, name: "Mobile Legends", isActive: true, gameRegion: null, gameVariant: null, ...opts.product },
  category: { id: 1, name: "Top Up", isActive: true },
}, { effectivePriceIDR: opts.price ?? "21000", preferredCurrency: opts.currency ?? "IDR", rate: "16000", locale: opts.locale ?? "id" });
const deltaForce = { name: "Delta Force", gameVariant: "Garena" };
const growtopia = { name: "Growtopia" };
const labels = (result: ReturnType<typeof presentCanonicalCatalog>) => result.pages.flatMap((p) => p.rows.flat().map((b) => b.text));

describe("canonical Telegram label candidates", () => {
  it("compacts an amount to its quantity, unit icon and formatted price; the shared region moves to the body", () => {
    const result = presentCanonicalCatalog([
      make(1, "86 Diamonds (Global)", { price: "18500", currency: "USD", product: { gameRegion: "Global" } }),
      make(2, "172 Diamonds (Global)", { price: "37000", currency: "USD", product: { gameRegion: "Global" } }),
    ]);
    expect(labels(result)).toEqual(["86 💎 · $1,16", "172 💎 · $2,32"]);
    expect(result.pages[0]!.text).toContain("Mobile Legends · Global");
    expect(result.pages[0]!.text).not.toContain("#1 ·");
    expect(result.pages[0]!.rows.map((row) => row.length)).toEqual([2]);
  });
  it("joins a same-unit bonus into one quantity", () => {
    expect(labels(presentCanonicalCatalog([make(1, "100 + 10 Diamonds", { price: "25000" })]))).toEqual(["100+10 💎 · Rp25K"]);
    expect(labels(presentCanonicalCatalog([make(1, "86 Diamonds + 8 Bonus", { price: "25000" })]))).toEqual(["86+8 💎 · Rp25K"]);
  });
  it("keeps a different-unit bonus spelled out and explains it in the body", () => {
    const result = presentCanonicalCatalog([make(5, "1000 Diamonds + 100 Bonds", { price: "250000" })]);
    expect(labels(result)).toEqual(["1000 Diamonds + 100 Bonds · Rp250K"]);
    expect(result.pages[0]!.text).toContain("#5 · Rp250.000\n1000 Diamonds + 100 Bonds");
  });
  it("labels package, pass with duration, voucher and bundle by their name", () => {
    const result = presentCanonicalCatalog([
      make(1, "Gem Fountain", { price: "40000", product: growtopia }),
      make(2, "Weekly Diamond Pass", { price: "27000" }),
      make(3, "Twilight Pass 30 Days", { price: "150000" }),
      make(4, "Starlight Voucher", { price: "50000" }),
      make(5, "Starter Bundle", { price: "60000" }),
    ]);
    expect(labels(result)).toEqual(["Gem Fountain · Rp40K", "Weekly Diamond Pass · Rp27K", "Twilight Pass 30 Days · Rp150K", "Starlight Voucher · Rp50K", "Starter Bundle · Rp60K"]);
    // A pass named after diamonds is still a pass, never a diamond amount.
    expect(labels(result).join(" ")).not.toContain("💎");
  });
  it("maps World Lock to WL and keeps an unmapped unit's own name", () => {
    expect(labels(presentCanonicalCatalog([make(1, "100 World Lock", { price: "25000", product: growtopia })]))).toEqual(["100 WL · Rp25K"]);
    expect(labels(presentCanonicalCatalog([make(1, "10000 Bonds", { price: "150000" })]))).toEqual(["10K Bonds · Rp150K"]);
    expect(labels(presentCanonicalCatalog([make(1, "500 Tokens", { price: "15000" })]))).toEqual(["500 Tokens · Rp15K"]);
  });
  it("uses the coin icon alone but spells units out when two different units would share it", () => {
    expect(labels(presentCanonicalCatalog([make(1, "Delta Force 18 Delta Coins - Garena", { price: "5000", product: deltaForce })]))).toEqual(["18 🪙 · Rp5K"]);
    const mixed = labels(presentCanonicalCatalog([make(1, "300 Delta Coins", { price: "5000" }), make(2, "300 Coins", { price: "5000" })]));
    expect(mixed).toEqual(["300 Delta Coins · Rp5K", "300 Coins · Rp5K"]);
  });
  it("never doubles a qualifier and keeps a conflicting one visible", () => {
    const result = presentCanonicalCatalog([
      make(1, "Delta Force 18 Delta Coins - Garena", { price: "5000", product: deltaForce }),
      make(2, "Delta Force 60 Delta Coins - Garena", { price: "15000", product: deltaForce }),
    ]);
    const all = labels(result).join(" ") + result.pages[0]!.text;
    expect(all).not.toMatch(/Garena\W+Garena/);
    expect(result.pages[0]!.text).toContain("Delta Force · Garena");
    const conflict = presentCanonicalCatalog([make(1, "Delta Force 18 Delta Coins - Tencent", { price: "5000", product: deltaForce })]);
    expect(labels(conflict)[0]).toContain("Tencent");
    expect(conflict.pages[0]!.text).toContain("Garena");
  });
  it("only lifts a qualifier into the body when every product shares it", () => {
    const a = make(1, "86 Diamonds", { price: "20000" });
    const b = make(2, "172 Diamonds", { price: "40000" });
    a.qualifiers = ["Global"];
    b.qualifiers = ["Indonesia"];
    const result = presentCanonicalCatalog([a, b]);
    expect(labels(result)).toEqual(["86 💎 · Global · Rp20K", "172 💎 · Indonesia · Rp40K"]);
    expect(result.pages[0]!.text).not.toContain("Mobile Legends ·");
  });
  it("keeps a legitimately repeated word in a package name", () => {
    expect(labels(presentCanonicalCatalog([make(1, "Diamond Diamond Package", { price: "30000", product: { gameVariant: "Diamond" } })]))).toEqual(["Diamond Diamond Package · Rp30K"]);
  });
  it("never rounds a non-round quantity and keeps big values exact", () => {
    expect(labels(presentCanonicalCatalog([make(1, "1186 Diamonds", { price: "300000" })]))).toEqual(["1186 💎 · Rp300K"]);
    expect(labels(presentCanonicalCatalog([make(1, "1186 Diamonds", { price: "300000", locale: "en" })], { locale: "en" }))).toEqual(["1186 💎 · Rp300K"]);
    expect(labels(presentCanonicalCatalog([make(1, "9007199254740991 Diamonds", { price: "300000" })]))).toEqual(["9007199254740991 💎 · Rp300K"]);
  });
  it("shows bonus, coin, WL and Bonds amounts in full, and keeps wide bonus labels within the button budget", () => {
    expect(labels(presentCanonicalCatalog([make(1, "500 + 65 Diamonds", { price: "100000" })]))).toEqual(["500+65 💎 · Rp100K"]);
    expect(labels(presentCanonicalCatalog([make(1, "1186 + 224 Diamonds", { price: "300000" })]))).toEqual(["1186+224 💎 · Rp300K"]);
    expect(labels(presentCanonicalCatalog([make(1, "1280 Delta Coins", { price: "150000", product: deltaForce })]))).toEqual(["1280 🪙 · Rp150K"]);
    expect(labels(presentCanonicalCatalog([make(1, "100 World Lock", { price: "25000", product: growtopia })]))).toEqual(["100 WL · Rp25K"]);
    expect(labels(presentCanonicalCatalog([make(1, "10000 Bonds", { price: "150000" })]))).toEqual(["10K Bonds · Rp150K"]);
    const usd = presentCanonicalCatalog([make(1, "5136 + 1027 Diamonds", { price: "1644000", currency: "USD", locale: "en" }), make(2, "86 Diamonds", { price: "20000", currency: "USD", locale: "en" })], { locale: "en" });
    const [wide] = labels(usd);
    expect(wide).toBe("5136+1027 💎 · $102.75");
    expect(visualWidth(wide!)).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
    expect(visualWidth(wide!)).toBeGreaterThan(NARROW_LABEL_WIDTH);
    expect(usd.pages[0]!.rows.map((row) => row.length)).toEqual([1, 1]);
  });
  it("resolves a collision after formatting with the full unit name before an ID", () => {
    const result = labels(presentCanonicalCatalog([
      make(1, "100 World Lock", { price: "25000", product: growtopia }),
      make(2, "100 World Locks", { price: "25000", product: growtopia }),
    ]));
    expect(result).toEqual(["100 World Lock · Rp25K", "100 World Locks · Rp25K"]);
  });
  it("never lets price be the only difference between two SKUs with the same name", () => {
    const result = presentCanonicalCatalog([make(1, "86 Diamonds", { price: "20000" }), make(2, "86 Diamonds", { price: "25000" })]);
    expect(labels(result)).toEqual(["86 💎 · Rp20K #1", "86 💎 · Rp25K #2"]);
    expect(result.pages[0]!.text).toContain("#1 · Rp20.000\n86 Diamonds");
    expect(result.pages[0]!.text).toContain("#2 · Rp25.000\n86 Diamonds");
  });
  it("spells out what compacting hid when only the price would differ", () => {
    expect(labels(presentCanonicalCatalog([
      make(1, "100 World Lock", { price: "25000", product: growtopia }),
      make(2, "100 World Locks", { price: "26000", product: growtopia }),
    ]))).toEqual(["100 World Lock · Rp25K", "100 World Locks · Rp26K"]);
  });
  it("leaves no two buttons identical once the price is removed, unless the body explains both", () => {
    // Synthetic mix: same name, compact-hidden plural, same-unit bonus label, rounding collision, distinct items.
    const products = [
      make(1, "86 Diamonds", { price: "20000" }), make(2, "86 Diamonds", { price: "25000" }),
      make(3, "100 World Lock", { price: "25000", product: growtopia }), make(4, "100 World Locks", { price: "26000", product: growtopia }),
      make(5, "86 Diamonds + 8 Bonus", { price: "30000" }), make(6, "86 + 8 Diamonds", { price: "31000" }),
      make(7, "172 Diamonds", { price: "40001" }), make(8, "172 Diamonds", { price: "40002" }),
      make(9, "257 Diamonds", { price: "60000" }),
    ];
    const result = presentCanonicalCatalog(products);
    const text = result.pages.map((p) => p.text).join("");
    const buttons = result.pages.flatMap((p) => p.rows.flat());
    const identity = (label: string) => label.replace(/ · [^·]*$/, "");
    for (const a of buttons) for (const b of buttons) {
      if (a === b || identity(a.text) !== identity(b.text)) continue;
      for (const button of [a, b]) expect(text).toContain(`#${button.callback_data.split(":").at(-1)} · `);
    }
    expect(new Set(buttons.map((b) => b.text)).size).toBe(buttons.length);
  });
  it("re-checks collisions after the width fallback and explains every fallback", () => {
    const name = "Long Seasonal Collector Pass Edition";
    const result = presentCanonicalCatalog([make(17, name, { price: "20001" }), make(18, name, { price: "20002" })]);
    expect(labels(result)).toEqual(["#17", "#18"]);
    expect(result.pages[0]!.text).toContain(`#17 · Rp20.001\n${name}`);
    expect(result.pages[0]!.text).toContain(`#18 · Rp20.002\n${name}`);
  });
  it("decides fit after the final currency is formatted", () => {
    const name = "Long Seasonal Collector Pass Edition";
    expect(labels(presentCanonicalCatalog([make(1, name, { price: "1000000", currency: "IDR" })]))).toEqual([`${name} · Rp1M`]);
    const usd = presentCanonicalCatalog([make(1, name, { price: "1600000000", currency: "USD" })]);
    expect(labels(usd)).toEqual(["#1"]);
    expect(usd.pages[0]!.text).toContain(`#1 · $100.000,00\n${name}`);
  });
  it("labels the 'Black Hawk Down Redefine  - Garena' unknown item instead of falling back to its ID", () => {
    const raw = "Delta Force Black Hawk Down Redefine  - Garena";
    const shared = presentCanonicalCatalog([make(30025111, raw, { price: "150000", product: deltaForce }), make(2, "Delta Force 18 Delta Coins - Garena", { price: "5000", product: deltaForce })]);
    expect(labels(shared)).toEqual(["Black Hawk Down Redefine · Rp150K", "18 🪙 · Rp5K"]);
    // Unknown items still get their exact name and price in the body.
    expect(shared.pages[0]!.text).toContain("#30025111 · Rp150.000\nBlack Hawk Down Redefine - Garena");
    const usd = presentCanonicalCatalog([make(1, raw, { price: "150000", currency: "USD", product: { name: "Delta Force", gameVariant: null } })]);
    expect(labels(usd)).toEqual(["Black Hawk Down Redefine - Garena · $9,38"]);
  });
  it("puts each fallback item's name and price on the same page as its button", () => {
    const products = Array.from({ length: 21 }, (_, i) => make(i + 1, `${i + 1} Diamonds`, { price: "20000" }));
    products.push(make(122, `Mystery ${"long words ".repeat(6)}`, { price: "20000" }));
    const result = presentCanonicalCatalog(products);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]!.rows.flat()).toHaveLength(20);
    const last = result.pages[1]!;
    expect(last.rows.flat().map((b) => b.text)).toEqual(["21 💎 · Rp20K", "#122"]);
    expect(last.text).toContain("#122 · Rp20.000\nMystery");
    expect(result.pages[0]!.text).not.toContain("#122");
    expect(last.text).not.toContain("#21 ·");
  });
  it("keeps stock lines in the body and callbacks within 64 bytes", () => {
    const id = Number.MAX_SAFE_INTEGER;
    const result = presentCanonicalCatalog([make(id, "1 Month Premium Package", { price: "50000" })], { stockLabels: { [id]: "3" } });
    expect(result.pages[0]!.text).toContain(`#${id} · Rp50.000 (Stok 3)`);
    const button = result.pages[0]!.rows.flat()[0]!;
    expect(button.callback_data).toBe(`v1:browse:denom:${id}`);
    expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(button.text, "utf8")).toBeLessThanOrEqual(64);
  });
});
