import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Decimal } from "./money";
import { formatCompactPrice } from "./compactFormat";
import { canonicalProduct } from "./canonicalProduct";
import {
  buttonNameBudget, visualWidth, MAX_LABEL_WIDTH, TARGET_LABEL_WIDTH, NARROW_LABEL_WIDTH, MAX_LABEL_BYTES, CATALOG_PAGE_SIZE,
  LIST_LABEL_MAX_CHARS, COMPACT_PRICE_CELLS, QUANTITY_CELLS, SEPARATOR_CELLS, EMOJI_PREFIX_CELLS, nameAfterProductPrefix, type ButtonNameKind,
} from "./buttonLimits";

describe("button limits", () => {
  it("pins the documented constants", () => {
    expect([MAX_LABEL_WIDTH, TARGET_LABEL_WIDTH, NARROW_LABEL_WIDTH, MAX_LABEL_BYTES, CATALOG_PAGE_SIZE]).toEqual([36, 32, 18, 64, 20]);
    expect(TARGET_LABEL_WIDTH).toBeLessThan(MAX_LABEL_WIDTH);
    expect(NARROW_LABEL_WIDTH).toBeLessThan(TARGET_LABEL_WIDTH);
  });

  it("measures cells, not string length", () => {
    expect(visualWidth("Diamonds")).toBe(8);
    expect(visualWidth("你好")).toBe(4);
    expect(visualWidth("💎")).toBe(2);
    expect(visualWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(visualWidth("é")).toBe(1);
    expect(visualWidth("🇮🇩")).toBe(2);
  });

  it("derives the separator and emoji prefix from the real strings", () => {
    expect(SEPARATOR_CELLS).toBe(3);
    expect(EMOJI_PREFIX_CELLS).toBe(3);
  });

  it("covers the widest compact price the bot prints on a Game Top-Up button", () => {
    // IDR: every SKU under Rp100 million, in both decimal-separator spellings.
    for (const amount of ["999", "1000", "999499", "999500", "1640000", "10250000", "99990000"]) {
      const price = formatCompactPrice(new Decimal(amount));
      expect(visualWidth(price), price).toBeLessThanOrEqual(COMPACT_PRICE_CELLS.IDR);
      expect(visualWidth(price.replace(".", ",")), price).toBeLessThanOrEqual(COMPACT_PRICE_CELLS.IDR);
    }
    // USD: exact amounts under $10,000, in both locales.
    for (const locale of ["en", "id"]) {
      const usd = canonicalProduct({
        denomination: { id: 1, name: "86 Diamonds", durationLabel: "86 Diamonds", isActive: true },
        product: { id: 1, name: "Mobile Legends", isActive: true },
        category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
      }, { effectivePriceIDR: "159999840", preferredCurrency: "USD", rate: "16000", locale });
      expect(usd.formattedPrice).toMatch(/\$9[.,]999[.,]99/);
      expect(visualWidth(usd.formattedPrice)).toBeLessThanOrEqual(COMPACT_PRICE_CELLS.USD);
    }
  });

  it("budgets a name so the whole button still fits", () => {
    expect(buttonNameBudget("productList")).toBe(LIST_LABEL_MAX_CHARS);
    expect(buttonNameBudget("category")).toBe(18);
    expect(buttonNameBudget("category", { emoji: true })).toBe(15);
    expect(buttonNameBudget("gameVariant")).toBe(18);
    expect(buttonNameBudget("gameVariant", { emoji: true })).toBe(15);
    expect(buttonNameBudget("gameRegion")).toBe(18);
    expect(buttonNameBudget("denominationPlan")).toBe(18);
    expect(buttonNameBudget("denominationGame", { currency: "IDR" })).toBe(25);
    expect(buttonNameBudget("denominationGame", { currency: "USD" })).toBe(24);
    expect(buttonNameBudget("denominationGame")).toBe(24);
    expect(buttonNameBudget("qtyUnit", { currency: "IDR" })).toBe(17);
    expect(buttonNameBudget("qtyUnit")).toBe(16);
  });

  it("never lets a name plus its fixed part exceed the single-column cap, nor a paired name the narrow cap", () => {
    for (const currency of ["IDR", "USD"] as const) {
      expect(buttonNameBudget("denominationGame", { currency }) + SEPARATOR_CELLS + COMPACT_PRICE_CELLS[currency]).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
      expect(buttonNameBudget("qtyUnit", { currency }) + QUANTITY_CELLS + 1 + SEPARATOR_CELLS + COMPACT_PRICE_CELLS[currency]).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
    }
    expect(buttonNameBudget("productList")).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
    for (const kind of ["category", "gameVariant"] as ButtonNameKind[]) {
      expect(buttonNameBudget(kind, { emoji: true }) + EMOJI_PREFIX_CELLS).toBeLessThanOrEqual(NARROW_LABEL_WIDTH);
    }
    for (const kind of ["gameRegion", "denominationPlan"] as ButtonNameKind[]) expect(buttonNameBudget(kind)).toBeLessThanOrEqual(NARROW_LABEL_WIDTH);
  });

  it("keeps the admin client's copy byte-identical (it cannot import @app/core)", () => {
    const here = readFileSync(new URL("./buttonLimits.ts", import.meta.url), "utf8");
    const copy = readFileSync(new URL("../../../apps/web-admin/client/src/lib/buttonLimits.ts", import.meta.url), "utf8");
    expect(copy, "apps/web-admin/client/src/lib/buttonLimits.ts must be an exact copy of packages/core/src/buttonLimits.ts").toBe(here);
  });
});

describe("nameAfterProductPrefix", () => {
  it("drops the product name from the start of a name, whole token and case-insensitive", () => {
    expect(nameAfterProductPrefix("Mobile Legends 86 Diamonds", "Mobile Legends")).toBe("86 Diamonds");
    expect(nameAfterProductPrefix("MOBILE LEGENDS 86 Diamonds", "mobile legends")).toBe("86 Diamonds");
    expect(nameAfterProductPrefix("Mobile Legends Event Gift Pack 1 Diamonds", "Mobile Legends")).toBe("Event Gift Pack 1 Diamonds");
  });
  it("also drops a product name written without its trailing (Region)", () => {
    expect(nameAfterProductPrefix("Where Winds Meet 60 Echo Beads", "Where Winds Meet (Global)")).toBe("60 Echo Beads");
    expect(nameAfterProductPrefix("Valorant (Indonesia) 1000 VP", "Valorant (Indonesia)")).toBe("1000 VP");
  });
  it("collapses repeated whitespace like the bot", () => {
    expect(nameAfterProductPrefix("  Delta Force   Black Hawk   Down  ", "Delta Force")).toBe("Black Hawk Down");
    expect(nameAfterProductPrefix("a   b ", "")).toBe("a b");
  });
  it("keeps the whole name when the product name is not a whole-token prefix or the rest would read badly", () => {
    expect(nameAfterProductPrefix("Mobile Legends86 Diamonds", "Mobile Legends")).toBe("Mobile Legends86 Diamonds");
    expect(nameAfterProductPrefix("Valorants 100", "Valorant")).toBe("Valorants 100");
    expect(nameAfterProductPrefix("Mobile Legends", "Mobile Legends")).toBe("Mobile Legends");
    expect(nameAfterProductPrefix("Delta Force 400", "Delta Force")).toBe("Delta Force 400");
    expect(nameAfterProductPrefix("Delta Force - Family", "Delta Force")).toBe("Delta Force - Family");
    expect(nameAfterProductPrefix("Weekly Pass", "Mobile Legends")).toBe("Weekly Pass");
  });
  it("agrees with what the bot's own canonical name keeps (canonicalProduct drops the same prefix)", () => {
    const cases: [string, string][] = [
      ["Genshin Impact", "Genshin Impact Blessing of the Welkin Moon Package"],
      ["Where Winds Meet (Global)", "Where Winds Meet Starter Package"],
      ["Delta Force", "Delta Force 400 Package"],
      ["Delta Force", "Delta Force - Family Package"],
      ["Honkai Star Rail", "honkai star rail Oneiric Package"],
      ["Valorant (Indonesia)", "Valorant Premium Battle Package"],
      ["Arena Breakout", "Arena Breakout Infinite Edition Starter Package"],
    ];
    for (const [productName, raw] of cases) {
      const product = canonicalProduct({
        denomination: { id: 1, name: raw, durationLabel: raw, supplierRawName: raw, isActive: true },
        product: { id: 1, name: productName, isActive: true },
        category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
      }, { effectivePriceIDR: "1000", preferredCurrency: "IDR", locale: "id" });
      expect(product.variant.type, raw).toBe("package");
      expect(nameAfterProductPrefix(raw, productName), raw).toBe((product.variant as { name: string }).name);
    }
  });
});
