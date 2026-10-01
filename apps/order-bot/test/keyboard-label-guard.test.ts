/**
 * The enforcing guard for Telegram inline-keyboard label rules (see "Inline keyboard button labels" in
 * .claude/skills/bot-ux-grammy/SKILL.md). It renders a hostile matrix (including SKUs with a structured quantity
 * and unit) through the real catalog presenter and picker keyboard and checks EVERY button against the shared
 * limits in packages/core/src/buttonLimits.ts, then the Premium plan picker and the list pickers against theirs.
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
import {
  MAX_LABEL_BYTES, MAX_LABEL_WIDTH, NARROW_LABEL_WIDTH, CATALOG_PAGE_SIZE, LIST_LABEL_MAX_CHARS, PLAN_LABEL_MAX_CHARS, buttonNameBudget, visualWidth,
} from "@app/core/buttonLimits";
import { ABBREVIATIONS, UNITS } from "@app/core/unitDictionary";
import { hasRepeatedIcon } from "@app/core/unitDisplay";
import { presentCanonicalCatalog } from "../src/util/canonicalPresenter";
import { BUTTON_LABEL_MAX, truncLabel } from "../src/util/format";
import {
  canonicalDenominationPickerKb, categoryPickerKb, denominationPickerKb, gameRegionPickerKb, gameVariantPickerKb, popularKb, searchResultsKb,
} from "../src/keyboards/customer";

type Currency = "IDR" | "USD";
interface Fixture { id: number; name: string; price: string; /** The admin-structured quantity and unit, when the SKU has them. */ qty?: [number, string] }

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
  // Genshin-like SKUs: structured quantity beside names that reorder the same tokens, a bonus total, and a bundle that repeats its unit.
  structuredQuantities: (i) => {
    const n = Math.floor(i / 4);
    return [
      { id: idOf(i), name: `Primogems ${160 + n}`, price: String(40000 + i * 90), qty: [160 + n, "Primogems"] as [number, string] },
      { id: idOf(i), name: `${6480 + n} + 1600 Genesis Crystals`, price: String(1660000 + i * 90), qty: [8080 + n, "Genesis Crystals"] as [number, string] },
      { id: idOf(i), name: `Genesis Crystals Bundle ${8 + n}.000 Crystals`, price: String(2000000 + i * 90), qty: [(8 + n) * 1000, "Crystals"] as [number, string] },
      { id: idOf(i), name: `Event Gift Pack ${n + 1} Diamonds`, price: String(18000 + i * 90), qty: [7 * (n + 1), "Diamonds"] as [number, string] },
    ][i % 4]!;
  },
  // A literal icon in the supplier's name, beside an amount whose own unit could also be shown as that icon.
  literalIcons: (i) => ({ id: idOf(i), name: `${1000 + i} Diamonds + ${100 + i} Bonds 💎`, price: "900000000" }),
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
    denomination: {
      id: fixture.id, name: fixture.name, durationLabel: fixture.name, supplierRawName: fixture.name, supplierSku: `sku-${fixture.id}`, autoDeliverySource: "digiflazz", isActive: true,
      ...(fixture.qty ? { qtyValue: fixture.qty[0], qtyUnit: fixture.qty[1] } : {}),
    },
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

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
/** The label without its trailing " #id" and its price, i.e. the part that names the SKU. */
function identityOf(text: string): string {
  const withoutId = text.replace(/\s#\d+$/, "");
  const cut = withoutId.lastIndexOf(" · ");
  return cut >= 0 ? withoutId.slice(0, cut) : withoutId;
}
/** How often each word (letters only, 2 or more) occurs, case-insensitively. */
function wordCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of value.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 1)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

function violations(products: CanonicalProduct[], locale: string): string[] {
  const found: string[] = [];
  const seenIds = new Map<number, number>();
  const byId = new Map(products.map((product) => [product.id, product]));
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
      // A label never repeats a word, nor shows an icon twice or two icons side by side, that the SKU's own name does not.
      const product = byId.get(id)!;
      const identity = identityOf(button.text);
      const rawWords = wordCounts(product.rawName);
      for (const [word, count] of wordCounts(identity)) if (count > Math.max(1, rawWords.get(word) ?? 0)) found.push(`${where}: "${button.text}" repeats the word "${word}"`);
      if (hasRepeatedIcon(identity) && !hasRepeatedIcon(product.rawName)) found.push(`${where}: "${button.text}" repeats or doubles an icon`);
      // A "first words… end" cut must not read the same for another SKU of the list (an id suffix tells those apart).
      const cutAt = identity.indexOf("…");
      if (cutAt >= 0 && !/\s#\d+$/.test(button.text)) {
        const lead = identity.slice(0, cutAt);
        const tail = identity.slice(cutAt + 1);
        for (const other of products) {
          if (other.id === id || other.variant.type === "amount") continue;
          const name = collapse(other.displayName);
          if (name.length >= lead.length + tail.length && name.startsWith(lead) && name.endsWith(tail)) found.push(`${where}: "${button.text}" reads the same for SKU ${other.id} ("${name}")`);
        }
      }
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
  const tsFilesIn = (...dir: string[]) => readdirSync(join(ROOT, ...dir)).filter((file) => file.endsWith(".ts")).map((file) => join(ROOT, ...dir, file));
  const files = [
    join(ROOT, "src", "util", "canonicalPresenter.ts"),
    ...tsFilesIn("src", "keyboards"),
    ...tsFilesIn("src", "handlers"),
    ...tsFilesIn("src", "handlers", "checkout"),
  ];
  // Hand-made abbreviations are as forbidden as hand-made icons: the dictionary's short forms live only in the dictionary.
  const shortForms = [...new Set([...ABBREVIATIONS.map((entry) => entry.short), ...UNITS.flatMap((unit) => unit.short ? [unit.short] : [])])];

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
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.some((file) => file.includes("handlers"))).toBe(true);
    expect(dictionaryIcons.length).toBeGreaterThan(0);
    expect(shortForms).toEqual(expect.arrayContaining(["Gen", "Pkg", "WL", "Gen Crystals"]));
  });

  it("finds no dictionary abbreviation spelled in a keyboard builder, a handler or the presenter", () => {
    const hits: string[] = [];
    for (const file of files) {
      for (const text of literals(file)) for (const short of shortForms) {
        if (new RegExp(String.raw`(?<![\p{L}\p{N}])${short}(?![\p{L}\p{N}])`, "u").test(text)) hits.push(`${file.slice(ROOT.length + 1)}: "${text.slice(0, 80)}" spells ${short}`);
      }
    }
    expect(hits, `Abbreviations come only from packages/core/src/unitDictionary.ts (ABBREVIATIONS, UNITS short), never typed into a builder or handler:\n${hits.join("\n")}`).toEqual([]);
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

  it("the abbreviation scanner itself would catch a hand-typed abbreviation, but not a longer word that merely contains one", () => {
    const sample = ts.createSourceFile("x.ts", 'const a = `${n} Pkg`; const b = "Subscription"; const c = "Genesis";', ts.ScriptTarget.Latest, true);
    const spelled: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isTemplateTail(node) || ts.isTemplateHead(node)) {
        for (const short of shortForms) if (new RegExp(String.raw`(?<![\p{L}\p{N}])${short}(?![\p{L}\p{N}])`, "u").test(node.text)) spelled.push(short);
      }
      ts.forEachChild(node, visit);
    };
    visit(sample);
    expect(spelled).toEqual(["Pkg"]);
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

describe("keyboard label guard: the dictionary first, then a unique shortened form, a bare id last", () => {
  const listOf = (names: string[], price = "125000") => names.map((name, i) => build({ id: idOf(i), name, price }, "IDR", "id", QUALIFIERS[0]!));
  const textsOf = (products: CanonicalProduct[]) => render(products, "id").flatMap(({ rows }) => rows.flat().filter((b) => b.data.startsWith(DENOM_PREFIX)).map((b) => b.text));
  const expectReadable = (names: string[]) => {
    const products = listOf(names);
    const found = violations(products, "id");
    expect(found, found.join("\n")).toEqual([]);
    const texts = textsOf(products);
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) expect(text, `${text} (a bare or suffixed id although a shortened form tells the SKUs apart)`).not.toMatch(/(^|\s)#\d+$/);
    return texts;
  };

  it("uses the dictionary's abbreviations before it cuts a name", () => {
    const texts = expectReadable(["Weekly Premium Subscription Package", "Monthly Membership Subscription Deal"]);
    expect(texts).toEqual(["Wkly Prem Sub Pkg · Rp125K", "Mthly Member Sub Deal · Rp125K"]);
  });
  it("shows a too-wide bonus amount's own unit as its icon before it cuts anything", () => {
    const [text] = textsOf([build({ id: idOf(0), name: "1000 Diamonds + 100 Bonds", price: "1000000000" }, "USD", "en", QUALIFIERS[0]!)]);
    expect(text).toBe("1000 💎 + 100 Bonds · $62,500.00");
  });
  it("siblings that share their end are told apart by their first words", () => {
    expectReadable(["Gamma", "Delta", "Omega", "Sigma", "Kappa", "Theta"].map((word) => `Alpha Series ${word} Edition Special Collector Pack Plus`));
  });
  it("two spellings of the same long name (abbreviated by the supplier or not) stay distinct", () => {
    for (let i = 1; i <= 4; i++) expectReadable([`Weekly Premium Subscription Package Bonus ${i}`, `Weekly Premium Subscription Pkg Bonus ${i}`]);
  });
  it("a long name whose first words and end match a shorter sibling's whole name does not read like it", () => {
    const texts = expectReadable(["Alpha Series Gamma Edition Special Collector Pack Plus", "Alpha Series Pack Plus"]);
    expect(texts[1]).toBe("Alpha Series Pack Plus · Rp125K");
  });
  it("drops a trailing qualifier the list repeats before it would cut the start of a name", () => {
    const texts = expectReadable(["Black Hawk Down Redefine  - Garena", "Operations Pass Season - Garena", "Coin Starter Kit - Garena"]);
    expect(texts[0]).toBe("Black Hawk Down Redefine · Rp125K");
  });
  it("keeps the first word of a long name instead of chopping its start", () => {
    const texts = expectReadable(["Blessing of the Welkin Moon x2", "Blessing of the Welkin Moon"]);
    expect(texts[0]).toMatch(/^Blessing of(?: the)?… .*Moon x2 · Rp125K$/);
  });
});

describe("keyboard label guard: the other pickers keep their own limits", () => {
  const hostileNames = ["超级钻石礼包超级钻石礼包超级钻石礼包", "🎮💎🔥".repeat(12), "A".repeat(200), "Weekly Diamond Pass Bundle Supplier Special Edition", "Mega <b>&</b> Pack", "1 Month", "Ünïcödé".repeat(9)];
  const buttonsOf = (keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }, prefix: string) =>
    keyboard.inline_keyboard.map((row) => row.filter((button) => button.callback_data?.startsWith(prefix)));

  it("the Premium plan picker puts at most two buttons on a row and cuts every label at the plan limit", () => {
    const plans = hostileNames.map((name, i) => ({ id: 100 + i, name, durationLabel: name }));
    const rows = buttonsOf(denominationPickerKb(plans, PRODUCT_ID, "Netflix Premium", "en"), DENOM_PREFIX).filter((row) => row.length > 0);
    expect(rows.flat()).toHaveLength(plans.length);
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(2);
      for (const button of row) {
        expect(button.text.length, button.text).toBeLessThanOrEqual(PLAN_LABEL_MAX_CHARS);
        expect(button.text, button.text).not.toMatch(/^#\d+$/);
        expect(button.callback_data).toMatch(/^v1:browse:denom:\d+$/);
      }
    }
  });
  it("the plan cut is the shared constant that util/format.ts reads", () => {
    expect(BUTTON_LABEL_MAX).toBe(PLAN_LABEL_MAX_CHARS);
    expect(truncLabel("x".repeat(PLAN_LABEL_MAX_CHARS))).toBe("x".repeat(PLAN_LABEL_MAX_CHARS));
    expect(truncLabel("x".repeat(PLAN_LABEL_MAX_CHARS + 1))).toBe(`${"x".repeat(PLAN_LABEL_MAX_CHARS - 1)}…`);
  });
  it("search, popular and category buttons are cut at the list limit and keep a name within the admin budget whole", () => {
    const products = hostileNames.map((name, i) => ({ id: 200 + i, name }));
    const categories = hostileNames.map((name, i) => ({ id: 300 + i, name, emoji: i % 2 ? "🎮" : null }));
    const all = [
      ...searchResultsKb(products, "en").inline_keyboard.flat(), ...popularKb(products, "en").inline_keyboard.flat(), ...categoryPickerKb(categories, "en").inline_keyboard.flat(),
    ].filter((button) => "callback_data" in button && button.callback_data.startsWith("v1:browse:"));
    expect(all.length).toBeGreaterThan(products.length * 2);
    for (const button of all) expect(button.text.length, button.text).toBeLessThanOrEqual(LIST_LABEL_MAX_CHARS);
    // The admin hint promises that a name within the budget is never cut.
    const budget = buttonNameBudget("productList");
    const fitting = "x".repeat(budget);
    expect(visualWidth(fitting)).toBe(budget);
    for (const keyboard of [searchResultsKb([{ id: 1, name: fitting }], "en"), popularKb([{ id: 1, name: fitting }], "en")]) expect(keyboard.inline_keyboard[0]![0]!.text).toBe(fitting);
    const category = buttonNameBudget("category", { emoji: true });
    expect(categoryPickerKb([{ id: 1, name: "a".repeat(category), emoji: "🎮" }], "en").inline_keyboard[0]![0]!.text).toBe(`🎮 ${"a".repeat(category)}`);
  });
  it("variant and region buttons for a name within the admin budget fit two to a row", () => {
    const budgetOf = (kind: "gameVariant" | "gameRegion", emoji = false) => buttonNameBudget(kind, { emoji });
    const variants = [{ label: "a".repeat(budgetOf("gameVariant", true)), emoji: "🎮" }, { label: "超".repeat(Math.floor(budgetOf("gameVariant") / 2)), emoji: null }];
    const regions = ["a".repeat(budgetOf("gameRegion")), "超".repeat(Math.floor(budgetOf("gameRegion") / 2))];
    const rows = [...gameVariantPickerKb(variants, 1, "back", "en").inline_keyboard, ...gameRegionPickerKb(regions, 1, "back", "en").inline_keyboard];
    const pickerButtons = rows.flat().filter((button) => "callback_data" in button && /^v1:browse:g(var|reg):/.test(button.callback_data));
    expect(pickerButtons).toHaveLength(variants.length + regions.length);
    for (const button of pickerButtons) expect(visualWidth(button.text), button.text).toBeLessThanOrEqual(NARROW_LABEL_WIDTH);
  });
});
