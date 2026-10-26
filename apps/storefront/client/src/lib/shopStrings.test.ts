import { describe, expect, it } from "vitest";
import en from "../../../../../packages/core/locales/en.json";
import id from "../../../../../packages/core/locales/id.json";
import { t } from "./i18n";
import { SHOP_STRINGS } from "./shopStrings";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("storefront-only strings", () => {
  it("carry the same keys and placeholders in both languages", () => {
    expect(Object.keys(SHOP_STRINGS.id).sort()).toEqual(Object.keys(SHOP_STRINGS.en).sort());
    for (const [key, value] of Object.entries(SHOP_STRINGS.en)) {
      expect(placeholders(SHOP_STRINGS.id[key]!), key).toEqual(placeholders(value));
    }
  });

  it("live under shop.* and never shadow a shared locale key", () => {
    for (const key of Object.keys(SHOP_STRINGS.en)) {
      expect(key.startsWith("shop."), key).toBe(true);
      expect(key in en, key).toBe(false);
      expect(key in id, key).toBe(false);
    }
  });

  it("stay product-family neutral", () => {
    for (const value of [...Object.values(SHOP_STRINGS.en), ...Object.values(SHOP_STRINGS.id)]) {
      expect(value).not.toMatch(/game|top[ -]?up|diamond|akun|account|premium|aplikasi|\bapps?\b/i);
    }
  });

  it("resolve through t() in each language", () => {
    expect(t("shop.tier_unit_each", { price: "Rp6.000" }, "id")).toBe("Rp6.000 per item");
    expect(t("shop.tier_unit_each", { price: "Rp6,000" }, "en")).toBe("Rp6,000 each");
  });
});
