/**
 * The enforcing guard for Telegram inline-keyboard label rules (see "Inline keyboard button labels" in
 * .claude/skills/bot-ux-grammy/SKILL.md). It renders a hostile matrix through the real catalog presenter and
 * picker keyboard and checks EVERY button against the shared limits in packages/core/src/buttonLimits.ts.
 * No number is hardcoded here: change a limit only in that module.
 *
 * If this fails after you touched canonicalPresenter.ts, keyboards/customer.ts or the unit dictionary, the
 * change lets a button overflow a phone, repeats a label, or leaves a shortened button unexplained.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { canonicalProduct, type CanonicalProduct } from "@app/core/canonicalProduct";
import { MAX_LABEL_BYTES, MAX_LABEL_WIDTH, NARROW_LABEL_WIDTH, CATALOG_PAGE_SIZE, visualWidth } from "@app/core/buttonLimits";
import { UNITS } from "@app/core/unitDictionary";
import { presentCanonicalCatalog } from "../src/util/canonicalPresenter";
import { canonicalDenominationPickerKb } from "../src/keyboards/customer";

type Currency = "IDR" | "USD";
interface Fixture { id: number; name: string; price: string }

const PRODUCT_ID = 3;
const DENOM_PREFIX = "v1:browse:denom:";
// Ids of different widths, so the callback byte cap is exercised with real-world-sized ids.
const idOf = (i: number) => 1_000_000_000 + i;

const long250 = "Supplier Special Limited Edition Mega Mobile Game Diamond Top Up Bundle With Bonus Items ".repeat(3).slice(0, 250);
const dictionaryUnits = UNITS.flatMap((unit) => [unit.canonical, ...unit.aliases]);
const unknownUnits = ["Zorblax Shards", "Flarbs", "Mana Orbs"];

/** Name generators, one hostile shape each. `i` is the SKU index in the product. */
const SHAPES: Record<string, (i: number) => Fixture> = {
  plainAmounts: (i) => ({ id: idOf(i), name: `${(i + 1) * 10} Diamonds`, price: String(1000 + i * 1500) }),
  dictionaryUnits: (i) => ({ id: idOf(i), name: `${100 + i * 7} ${dictionaryUnits[i % dictionaryUnits.length]}`, price: String(5000 + i * 700) }),
  unknownUnits: (i) => ({ id: idOf(i), name: `${100 + i * 7} ${unknownUnits[i % unknownUnits.length]}`, price: String(5000 + i * 700) }),
  longNames: (i) => ({ id: idOf(i), name: `${long250.slice(0, 80 + ((i * 37) % 171))} ${i}`, price: String(21000 + i) }),
  cjkAndEmoji: (i) => ({ id: idOf(i), name: i % 2 ? `${"超级钻石礼包".repeat(1 + (i % 7))} ${i}` : `${"🎮💎🔥".repeat(1 + (i % 30))} ${i}`, price: "21000" }),
  markup: (i) => ({ id: idOf(i), name: i % 2 ? `<b>Pack & "Bundle" 'x' ${i}</b> > ${i}` : `A&B <i>${i}</i> "quoted" ${i} Diamonds`, price: "21000" }),
  dotGroupedNumbers: (i) => ({ id: idOf(i), name: i % 2 ? `${(i + 1)}.000 Diamonds` : `${1186 + i}.${100 + i}+${224} Diamonds`, price: String(10000 + i * 11) }),
  priceOnlyDifference: (i) => ({ id: idOf(i), name: "86 Diamonds", price: String(20000 + i) }),
  bundlesAndPasses: (i) => ({ id: idOf(i), name: ["Weekly Diamond Pass", "Monthly Membership Subscription Premium", "Starter Package Bundle", "Mystery Voucher"][i % 4]! + ` ${i}`, price: "99990000" }),
};
// 1, 2, 19, 20, 21 (page boundary), 61 and 83 (several pages; odd and even).
const COUNTS = [1, 2, 19, 20, 21, 61, 83];
const QUALIFIERS: Array<{ label: string; gameRegion: string | null; gameVariant: string | null }> = [
  { label: "none", gameRegion: null, gameVariant: null },
  { label: "region", gameRegion: "Indonesia", gameVariant: null },
  { label: "region and long variant", gameRegion: "Global", gameVariant: "Limited Special Collaboration Edition Pack" },
];
const CURRENCIES: Currency[] = ["IDR", "USD"];
const LOCALES = ["id", "en"] as const;

function build(fixture: Fixture, currency: Currency, locale: string, qualifiers: (typeof QUALIFIERS)[number]): CanonicalProduct {
  return canonicalProduct({
    denomination: { id: fixture.id, name: fixture.name, durationLabel: fixture.name, supplierRawName: fixture.name, supplierSku: `sku-${fixture.id}`, autoDeliverySource: "digiflazz", isActive: true },
    product: { id: PRODUCT_ID, name: "Mobile Legends", isActive: true, gameRegion: qualifiers.gameRegion, gameVariant: qualifiers.gameVariant },
    category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
  }, { effectivePriceIDR: fixture.price, preferredCurrency: currency, rate: "16000", locale });
}

/** Every page of one catalog rendered the way the bot sends it, with the real keyboard builder. */
function render(products: CanonicalProduct[], locale: string) {
  const { pages } = presentCanonicalCatalog(products, { locale, intro: "Mobile Legends\n\n1.234 sold" });
  return pages.map((page, index) => {
    const keyboard = canonicalDenominationPickerKb(page.rows, PRODUCT_ID, locale, index, pages.length).inline_keyboard;
    const rows = keyboard.map((row) => row.map((button) => ({ text: button.text, data: "callback_data" in button ? button.callback_data : "" })));
    return { page, rows };
  });
}

function violations(products: CanonicalProduct[], locale: string): string[] {
  const found: string[] = [];
  const seenIds = new Map<number, number>();
  for (const [pageIndex, { page, rows }] of render(products, locale).entries()) {
    const where = `page ${pageIndex + 1}`;
    const all = rows.flat();
    const productButtons = all.filter((button) => button.data.startsWith(DENOM_PREFIX));
    if (productButtons.length > CATALOG_PAGE_SIZE) found.push(`${where}: ${productButtons.length} product buttons exceed CATALOG_PAGE_SIZE`);
    for (const button of all) {
      const width = visualWidth(button.text);
      if (width > MAX_LABEL_WIDTH) found.push(`${where}: "${button.text}" is ${width} cells, over MAX_LABEL_WIDTH`);
      if (Buffer.byteLength(button.text, "utf8") > MAX_LABEL_BYTES) found.push(`${where}: "${button.text}" label is over MAX_LABEL_BYTES`);
      if (Buffer.byteLength(button.data, "utf8") > MAX_LABEL_BYTES) found.push(`${where}: callback_data "${button.data}" is over MAX_LABEL_BYTES`);
      if (button.text.trim() === "") found.push(`${where}: an empty button label`);
    }
    // No two identical labels on one page (price alone must never tell two SKUs apart).
    const texts = all.map((button) => button.text);
    for (const text of new Set(texts)) if (texts.filter((other) => other === text).length > 1) found.push(`${where}: label "${text}" appears more than once`);
    // Two to a row only when both are narrow.
    for (const row of rows) if (row.length > 1 && row.some((button) => visualWidth(button.text) > NARROW_LABEL_WIDTH)) found.push(`${where}: a wide label shares its row: ${row.map((button) => `"${button.text}"`).join(" ")}`);
    // Product rows first; navigation (Prev/Next, Refresh, Back) never shares a row with a product.
    const lastProductRow = rows.reduce((last, row, index) => row.some((button) => button.data.startsWith(DENOM_PREFIX)) ? index : last, -1);
    const firstNavRow = rows.findIndex((row) => row.some((button) => !button.data.startsWith(DENOM_PREFIX)));
    if (firstNavRow !== -1 && lastProductRow > firstNavRow) found.push(`${where}: a product row comes after a navigation row`);
    for (const row of rows) {
      const kinds = new Set(row.map((button) => button.data.startsWith(DENOM_PREFIX)));
      if (kinds.size > 1) found.push(`${where}: a navigation button shares a row with a product`);
    }
    // Every shortened or id-only button is explained on the same page with its full name and exact price.
    for (const button of productButtons) {
      const id = Number(button.data.slice(DENOM_PREFIX.length));
      seenIds.set(id, (seenIds.get(id) ?? 0) + 1);
      if (button.data !== `${DENOM_PREFIX}${id}`) found.push(`${where}: unstable callback ${button.data}`);
      const shortened = button.text.includes("…") || new RegExp(`(^|\\s)#${id}(\\s|$)`).test(button.text);
      if (shortened && !new RegExp(`(^|\\n)#${id} · `).test(page.text)) found.push(`${where}: shortened button "${button.text}" is not explained in the page text`);
    }
  }
  for (const product of products) if (seenIds.get(product.id) !== 1) found.push(`SKU ${product.id} is on ${seenIds.get(product.id) ?? 0} pages, expected exactly one`);
  return found;
}

describe("keyboard label guard: hostile matrix through presenter and picker keyboard", () => {
  for (const [shapeName, shape] of Object.entries(SHAPES)) {
    for (const count of COUNTS) {
      it(`${shapeName}, ${count} SKU${count === 1 ? "" : "s"}: every button fits, is unique and is explained`, () => {
        const fixtures = Array.from({ length: count }, (_, i) => shape(i));
        for (const currency of CURRENCIES) for (const locale of LOCALES) for (const qualifiers of QUALIFIERS) {
          const products = fixtures.map((fixture) => build(fixture, currency, locale, qualifiers));
          const found = violations(products, locale);
          expect(found, `${shapeName} x${count} (${currency}, ${locale}, qualifiers: ${qualifiers.label})\n${found.slice(0, 8).join("\n")}`).toEqual([]);
        }
      });
    }
  }

  it("mixes every shape in one list, like a real catalog", () => {
    const names = Object.values(SHAPES);
    const fixtures = Array.from({ length: 83 }, (_, i) => ({ ...names[i % names.length]!(i), id: idOf(i) }));
    for (const currency of CURRENCIES) for (const locale of LOCALES) {
      const found = violations(fixtures.map((fixture) => build(fixture, currency, locale, QUALIFIERS[1]!)), locale);
      expect(found, found.slice(0, 8).join("\n")).toEqual([]);
    }
  });

  it("covers the paging boundary: 20 SKUs make one page, 21 make two, 61 make four", () => {
    const pageCount = (count: number) => render(Array.from({ length: count }, (_, i) => build(SHAPES.plainAmounts!(i), "IDR", "id", QUALIFIERS[0]!)), "id").length;
    expect([pageCount(1), pageCount(20), pageCount(21), pageCount(61)]).toEqual([1, Math.ceil(20 / CATALOG_PAGE_SIZE), Math.ceil(21 / CATALOG_PAGE_SIZE), Math.ceil(61 / CATALOG_PAGE_SIZE)]);
  });
});

describe("keyboard label guard: icons come only from the unit dictionary", () => {
  const ROOT = join(__dirname, "..");
  /**
   * Keyboard builders and the presenter must not spell a dictionary icon themselves: an icon is looked up
   * through packages/core/src/unitDictionary.ts. Existing non-dictionary emoji (admin menu icons, ticket
   * status dots) are fine and are not scanned for; add an entry here only with a reason.
   */
  const ALLOWED_DICTIONARY_ICONS: Record<string, string[]> = {
    // "apps/order-bot/src/keyboards/example.ts": ["⭐"], // reason it must be spelled here
  };
  const dictionaryIcons = [...new Set(UNITS.flatMap((unit) => unit.icon ? [unit.icon] : []))];
  const files = [
    join(ROOT, "src", "util", "canonicalPresenter.ts"),
    ...readdirSync(join(ROOT, "src", "keyboards")).filter((file) => file.endsWith(".ts")).map((file) => join(ROOT, "src", "keyboards", file)),
  ];

  /** String and template literals only, so a comment that mentions an icon does not trip the guard. */
  function literals(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) found.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it("scans real files and knows the dictionary's icons", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(dictionaryIcons.length).toBeGreaterThan(0);
  });

  it("finds no dictionary icon spelled in a keyboard builder or the presenter", () => {
    const hits: string[] = [];
    for (const file of files) {
      const allowed = ALLOWED_DICTIONARY_ICONS[file.slice(join(ROOT, "..", "..").length + 1).replaceAll("\\", "/")] ?? [];
      for (const text of literals(file)) for (const icon of dictionaryIcons) {
        if (text.includes(icon) && !allowed.includes(icon)) hits.push(`${file.slice(ROOT.length + 1)}: "${text}" spells ${icon}`);
      }
    }
    expect(hits, `Icons and abbreviations come only from packages/core/src/unitDictionary.ts (UNITS, ABBREVIATIONS), never from a keyboard builder or the presenter. Add the unit there instead:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the scanner itself would catch a hardcoded icon", () => {
    const sample = ts.createSourceFile("x.ts", 'const a = { text: `${n} 💎` }; // 🪙 in a comment\nconst b = "⭐ five";', ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isTemplateTail(node) || ts.isTemplateHead(node)) found.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(sample);
    expect(found.some((text) => text.includes("💎"))).toBe(true);
    expect(found.some((text) => text.includes("⭐"))).toBe(true);
    expect(found.some((text) => text.includes("🪙"))).toBe(false);
  });
});
