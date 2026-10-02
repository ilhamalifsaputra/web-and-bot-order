import { describe, it, expect } from "vitest";
import { Decimal } from "./money";
import {
  isIndonesianLanguage,
  moneySeparators,
  groupDecimalDigits,
  formatIdrFor,
  formatUsdFor,
  formatCompactIdrFor,
} from "./moneyFormat";
import { formatDisplayMoneyResult } from "./formatters";
import { DisplayCurrency } from "./enums";
import { canonicalProduct, type CanonicalProductInput } from "./canonicalProduct";

/** Undo a language's money formatting: drop the symbol and the group separator, turn the decimal separator into ".". */
function parseBack(text: string, lang: string): Decimal {
  const { group, decimal } = moneySeparators(lang);
  const negative = text.startsWith("-");
  const body = (negative ? text.slice(1) : text).replace(/^(Rp|\$)/, "").split(group).join("").replace(decimal, ".");
  return new Decimal(negative ? `-${body}` : body);
}

/** Swap "." and "," — the only difference allowed between the two languages. */
function swapSeparators(text: string): string {
  return text.replace(/[.,]/g, (c) => (c === "." ? "," : "."));
}

const IDR_AMOUNTS = ["0", "1", "999", "1000", "4480", "30000", "999999", "1000000", "1234567", "1640000", "987654321098", "4480.4", "4480.5", "21000.1254", "0.5"];
const USD_AMOUNTS = ["0", "0.01", "0.28", "1", "4.94", "999.99", "1000", "1234.5", "1234.56", "1000000", "987654321.12"];

describe("language rule", () => {
  it("treats every id* code as Indonesian and everything else (including unknown and missing) as English", () => {
    for (const lang of ["id", "ID", "id-ID", "id_ID"]) expect(isIndonesianLanguage(lang)).toBe(true);
    for (const lang of ["en", "en-US", "fr", "", null, undefined]) expect(isIndonesianLanguage(lang)).toBe(false);
    expect(moneySeparators("id")).toEqual({ group: ".", decimal: "," });
    expect(moneySeparators("en")).toEqual({ group: ",", decimal: "." });
    expect(moneySeparators("xx")).toEqual({ group: ",", decimal: "." });
  });
});

describe("groupDecimalDigits", () => {
  it("groups the whole part and keeps every fraction digit, including trailing zeros", () => {
    expect(groupDecimalDigits("1234567", "id")).toBe("1.234.567");
    expect(groupDecimalDigits("1234567", "en")).toBe("1,234,567");
    expect(groupDecimalDigits("21000.1254", "id")).toBe("21.000,1254");
    expect(groupDecimalDigits("21000.1254", "en")).toBe("21,000.1254");
    expect(groupDecimalDigits("8.10", "id")).toBe("8,10");
    expect(groupDecimalDigits("999", "en")).toBe("999");
    expect(groupDecimalDigits("0.5", "id")).toBe("0,5");
  });
});

describe("formatIdrFor", () => {
  it("renders the decided examples", () => {
    expect(formatIdrFor(4480, "id")).toBe("Rp4.480");
    expect(formatIdrFor(4480, "en")).toBe("Rp4,480");
    expect(formatIdrFor("30000", "en")).toBe("Rp30,000");
    expect(formatIdrFor(new Decimal("1234567"), "id")).toBe("Rp1.234.567");
    expect(formatIdrFor(0, "en")).toBe("Rp0");
    expect(formatIdrFor(-5000, "en")).toBe("-Rp5,000");
  });

  it("rounds fractional rupiah half-up to whole rupiah exactly like formatIdr", () => {
    expect(formatIdrFor("4480.4", "en")).toBe("Rp4,480");
    expect(formatIdrFor("4480.5", "en")).toBe("Rp4,481");
    expect(formatIdrFor("4480.5", "id")).toBe("Rp4.481");
  });

  it("keeps the Indonesian spelling the web has always used (literal table)", () => {
    const table: Array<[string, string]> = [["0", "Rp0"], ["999", "Rp999"], ["79000", "Rp79.000"], ["1234567", "Rp1.234.567"], ["-5000", "-Rp5.000"], ["4480.5", "Rp4.481"]];
    for (const [amount, expected] of table) expect(formatIdrFor(amount, "id")).toBe(expected);
  });

  it.each(IDR_AMOUNTS)("never changes the number for %s (parse back = whole-rupiah value), and the languages differ only in separators", (a) => {
    const whole = new Decimal(a).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    for (const lang of ["id", "en"]) expect(parseBack(formatIdrFor(a, lang), lang).equals(whole)).toBe(true);
    expect(swapSeparators(formatIdrFor(a, "id"))).toBe(formatIdrFor(a, "en"));
  });
});

describe("formatUsdFor", () => {
  it("renders the decided examples", () => {
    expect(formatUsdFor("0.28", "id")).toBe("$0,28");
    expect(formatUsdFor("0.28", "en")).toBe("$0.28");
    expect(formatUsdFor("1234.5", "id")).toBe("$1.234,50");
    expect(formatUsdFor("1234.5", "en")).toBe("$1,234.50");
    expect(formatUsdFor("-1250", "en")).toBe("-$1,250.00");
  });

  it("keeps the English USD spelling the bot used before languages (literal table)", () => {
    const table: Array<[string, string]> = [["0", "$0.00"], ["0.28", "$0.28"], ["4.94", "$4.94"], ["1250", "$1,250.00"], ["1234.5", "$1,234.50"], ["-1250", "-$1,250.00"]];
    for (const [amount, expected] of table) expect(formatUsdFor(amount, "en")).toBe(expected);
  });

  it.each(USD_AMOUNTS)("never changes the number for %s and the languages differ only in separators", (a) => {
    for (const lang of ["id", "en"]) expect(parseBack(formatUsdFor(a, lang), lang).equals(new Decimal(a))).toBe(true);
    expect(swapSeparators(formatUsdFor(a, "id"))).toBe(formatUsdFor(a, "en"));
  });
});

describe("formatCompactIdrFor", () => {
  it("renders the decided examples", () => {
    expect(formatCompactIdrFor(1640000, "id")).toBe("Rp1,64M");
    expect(formatCompactIdrFor(1640000, "en")).toBe("Rp1.64M");
    expect(formatCompactIdrFor(4480, "id")).toBe("Rp4K");
    expect(formatCompactIdrFor(4480, "en")).toBe("Rp4K");
    expect(formatCompactIdrFor(2000000, "id")).toBe("Rp2M");
    expect(formatCompactIdrFor(999, "en")).toBe("Rp999");
  });

  it("keeps the compact spellings from the legacy table (literal)", () => {
    const table: Array<[number, string, string]> = [
      [999, "Rp999", "Rp999"],
      [4480, "Rp4K", "Rp4K"],
      [355000, "Rp355K", "Rp355K"],
      [1640000, "Rp1.64M", "Rp1,64M"],
      [2000000, "Rp2M", "Rp2M"],
    ];
    for (const [amount, en, id] of table) {
      expect(formatCompactIdrFor(amount, "en")).toBe(en);
      expect(formatCompactIdrFor(amount, "id")).toBe(id);
    }
  });

  it.each(IDR_AMOUNTS)("differs between languages only in separators for %s", (a) => {
    expect(swapSeparators(formatCompactIdrFor(a, "id"))).toBe(formatCompactIdrFor(a, "en"));
  });
});

describe("one amount, one string across the canonical price and the display-currency price", () => {
  // The detail/confirmation unit price comes from canonicalProduct().formattedPrice; the picker lines, the
  // confirmation Total and the payment "Price" line from formatDisplayMoneyResult. They must agree per language.
  const input: CanonicalProductInput = {
    denomination: { id: 1, name: "86 Diamonds", durationLabel: "86 Diamonds", isActive: true },
    product: { id: 1, name: "Mobile Legends", isActive: true },
    category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
  };
  const cases = ["id", "en"].flatMap((lang) => ["0", "999", "4480", "79000", "1234567"].flatMap((idr) => (["IDR", "USD"] as const).map((cur) => ({ lang, idr, cur }))));

  it.each(cases)("$lang / $cur / Rp$idr", ({ lang, idr, cur }) => {
    const canonical = canonicalProduct(input, { effectivePriceIDR: idr, preferredCurrency: cur, rate: "16000", locale: lang });
    expect(canonical.formattedPrice).toBe(formatDisplayMoneyResult(idr, cur as DisplayCurrency, "16000", lang).text);
  });
});

describe("formatDisplayMoneyResult with a language", () => {
  it("keeps the no-language output byte-identical", () => {
    expect(formatDisplayMoneyResult(79000, DisplayCurrency.IDR, null).text).toBe("Rp79.000");
    expect(formatDisplayMoneyResult(20000000, DisplayCurrency.USD, "16000").text).toBe("$1,250.00");
  });

  it("follows the language for both currencies", () => {
    expect(formatDisplayMoneyResult(79000, DisplayCurrency.IDR, null, "en").text).toBe("Rp79,000");
    expect(formatDisplayMoneyResult(79000, DisplayCurrency.IDR, null, "id").text).toBe("Rp79.000");
    expect(formatDisplayMoneyResult(4480, DisplayCurrency.USD, "16000", "id").text).toBe("$0,28");
    expect(formatDisplayMoneyResult(4480, DisplayCurrency.USD, "16000", "en").text).toBe("$0.28");
    // USD asked for without a rate falls back to an explicit Rupiah string in the same language.
    const fellBack = formatDisplayMoneyResult(79000, DisplayCurrency.USD, null, "en");
    expect(fellBack).toEqual({ text: "Rp79,000", currency: DisplayCurrency.IDR, fellBack: true });
  });
});
