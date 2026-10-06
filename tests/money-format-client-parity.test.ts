// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@app/core/money";
import { formatIdrFor, formatUsdFor } from "@app/core/moneyFormat";
import { formatUsdtAmount, usdtFromIdr } from "@app/core/formatters";
import { formatCurrencyDisplay, formatCurrencyParts } from "../apps/web-admin/client/src/components/shared/CurrencyAmount";
import { formatIdr, formatPriceFor, formatUsdtAmount as clientUsdt } from "../apps/storefront/client/src/lib/format";

afterEach(() => { document.documentElement.lang = ""; });

const cases = ["0", "-0.000001", "-0.4", "-2.5", "1.005", "1.00005", "-1.00005", "999999999999.99995", "9007199254740993.5", ...Array.from({ length: 160 }, (_, i) => `${i % 2 ? "-" : ""}${i * 7919}.${(i * 97 % 10000).toString().padStart(4, "0")}5`)];

describe("exact browser/server money parity", () => {
  it("rounds admin IDR and USD at decimal half boundaries", () => {
    expect(formatCurrencyDisplay("-2.5", "IDR")).toBe("-Rp3");
    expect(formatCurrencyDisplay("1.005", "USD")).toBe("1.01 USD");
    expect(formatCurrencyParts("1.005", "USD")).toEqual({ amount: "1.01", suffix: "USD" });
  });
  it("matches core whole-rupiah and native USDT precision for decimal tables including large values", () => {
    for (const value of cases) {
      expect(formatCurrencyDisplay(value, "IDR")).toBe(formatIdrFor(value, "id"));
      expect(formatCurrencyDisplay(value, "USDT")).toBe(`${formatUsdtAmount(value)} USDT`);
      expect(clientUsdt(value)).toBe(formatUsdtAmount(value));
    }
  });
  it("matches localized IDR and ceil-derived USD for the actual page language", () => {
    for (const lang of ["id", "en"]) {
      document.documentElement.lang = lang;
      for (const value of cases) {
        expect(formatIdr(value)).toBe(formatIdrFor(value, lang));
        expect(formatPriceFor(value, "USD", "16000")).toBe(formatUsdFor(usdtFromIdr(value, "16000"), lang));
        expect(formatPriceFor(value, "USD", null)).toBe(formatIdrFor(value, lang));
      }
    }
  });
  it("does not round a just-above-cent quote down through floating-point reparsing", () => {
    document.documentElement.lang = "en";
    const value = "44640.000000000001";
    expect(new Decimal(value).div(16000).gt("2.79")).toBe(true);
    expect(formatPriceFor(value, "USD", "16000")).toBe("$2.80");
  });
});
