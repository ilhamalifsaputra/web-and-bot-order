import { describe, expect, it } from "vitest";
import { canonicalProduct } from "@app/core/canonicalProduct";
import catalog from "../../../packages/core/src/detection/__fixtures__/catalogSnapshot.json";
import { canonicalName, presentCanonicalCatalog, visualWidth, compactQuantity, MAX_LABEL_WIDTH, NARROW_LABEL_WIDTH, TARGET_LABEL_WIDTH } from "../src/util/canonicalPresenter";

const item = (id: number, name: string, price = "21000", currency: "IDR" | "USD" = "IDR", locale = "id") => canonicalProduct({
  denomination: { id, name, durationLabel: name, supplierRawName: name, supplierSku: `sku-${id}`, autoDeliverySource: "digiflazz", isActive: true },
  product: { id: 3, name: "Mobile Legends", isActive: true, gameRegion: "Indonesia" },
  category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
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
      // The enormous first word leaves the button (the end of the name survives behind one ellipsis); the body keeps all of it.
      expect(button.text).toBe("…<&> final qualifier 🙂 · Rp21K");
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
  category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
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
  it("never doubles a qualifier", () => {
    const result = presentCanonicalCatalog([
      make(1, "Delta Force 18 Delta Coins - Garena", { price: "5000", product: deltaForce }),
      make(2, "Delta Force 60 Delta Coins - Garena", { price: "15000", product: deltaForce }),
    ]);
    const all = labels(result).join(" ") + result.pages[0]!.text;
    expect(all).not.toMatch(/Garena\W+Garena/);
    expect(result.pages[0]!.text).toContain("Delta Force · Garena");
  });
  it("does not state a shared qualifier in the header when an item carries a conflicting one; the SKU keeps both", () => {
    const conflict = presentCanonicalCatalog([make(1, "Delta Force 18 Delta Coins - Tencent", { price: "5000", product: deltaForce })]);
    expect(conflict.pages[0]!.text).not.toContain("Delta Force · Garena");
    expect(labels(conflict)[0]).toContain("Tencent");
    expect(labels(conflict)[0]).toContain("Garena");
    expect(conflict.pages[0]!.text).toContain("18 Delta Coins - Tencent · Garena");
    const mixed = presentCanonicalCatalog([
      make(1, "Delta Force 18 Delta Coins - Garena", { price: "5000", product: deltaForce }),
      make(2, "Delta Force 18 Delta Coins - Tencent", { price: "5000", product: deltaForce }),
    ]);
    expect(mixed.pages[0]!.text).not.toContain("Delta Force · Garena");
    expect(labels(mixed).join(" ")).toContain("Tencent");
  });
  it("keeps the shared region in the header when other items only carry parentheses, digits or an intra-word hyphen", () => {
    const global = { gameRegion: "Global" };
    const wdp = presentCanonicalCatalog([
      make(1, "86 Diamonds", { price: "20000", product: global }),
      make(2, "172 Diamonds", { price: "40000", product: global }),
      make(3, "Weekly Diamond Pass (x2)", { price: "54000", product: global }),
    ]);
    expect(labels(wdp)).toEqual(["86 💎 · Rp20K", "172 💎 · Rp40K", "Weekly Diamond Pass (x2) · Rp54K"]);
    expect(wdp.pages[0]!.text).toContain("Mobile Legends · Global");
    expect(wdp.pages[0]!.rows.map((row) => row.length)).toEqual([2, 1]);
    const hyphen = presentCanonicalCatalog([
      make(1, "86 Diamonds", { price: "20000", product: global }),
      make(2, "Super-Value Package", { price: "30000", product: global }),
      make(3, "Twilight Pass", { price: "150000", product: global }),
    ]);
    expect(labels(hyphen).join(" ")).not.toContain("Global");
    expect(hyphen.pages[0]!.text).toContain("Mobile Legends · Global");
    const promo = presentCanonicalCatalog([
      make(1, "86 Diamonds (Promo)", { price: "19000" , product: { gameRegion: "Indonesia" } }),
      make(2, "172 Diamonds", { price: "40000", product: { gameRegion: "Indonesia" } }),
    ]);
    expect(labels(promo)).toEqual(["86 💎 (Promo) · Rp19K", "172 💎 · Rp40K"]);
    expect(promo.pages[0]!.text).toContain("Mobile Legends · Indonesia");
    expect(promo.pages[0]!.rows.map((row) => row.length)).toEqual([1, 1]); // "(Promo)" already makes the first label wider than the pairing limit
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
    // Both still collide after the width fallback, so the ID tells them apart; the body carries the full name and exact price.
    expect(labels(result)).toEqual(["Long… Pass Edition · Rp20K #17", "Long… Pass Edition · Rp20K #18"]);
    expect(result.pages[0]!.text).toContain(`#17 · Rp20.001\n${name}`);
    expect(result.pages[0]!.text).toContain(`#18 · Rp20.002\n${name}`);
  });
  it("decides fit after the final currency is formatted", () => {
    const name = "Seasonal Collector Pass";
    expect(labels(presentCanonicalCatalog([make(1, name, { price: "1000000", currency: "IDR" })]))).toEqual([`${name} · Rp1M`]);
    const usd = presentCanonicalCatalog([make(1, name, { price: "1600000000", currency: "USD" })]);
    expect(labels(usd)).toEqual(["…Collector Pass · $100.000,00"]);
    expect(usd.pages[0]!.text).toContain(`#1 · $100.000,00\n${name}`);
  });
  it("labels the 'Black Hawk Down Redefine  - Garena' unknown item instead of falling back to its ID", () => {
    const raw = "Delta Force Black Hawk Down Redefine  - Garena";
    const shared = presentCanonicalCatalog([make(30025111, raw, { price: "150000", product: deltaForce }), make(2, "Delta Force 18 Delta Coins - Garena", { price: "5000", product: deltaForce })]);
    expect(labels(shared)).toEqual(["Black Hawk Down Redefine · Rp150K", "18 🪙 · Rp5K"]);
    // Unknown items still get their exact name and price in the body.
    expect(shared.pages[0]!.text).toContain("#30025111 · Rp150.000\nBlack Hawk Down Redefine - Garena");
    // A lone SKU whose product never declared "Garena" keeps the qualifier and its first word; the middle goes behind one ellipsis.
    const unlisted = presentCanonicalCatalog([make(1, raw, { price: "150000", currency: "USD", product: { name: "Delta Force", gameVariant: null } })]);
    expect(labels(unlisted)).toEqual(["Black… Redefine - Garena · $9,38"]);
    expect(unlisted.pages[0]!.text).toContain("#1 · $9,38\nBlack Hawk Down Redefine - Garena");
    // When the product declares it, the header states it once and the button keeps the whole name (spec: "Black Hawk Down Redefine · $4.78").
    expect(labels(presentCanonicalCatalog([make(1, raw, { price: "150000", currency: "USD", product: deltaForce })]))).toEqual(["Black Hawk Down Redefine · $9,38"]);
  });
  it("puts each fallback item's name and price on the same page as its button", () => {
    const products = Array.from({ length: 21 }, (_, i) => make(i + 1, `${i + 1} Diamonds`, { price: "20000" }));
    products.push(make(122, `Mystery ${"long words ".repeat(6)}`, { price: "20000" }));
    const result = presentCanonicalCatalog(products);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]!.rows.flat()).toHaveLength(20);
    const last = result.pages[1]!;
    const [amount, shortened] = last.rows.flat().map((b) => b.text);
    expect(amount).toBe("21 💎 · Rp20K");
    // The first word and the end survive behind one ellipsis, and the full name stays in the body below.
    expect(shortened).toMatch(/^Mystery… (?:long )?words · Rp20K$/);
    expect(visualWidth(shortened!)).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
    expect(last.text).toContain("#122 · Rp20.000\nMystery");
    expect(result.pages[0]!.text).not.toContain("#122");
    expect(last.text).not.toContain("#21 ·");
  });
  it("does not repeat an unlisted game's own name on every button, with or without structured quantity", () => {
    const make2 = (id: number, raw: string, qty?: { qtyValue: number; qtyUnit: string }) => canonicalProduct({
      denomination: { id, name: raw, durationLabel: raw, supplierRawName: raw, supplierSku: `sku-${id}`, autoDeliverySource: "digiflazz", isActive: true, ...qty },
      product: { id: 9, name: "Where Winds Meet", isActive: true, gameRegion: null, gameVariant: null },
      category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
    }, { effectivePriceIDR: "15000", preferredCurrency: "IDR", locale: "id" });
    const plain = presentCanonicalCatalog([make2(84, "Where Winds Meet 60 Echo Beads")]);
    expect(labels(plain)).toEqual(["60 Echo Beads · Rp15K"]);
    const structured = presentCanonicalCatalog([make2(84, "Where Winds Meet 60 Echo Beads", { qtyValue: 60, qtyUnit: "Echo Beads" })]);
    expect(labels(structured)).toEqual(["60 Echo Beads · Rp15K"]);
    expect(structured.pages[0]!.text).not.toContain("Where Winds Meet 60");
  });
  it("does not repeat a region-suffixed product name, and never falls back to the ID for it", () => {
    const make3 = (id: number, raw: string, productName: string, qty?: { qtyValue: number; qtyUnit: string }) => canonicalProduct({
      denomination: { id, name: raw, durationLabel: raw, supplierRawName: raw, supplierSku: `sku-${id}`, autoDeliverySource: "digiflazz", isActive: true, ...qty },
      product: { id: 9, name: productName, isActive: true, gameRegion: null, gameVariant: null },
      category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
    }, { effectivePriceIDR: "15000", preferredCurrency: "IDR", locale: "id" });
    const wwm = "Where Winds Meet (Global)";
    expect(labels(presentCanonicalCatalog([make3(87, "Where Winds Meet 60 Echo Beads", wwm)]))).toEqual(["60 Echo Beads · Rp15K"]);
    const structured = presentCanonicalCatalog([make3(87, "Where Winds Meet 60 Echo Beads", wwm, { qtyValue: 60, qtyUnit: "Echo Beads" })]);
    expect(labels(structured)).toEqual(["60 Echo Beads · Rp15K"]);
    expect(labels(structured)[0]).not.toContain("#87");
    expect(labels(presentCanonicalCatalog([make3(5, "Mobile Legends 86 Diamonds", "MOBILE LEGENDS (Global)")]))).toEqual(["86 💎 · Rp15K"]);
    expect(labels(presentCanonicalCatalog([make3(88, "Where Winds Meet 12.000 Echo Beads", "Where Winds Meet", { qtyValue: 12000, qtyUnit: "Echo Beads" })]))).toEqual(["12K Echo Beads · Rp15K"]);
  });
  it("falls back to a qualifier-only header on later pages when the product name is too long for one", () => {
    const longName = "L".repeat(310);
    const many = Array.from({ length: 25 }, (_, i) => make(i + 1, `${i + 1} Diamonds`, { product: { name: longName, gameRegion: "Global" } }));
    const result = presentCanonicalCatalog(many, { intro: "Pilih nominal" });
    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.pages[1]!.text).toBe("Global\n\n");
    expect(labels(result).join(" ")).not.toContain("Global");
  });
  it("names the product on every page, and on page 1 only when the intro title does not", () => {
    const many = (opts: Opts) => Array.from({ length: 45 }, (_, i) => make(i + 1, `${i + 1} Diamonds`, opts));
    const plain = presentCanonicalCatalog(many({}));
    expect(plain.pages).toHaveLength(3);
    for (const page of plain.pages) expect(page.text).toContain("Mobile Legends");
    const intro = "Mobile Legends - 45 terjual";
    const shared = presentCanonicalCatalog(many({ product: { gameRegion: "Global" } }), { intro });
    expect(shared.pages).toHaveLength(3);
    expect(shared.pages[0]!.text.split("Mobile Legends")).toHaveLength(2);
    expect(shared.pages[0]!.text).toContain("Global");
    for (const page of shared.pages.slice(1)) expect(page.text).toContain("Mobile Legends · Global");
    const noName = presentCanonicalCatalog(many({}), { intro: "Pilih nominal" });
    expect(noName.pages[0]!.text).toContain("Mobile Legends");
    const plainIntro = presentCanonicalCatalog(many({}), { intro });
    expect(plainIntro.pages[0]!.text.split("Mobile Legends")).toHaveLength(2);
    for (const page of plainIntro.pages.slice(1)) expect(page.text).toBe("Mobile Legends\n\n");
  });
  it("escapes the product name in the repeated page header", () => {
    const result = presentCanonicalCatalog(Array.from({ length: 21 }, (_, i) => make(i + 1, `${i + 1} Diamonds`, { product: { name: "Rock <&> Roll" } })), { intro: "x" });
    expect(result.pages[1]!.text).toBe("Rock &lt;&amp;&gt; Roll\n\n");
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

describe("canonical Telegram labels: a qualifier spelled by only some SKUs", () => {
  const delta = (id: number, raw: string, price: string, product: Opts["product"] = deltaForce) => make(id, raw, { price, product });
  it("keeps two same-quantity SKUs distinct when one spells the product qualifier and one does not", () => {
    const result = presentCanonicalCatalog([
      delta(12, "Delta Force 60 Delta Coins - Garena", "14000"),
      delta(13, "Delta Force 60 Delta Coins", "15500"),
    ]);
    const texts = labels(result);
    expect(texts).toHaveLength(2);
    expect(new Set(texts).size).toBe(2);
    for (const text of texts) expect(text).not.toMatch(/#\d+/);
    expect(texts[0]).toContain("Rp14K");
    expect(texts[1]).toContain("Rp16K");
    // The spelled SKU keeps its own text; the header must not claim Garena for the unspelled one.
    expect(texts[0]).toContain("Garena");
    expect(result.pages[0]!.text).not.toContain("Delta Force · Garena");
  });
  it("renders the same two SKUs as before when the product has no variant", () => {
    expect(labels(presentCanonicalCatalog([
      delta(12, "Delta Force 60 Delta Coins - Garena", "14000", { name: "Delta Force" }),
      delta(13, "Delta Force 60 Delta Coins", "15500", { name: "Delta Force" }),
    ]))).toEqual(["60 🪙 - Garena · Rp14K", "60 🪙 · Rp16K"]);
  });
  it("never produces an id-only or id-suffixed button for the whole real Delta Force series", () => {
    const names = (catalog as { productName: string; denominationName: string }[]).filter((row) => row.productName === "Delta Force").map((row) => row.denominationName);
    expect(names).toHaveLength(23);
    const result = presentCanonicalCatalog(names.map((name, i) => delta(1000 + i, name, String(7000 + i * 1000))));
    const texts = labels(result);
    expect(texts).toHaveLength(23);
    for (const text of texts) {
      expect(text).not.toMatch(/^#\d+$/);
      expect(text).not.toMatch(/ #\d+$/);
    }
    expect(new Set(texts).size).toBe(texts.length);
  });
  it("still states the qualifier once in the header when every SKU spells it, or none does", () => {
    const all = presentCanonicalCatalog([delta(1, "Delta Force 18 Delta Coins - Garena", "5000"), delta(2, "Delta Force 60 Delta Coins - Garena", "15000")]);
    expect(all.pages[0]!.text).toContain("Delta Force · Garena");
    expect(labels(all)).toEqual(["18 🪙 · Rp5K", "60 🪙 · Rp15K"]);
    const none = presentCanonicalCatalog([delta(1, "Delta Force 18 Delta Coins", "5000"), delta(2, "Delta Force 60 Delta Coins", "15000")]);
    expect(none.pages[0]!.text).toContain("Delta Force · Garena");
    expect(labels(none)).toEqual(["18 🪙 · Rp5K", "60 🪙 · Rp15K"]);
  });
  it("includes the lifted tail in the full form before falling back to an id", () => {
    const result = presentCanonicalCatalog([
      delta(1, "Delta Force 60 Delta Coins - Garena", "14000"),
      delta(2, "Delta Force 60 Delta Coins (Garena)", "14000"),
    ]);
    const texts = labels(result);
    expect(new Set(texts).size).toBe(2);
    for (const text of texts) expect(text).not.toMatch(/#\d+/);
  });
});

describe("canonicalName whitespace by category group", () => {
  const named = (group: string) => canonicalProduct({
    denomination: { id: 1, name: "CC  - 3 Month", durationLabel: "CC  - 3 Month", isActive: true },
    product: { id: 3, name: "CapCut Pro", isActive: true, gameRegion: null, gameVariant: null },
    category: { id: 1, name: "Cat", group, isActive: true },
  }, { effectivePriceIDR: "4480", preferredCurrency: "IDR", locale: "id" });
  it("leaves a Premium name byte-identical to master, double space included", () => {
    expect(canonicalName(named("PREMIUM_APPS"))).toBe("CC  - 3 Month");
  });
  it("collapses repeated whitespace for a Game Top-Up name", () => {
    expect(canonicalName(named("GAME_TOPUP"))).toBe("CC - 3 Month");
  });
});

// The real "Genshin Impact" product of the dummy catalog (20 SKUs): structured quantities beside names that reorder
// the same tokens, bonus-including totals and a bundle whose label is wider than a phone button.
describe("Game Top-Up buttons for a product with reordered, bonus-including and bundle names", () => {
  const sku = (id: number, raw: string, price: string, qty?: [number, string], currency: "IDR" | "USD" = "USD", locale = "id") => canonicalProduct({
    denomination: { id, name: raw, durationLabel: raw, supplierRawName: raw, supplierSku: `sku-${id}`, autoDeliverySource: null, isActive: true, ...(qty ? { qtyValue: qty[0], qtyUnit: qty[1] } : {}) },
    product: { id: 38, name: "Genshin Impact", isActive: true, gameRegion: null, gameVariant: null },
    category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
  }, { effectivePriceIDR: price, preferredCurrency: currency, rate: "16000", locale });
  const rows: [number, string, string, [number, string]?][] = [
    [663, "Genshin Impact 60 Genesis Crystals", "15300", [60, "Genesis Crystals"]], [664, "Genshin Impact 300 Genesis Crystals", "76500", [300, "Genesis Crystals"]],
    [665, "Genshin Impact 980 Genesis Crystals", "249900", [980, "Genesis Crystals"]], [666, "Genshin Impact 1.980 Genesis Crystals", "504900", [1980, "Genesis Crystals"]],
    [667, "Genshin Impact 3.280 Genesis Crystals", "836400", [3280, "Genesis Crystals"]], [668, "Genshin Impact 6.480 Genesis Crystals", "1652400", [6480, "Genesis Crystals"]],
    [669, "Genshin Impact 300 + 30 Genesis Crystals", "75800", [330, "Genesis Crystals"]], [670, "Genshin Impact 980 + 110 Genesis Crystals", "247800", [1090, "Genesis Crystals"]],
    [671, "Genshin Impact 1980 + 260 Genesis Crystals", "501500", [2240, "Genesis Crystals"]], [672, "Genshin Impact 3280 + 600 Genesis Crystals", "835000", [3880, "Genesis Crystals"]],
    [673, "Genshin Impact 6480 + 1600 Genesis Crystals", "1660000", [8080, "Genesis Crystals"]],
    [674, "Genshin Impact Blessing of the Welkin Moon", "79000"], [675, "Genshin Impact Blessing of the Welkin Moon x2", "155000"], [676, "Genshin Impact Gnostic Hymn", "159000"],
    [677, "Genshin Impact Primogems 160", "40000", [160, "Primogems"]], [678, "Genshin Impact Primogems 330", "79000", [330, "Primogems"]], [679, "Genshin Impact Crystals 330", "79500", [330, "Crystals"]],
    [680, "Genshin Impact Genesis Crystals Bundle 8.000 Crystals", "2000000", [8000, "Crystals"]], [681, "Genshin Impact Genesis Crystals Bundle 9.000 Crystals", "2250000", [9000, "Crystals"]],
    [682, "Genshin Impact Genesis Crystals Bundle 10.000 Crystals", "2500000", [10000, "Crystals"]],
  ];
  const list = (currency: "IDR" | "USD", locale: string) => rows.map(([id, raw, price, qty]) => sku(id, raw, price, qty, currency, locale));
  const repeatedWord = (label: string) => {
    const body = label.replace(/\s#\d+$/, "").replace(/ · [^·]*$/, "");
    const seen = new Set<string>();
    for (const word of body.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 1)) { if (seen.has(word)) return word; seen.add(word); }
    return null;
  };
  const byId = (result: ReturnType<typeof presentCanonicalCatalog>) => new Map(result.pages.flatMap((p) => p.rows.flat()).map((b) => [Number(b.callback_data.split(":").at(-1)), b.text]));

  it.each([["USD", "id"], ["USD", "en"], ["IDR", "id"], ["IDR", "en"]] as const)("labels all 20 SKUs distinctly and readably (%s, %s)", (currency, locale) => {
    const result = presentCanonicalCatalog(list(currency, locale), { locale });
    const texts = result.pages.flatMap((p) => p.rows.flat().map((b) => b.text));
    expect(texts).toHaveLength(20);
    expect(new Set(texts).size).toBe(20);
    for (const text of texts) {
      expect(text, text).not.toMatch(/^#\d+$/);
      expect(text, text).not.toMatch(/\s#\d+$/);
      expect(repeatedWord(text), text).toBeNull();
      expect(visualWidth(text), text).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
      expect(Buffer.byteLength(text, "utf8"), text).toBeLessThanOrEqual(64);
    }
    for (const button of result.pages.flatMap((p) => p.rows.flat())) expect(button.callback_data).toMatch(/^v1:browse:denom:6\d\d$/);
  });
  it("shows the reordered Primogems and Crystals once, as 160 Primogems / 330 Crystals", () => {
    const labelsById = byId(presentCanonicalCatalog(list("USD", "id"), { locale: "id" }));
    expect(labelsById.get(677)).toBe("160 Primogems · $2,50");
    expect(labelsById.get(678)).toBe("330 Primogems · $4,94");
    expect(labelsById.get(679)).toBe("330 Crystals · $4,97");
    expect(byId(presentCanonicalCatalog(list("USD", "en"), { locale: "en" })).get(679)).toBe("330 Crystals · $4.97");
  });
  it("labels the bonus-including totals as base+bonus in the structured unit's own name", () => {
    const labelsById = byId(presentCanonicalCatalog(list("USD", "id"), { locale: "id" }));
    expect(labelsById.get(673)).toBe("6480+1600 Genesis Crystals · $103,75");
    expect(labelsById.get(669)).toBe("300+30 Genesis Crystals · $4,74");
    // Genesis Crystals, Primogems and Crystals share one icon in this list, so their amounts stay spelled out.
    for (const id of [663, 669, 673, 677, 678, 679]) expect(labelsById.get(id), String(id)).not.toContain("💎");
  });
  it("shortens a too-wide bundle without icons, keeping its first word and its distinguishing number", () => {
    const result = presentCanonicalCatalog(list("USD", "id"), { locale: "id" });
    const labelsById = byId(result);
    expect(labelsById.get(680)).toBe("Gen… 8.000 Crystals · $125,00");
    expect(labelsById.get(681)).toBe("Gen… 9.000 Crystals · $140,63");
    expect(labelsById.get(682)).toBe("Gen… 10.000 Crystals · $156,25");
    // Crystals, Primogems and Genesis Crystals share one icon in this list, so no bundle button may use it (nor print it twice).
    for (const id of [680, 681, 682]) expect(labelsById.get(id), String(id)).not.toContain("💎");
    // The body still explains each of them with its full name and exact price, on the page that holds the button.
    const page = result.pages.find((p) => p.rows.flat().some((b) => b.callback_data.endsWith(":680")))!;
    expect(page.text).toContain("#680 · $125,00\nGenesis Crystals Bundle 8.000 Crystals");
    expect(page.text).toContain("#682 · $156,25\nGenesis Crystals Bundle 10.000 Crystals");
  });
  it("keeps the original name for a Premium Apps SKU (no structured-quantity rule applies)", () => {
    const premium = canonicalProduct({
      denomination: { id: 5, name: "Primogems 160", durationLabel: "Primogems 160", supplierRawName: "Primogems 160", isActive: true, qtyValue: 160, qtyUnit: "Primogems" },
      product: { id: 9, name: "Shop", isActive: true }, category: { id: 2, name: "Apps", group: "PREMIUM_APPS", isActive: true },
    }, { effectivePriceIDR: "40000", preferredCurrency: "IDR", locale: "id" });
    expect(canonicalName(premium)).toBe("160 Primogems Primogems 160");
  });
});

describe("Game Top-Up button fallback chain before a bare ID", () => {
  const item = (id: number, raw: string, price = "1000000", opts: { qty?: [number, string]; currency?: "IDR" | "USD"; locale?: string } = {}) => canonicalProduct({
    denomination: { id, name: raw, durationLabel: raw, supplierRawName: raw, supplierSku: `sku-${id}`, autoDeliverySource: null, isActive: true, ...(opts.qty ? { qtyValue: opts.qty[0], qtyUnit: opts.qty[1] } : {}) },
    product: { id: 3, name: "Some Game", isActive: true, gameRegion: null, gameVariant: null },
    category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
  }, { effectivePriceIDR: price, preferredCurrency: opts.currency ?? "IDR", rate: "16000", locale: opts.locale ?? "id" });
  const texts = (products: ReturnType<typeof item>[]) => labels(presentCanonicalCatalog(products));

  it("keeps a label of exactly the hard cap and falls back one cell later", () => {
    expect(MAX_LABEL_WIDTH).toBe(36);
    expect(TARGET_LABEL_WIDTH).toBe(32);
    const at = "Alpha Bravo Charlie Delta Eco";
    expect(visualWidth(`${at} · Rp1M`)).toBe(36);
    expect(texts([item(1, at)])).toEqual([`${at} · Rp1M`]);
    const over = texts([item(1, `${at}x`)]);
    expect(over[0]).not.toBe(`${at}x · Rp1M`);
    expect(over[0]).toMatch(/^Alpha… /);
    expect(visualWidth(over[0]!)).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
  });
  it("abbreviates long words only when the label does not fit, and never makes two SKUs identical", () => {
    expect(texts([item(1, "Weekly Premium Pass")])).toEqual(["Weekly Premium Pass · Rp1M"]);
    const result = presentCanonicalCatalog([item(1, "Weekly Premium Subscription Package Bonus"), item(2, "Weekly Premium Subscription Pkg Bonus")]);
    const out = labels(result);
    expect(new Set(out).size).toBe(2);
    expect(out.every((text) => !/^#\d+$/.test(text))).toBe(true);
    expect(result.pages[0]!.text).toContain("#1 · Rp1.000.000\nWeekly Premium Subscription Package Bonus");
    expect(result.pages[0]!.text).toContain("#2 · Rp1.000.000\nWeekly Premium Subscription Pkg Bonus");
    expect(texts([item(1, "Weekly Premium Subscription Package")])).toEqual(["Wkly Prem Sub Pkg · Rp1M"]);
  });
  it("keeps the first word and the END of a long name behind one ellipsis, with the price intact and the full name in the body", () => {
    const products = [8000, 9000, 10000].map((n, i) => item(i + 1, `Ultra Mega Collector Edition Special Pack ${n}`));
    const result = presentCanonicalCatalog(products);
    const out = labels(result);
    expect(out).toEqual(["Ultra… Special Pack 8000 · Rp1M", "Ultra… Special Pack 9000 · Rp1M", "Ultra… Special Pack 10000 · Rp1M"]);
    for (const text of out) expect(visualWidth(text)).toBeLessThanOrEqual(TARGET_LABEL_WIDTH);
    expect(result.pages[0]!.text).toContain("#1 · Rp1.000.000\nUltra Mega Collector Edition Special Pack 8000");
    expect(result.pages[0]!.text).toContain("#3 · Rp1.000.000\nUltra Mega Collector Edition Special Pack 10000");
    expect(result.pages[0]!.rows.flat().map((b) => b.callback_data)).toEqual(["v1:browse:denom:1", "v1:browse:denom:2", "v1:browse:denom:3"]);
  });
  it("tells siblings apart by the first words when the end is shared", () => {
    const result = presentCanonicalCatalog([item(1, "Alpha Series Gamma Edition Special Collector Pack Plus"), item(2, "Beta Series Gamma Edition Special Collector Pack Plus")]);
    const [first, second] = labels(result);
    expect(first).toMatch(/^Alpha[^…]*… .*Pack Plus · Rp1M$/);
    expect(second).toMatch(/^Beta[^…]*… .*Pack Plus · Rp1M$/);
  });
  it("falls back to the bare ID only when no shortening can tell siblings apart, and explains both", () => {
    const result = presentCanonicalCatalog([item(1, "Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India"), item(2, "Alpha Bravo Charlie Delta Eagle Foxtrot Golf Hotel India")]);
    expect(labels(result)).toEqual(["#1", "#2"]);
    expect(result.pages[0]!.text).toContain("#1 · Rp1.000.000\nAlpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India");
    expect(result.pages[0]!.text).toContain("#2 · Rp1.000.000\nAlpha Bravo Charlie Delta Eagle Foxtrot Golf Hotel India");
  });
  it("cuts the start only when the first words cannot stay: a name of three words or one enormous word", () => {
    expect(texts([item(1, "Seasonal Collector Pass", "1600000000", { currency: "USD" })])).toEqual(["…Collector Pass · $100.000,00"]);
  });
  it("never cuts inside a grapheme", () => {
    const [text] = texts([item(1, "Famille 👨‍👩‍👧‍👦 Mega Special Event Pack 👨‍👩‍👧‍👦 Gift")]);
    expect(text).toMatch(/^Famille… .*👨‍👩‍👧‍👦 Gift · Rp1M$/u);
    const [single] = texts([item(1, "Ünïcödé".repeat(10))]);
    expect(visualWidth(single!)).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
    expect(single).toMatch(/^….+ · Rp1M$/u);
  });
  it("aims cuts at the soft target", () => {
    const [cut] = texts([item(1, "Ultra Mega Collector Edition Special Bundle Pack Plus Max")]);
    expect(visualWidth(cut!)).toBeLessThanOrEqual(TARGET_LABEL_WIDTH);
  });
  it("shows Crystals as an icon alone, but spells Crystals and Diamonds out when they share an icon in one list", () => {
    expect(texts([item(1, "Crystals 330", "79500", { qty: [330, "Crystals"] })])).toEqual(["330 💎 · Rp80K"]);
    const mixed = presentCanonicalCatalog([item(1, "Crystals 330", "79500", { qty: [330, "Crystals"] }), item(2, "Diamonds 86", "20000", { qty: [86, "Diamonds"] })]);
    expect(labels(mixed)).toEqual(["330 Crystals · Rp80K", "86 Diamonds · Rp20K"]);
  });
  it.each([
    ["Diamonds", "💎"], ["Crystals", "💎"], ["Genesis Crystals", "💎"], ["Gems", "💎"], ["Primogems", "💎"], ["Jewels", "💎"],
    ["Coins", "🪙"], ["Gold", "🪙"],
  ])("shows %s as %s when it is the only unit in the list", (unit, icon) => {
    expect(texts([item(1, `${unit} 250`, "20000", { qty: [250, unit] })])).toEqual([`250 ${icon} · Rp20K`]);
  });
  it.each([["UC"], ["VP"], ["Bonds"], ["Robux"], ["Tokens"], ["Credits"], ["Points"], ["Stars"], ["Tickets"]])("keeps %s as text", (unit) => {
    expect(texts([item(1, `${unit} 250`, "20000", { qty: [250, unit] })])).toEqual([`250 ${unit} · Rp20K`]);
  });
});

describe("Game Top-Up icon fallback never doubles or misplaces an icon", () => {
  const sku = (id: number, raw: string, price: string, opts: { qty?: [number, string]; product?: string; currency?: "IDR" | "USD" } = {}) => canonicalProduct({
    denomination: { id, name: raw, durationLabel: raw, supplierRawName: raw, supplierSku: `sku-${id}`, autoDeliverySource: null, isActive: true, ...(opts.qty ? { qtyValue: opts.qty[0], qtyUnit: opts.qty[1] } : {}) },
    product: { id: 3, name: opts.product ?? "Some Game", isActive: true, gameRegion: null, gameVariant: null },
    category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
  }, { effectivePriceIDR: price, preferredCurrency: opts.currency ?? "IDR", rate: "16000", locale: "id" });
  const iconCount = (text: string) => (text.match(/💎|🪙/gu) ?? []).length;

  it("never shows the unit icon twice on an event pack that also spells the unit in its name", () => {
    const products = Array.from({ length: 11 }, (_, i) => sku(869 + i, `Event Gift Pack ${i + 1} Diamonds`, "18000", { qty: [7 * (i + 1), "Diamonds"], product: "Mobile Legends" }));
    const result = presentCanonicalCatalog(products);
    const out = labels(result);
    expect(new Set(out).size).toBe(11);
    for (const text of out) {
      expect(iconCount(text), text).toBeLessThanOrEqual(1);
      expect(text, text).not.toMatch(/^#\d+$/);
      expect(visualWidth(text), text).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
    }
    // The icon stays where the quantity is, the unit word the head already states is not repeated, and the body still gives the full name.
    expect(out[0]).toBe("7 💎 Event Gift Pack 1 · Rp18K");
    expect(out[10]).toBe("77 💎 Event Gift Pack 11 · Rp18K");
    expect(result.pages[0]!.text).toContain("#869 · Rp18.000\n7 Diamonds Event Gift Pack 1 Diamonds");
  });
  it("does not repeat a spelled-out unit either, when the list spells it because other units share its icon", () => {
    const out = labels(presentCanonicalCatalog([
      sku(1, "Event Gift Pack 1 Diamonds", "18000", { qty: [7, "Diamonds"], product: "Mobile Legends" }),
      sku(2, "Primogems 160", "40000", { qty: [160, "Primogems"] }),
    ]));
    expect(out).toEqual(["7 Diamonds Event Gift Pack 1 · Rp18K", "160 Primogems · Rp40K"]);
  });
  it("spells Gold, Coins and Delta Coins out when they share one list, since all three are the coin icon", () => {
    const out = labels(presentCanonicalCatalog([
      sku(1, "Gold 100", "5000", { qty: [100, "Gold"] }),
      sku(2, "Coins 100", "5000", { qty: [100, "Coins"] }),
      sku(3, "Delta Coins 18", "5000", { qty: [18, "Delta Coins"] }),
    ]));
    expect(out).toEqual(["100 Gold · Rp5K", "100 Coins · Rp5K", "18 Delta Coins · Rp5K"]);
    expect(new Set(out).size).toBe(3);
    for (const text of out) expect(iconCount(text), text).toBe(0);
  });
  it("shows Gold as the coin icon when it is the only coin-like unit in the list", () => {
    expect(labels(presentCanonicalCatalog([sku(1, "Gold 100", "5000", { qty: [100, "Gold"] }), sku(2, "Gold 250", "9000", { qty: [250, "Gold"] }), sku(3, "Diamonds 86", "20000", { qty: [86, "Diamonds"] })])))
      .toEqual(["100 🪙 · Rp5K", "250 🪙 · Rp9K", "86 💎 · Rp20K"]);
  });
  it("does not turn a literal icon plus the unit word of a combo name into two icons", () => {
    const [text] = labels(presentCanonicalCatalog([sku(1, "💎 Diamonds 100 ✨🔥 Mega Combo 🎁", "18000")]));
    expect(text).not.toMatch(/💎\s*💎/u);
    expect(iconCount(text!)).toBeLessThanOrEqual(1);
  });
  it("keeps the words of a membership or pass name, whatever words the dictionary knows", () => {
    const out = labels(presentCanonicalCatalog([sku(1, "Gold Ticket Monthly Membership Deluxe", "150000")]));
    expect(iconCount(out[0]!)).toBe(0);
    expect(out[0]).toContain("Gold");
    expect(out[0]).toContain("Deluxe");
    const pass = labels(presentCanonicalCatalog([sku(2, "Super Diamond Gems Premium Battle Pass Gold Season", "150000")]));
    expect(iconCount(pass[0]!)).toBe(0);
  });
  it("shortens a too-wide different-unit bonus by swapping only its own unit for the icon", () => {
    const result = presentCanonicalCatalog([sku(1, "1000 Diamonds + 100 Bonds", "1000000000", { currency: "USD" })]);
    expect(labels(result)).toEqual(["1000 💎 + 100 Bonds · $62.500,00"]);
    expect(result.pages[0]!.text).toContain("#1 · $62.500,00\n1000 Diamonds + 100 Bonds");
  });
  it("never uses the icon for a unit that must stay spelled out in the same list", () => {
    const out = labels(presentCanonicalCatalog([sku(1, "1000 Diamonds + 100 Bonds", "1000000000", { currency: "USD" }), sku(2, "330 Crystals", "79500", { qty: [330, "Crystals"] })]));
    for (const text of out) expect(iconCount(text), text).toBe(0);
    expect(out[1]).toBe("330 Crystals · Rp80K");
  });
  it("never touches words of a bundle name and never prints the bundle's unit icon twice", () => {
    const products = [8000, 9000, 10000].map((n, i) => sku(i + 1, `Genesis Crystals Bundle ${n} Crystals`, "2000000", { qty: [n, "Crystals"] }));
    products.push(sku(9, "330 Primogems", "79000", { qty: [330, "Primogems"] }));
    const out = labels(presentCanonicalCatalog(products));
    expect(new Set(out).size).toBe(out.length);
    for (const text of out) expect(text, text).not.toMatch(/^#\d+$/);
    // The three bundles are not amounts: not one of their words becomes an icon.
    for (const text of out.slice(0, 3)) expect(iconCount(text), text).toBe(0);
    expect(out[0]).toMatch(/8000/);
  });
});

describe("Game Top-Up labels keep the START of a name that fits whole without the qualifier or the middle", () => {
  const sku = (id: number, raw: string, price: string, product: { name: string; gameVariant?: string | null } = { name: "Some Game" }) => canonicalProduct({
    denomination: { id, name: raw, durationLabel: raw, supplierRawName: raw, supplierSku: `sku-${id}`, autoDeliverySource: null, isActive: true },
    product: { id: 3, isActive: true, gameRegion: null, gameVariant: null, ...product },
    category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
  }, { effectivePriceIDR: price, preferredCurrency: "IDR", rate: "16000", locale: "id" });

  it("drops a shared trailing '- Garena' before it would cut the beginning, even when the product never declared it", () => {
    const delta = { name: "Delta Force" };
    const result = presentCanonicalCatalog([
      sku(1, "Delta Force Black Hawk Down Redefine  - Garena", "125000", delta),
      sku(2, "Delta Force 18 Delta Coins - Garena", "5000", delta),
      sku(3, "Delta Force Operations Pass - Garena", "45000", delta),
    ]);
    expect(labels(result)[0]).toBe("Black Hawk Down Redefine · Rp125K");
    expect(result.pages[0]!.text).toContain("#1 · Rp125.000\nBlack Hawk Down Redefine - Garena");
  });
  it("cuts the name without its qualifier before it cuts the name that keeps it, so an id-suffixed twin still shows what it is", () => {
    const delta = { name: "Delta Force" };
    const out = labels(presentCanonicalCatalog([
      sku(1032, "Delta Force Black Hawk Down Redefine  - Garena", "79000", delta),
      sku(1033, "Delta Force Black Hawk Down Redefine - Garena", "80000", delta),
      sku(1035, "Delta Force 18 Delta Coins - Garena", "5000", delta),
    ]));
    // Same name twice, so an id tells them apart; the words that name the item stay and the shared "Garena" does not take their place.
    expect(out[0]).toBe("Black… Down Redefine · Rp79K #1032");
    expect(out[1]).toBe("Black… Down Redefine · Rp80K #1033");
  });
  it("leaves the qualifier alone when dropping it would make two labels identical", () => {
    const delta = { name: "Delta Force" };
    const out = labels(presentCanonicalCatalog([
      sku(1, "Delta Force Black Hawk Down Redefine - Garena", "125000", delta),
      sku(2, "Delta Force Black Hawk Down Redefine", "125000", delta),
      sku(3, "Delta Force 18 Delta Coins - Garena", "5000", delta),
    ]));
    expect(new Set(out).size).toBe(3);
    expect(out[0]).toContain("Garena");
  });
  it("keeps the first words and the end behind a middle ellipsis", () => {
    const out = labels(presentCanonicalCatalog([sku(1, "Blessing of the Welkin Moon x2", "155000"), sku(2, "Blessing of the Welkin Moon", "79000")]));
    expect(out[0]).toMatch(/^Blessing of(?: the)?… (?:\S+ )?Moon x2 · Rp155K$/);
    expect(out[1]).toBe("Blessing of the Welkin Moon · Rp79K");
  });
  it("keeps 'Infinite' of an Arena Breakout pack", () => {
    const [text] = labels(presentCanonicalCatalog([sku(1, "Infinite Edition Starter Pack", "1000000", { name: "Arena Breakout" })]));
    expect(text).toMatch(/^Infinite/);
    expect(text).not.toMatch(/(^|\s)…/);
  });
});
