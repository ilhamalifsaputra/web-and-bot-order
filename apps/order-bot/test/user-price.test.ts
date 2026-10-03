/**
 * userPriceFormatter — the bot's single render-edge entry
 * point for catalog prices in the user's display currency. Canonical amounts
 * are IDR; USD is derived once (usdtFromIdr, ceil 0.01) and a missing rate
 * falls back to an explicit "Rp…" string, never a bare number or an invented
 * rate.
 */
import { describe, it, expect } from "vitest";
import { Decimal } from "@app/core/money";
import { DisplayCurrency } from "@app/core/enums";
import {
  userPriceFormatter,
  ctxPriceFormatter,
  payAlongsidePriceLine,
  displayValidationArgs,
  orderAmount,
  mixedAmount,
  priceIdr,
} from "../src/util/format";
import { coreT } from "../src/util/i18n";

const RATE = new Decimal(16000);

describe("userPriceFormatter().price (rounding, fallback and single conversion)", () => {
  it("renders a USD user's IDR price as $ with 2dp", () => {
    expect(userPriceFormatter(DisplayCurrency.USD, RATE).price(79000)).toBe("$4.94");
  });

  it("renders an IDR user's price as Rp only — no ≈ $ hint", () => {
    const text = userPriceFormatter(DisplayCurrency.IDR, RATE).price(79000);
    expect(text).toBe("Rp79.000");
    expect(text).not.toContain("$");
  });

  it("treats a NULL preference as IDR-labelled, never USD", () => {
    expect(userPriceFormatter(null, RATE).price(79000)).toBe("Rp79.000");
    expect(userPriceFormatter(undefined, RATE).price(79000)).toBe("Rp79.000");
  });

  it("rounds USD up to the next cent (ceil), matching what the USDT rails charge", () => {
    const f = userPriceFormatter(DisplayCurrency.USD, RATE);
    expect(f.price(15999)).toBe("$1.00");
    expect(f.price(16001)).toBe("$1.01");
  });

  it("falls back to an explicit Rp string with fellBack when the rate is unavailable", () => {
    const f = userPriceFormatter(DisplayCurrency.USD, null);
    expect(f.price(79000)).toBe("Rp79.000");
    expect(f.fellBack).toBe(true);
  });

  it("groups large USD amounts with commas", () => {
    expect(userPriceFormatter(DisplayCurrency.USD, RATE).price(20_000_000)).toBe("$1,250.00");
  });

  it("converts exactly once: the IDR path never rescales, the USD path divides a single time", () => {
    // An already-converted figure must only ever go through the explicit
    // IDR path (which leaves the number alone), never through USD again.
    expect(userPriceFormatter(DisplayCurrency.IDR, RATE).price("4.94")).toBe("Rp5");
    // 16000 IDR -> $1.00; a second conversion would give $0.01.
    expect(userPriceFormatter(DisplayCurrency.USD, RATE).price(16000)).toBe("$1.00");
  });
});

describe("userPriceFormatter", () => {
  it("formats prices and reports showsUsd for a USD user with a rate", () => {
    const f = userPriceFormatter(DisplayCurrency.USD, RATE);
    expect(f.price(79000)).toBe("$4.94");
    expect(f.showsUsd).toBe(true);
    expect(f.fellBack).toBe(false);
    expect(f.rateNotice("en")).toBe("");
  });

  it("flags fellBack and yields the rate_unavailable notice once when a USD user has no rate", () => {
    const f = userPriceFormatter(DisplayCurrency.USD, null);
    expect(f.price(79000)).toBe("Rp79.000");
    expect(f.showsUsd).toBe(false);
    expect(f.fellBack).toBe(true);
    expect(f.rateNotice("en")).toBe(`\n\n${coreT("currency.rate_unavailable", "en")}`);
  });

  it("never shows the notice for IDR or NULL users, even without a rate", () => {
    expect(userPriceFormatter(DisplayCurrency.IDR, null).rateNotice("en")).toBe("");
    expect(userPriceFormatter(null, null).rateNotice("en")).toBe("");
  });

  it("compact(): IDR stays the short Rp79K form, USD shows the $ price", () => {
    expect(userPriceFormatter(DisplayCurrency.IDR, RATE).compact(79000)).toBe("Rp79K");
    expect(userPriceFormatter(null, RATE).compact(79000)).toBe("Rp79K");
    expect(userPriceFormatter(DisplayCurrency.USD, RATE).compact(79000)).toBe("$4.94");
    expect(userPriceFormatter(DisplayCurrency.USD, null).compact(79000)).toBe("Rp79K");
  });

  it("ctxPriceFormatter reads the session's preferredCurrency", () => {
    const ctx = { session: { dbUser: { preferredCurrency: "USD" as const } } };
    expect(ctxPriceFormatter(ctx, RATE).price(16000)).toBe("$1.00");
    expect(ctxPriceFormatter({ session: {} }, RATE).price(16000)).toBe("Rp16.000");
  });
});

describe("prices follow the buyer's language", () => {
  it("price() uses the language's separators for both currencies", () => {
    const price = (currency: DisplayCurrency, idr: number, lang: string, rate: Decimal | null = RATE) => userPriceFormatter(currency, rate, lang).price(idr);
    expect(price(DisplayCurrency.IDR, 4480, "id")).toBe("Rp4.480");
    expect(price(DisplayCurrency.IDR, 4480, "en")).toBe("Rp4,480");
    expect(price(DisplayCurrency.USD, 4480, "id")).toBe("$0,28");
    expect(price(DisplayCurrency.USD, 4480, "en")).toBe("$0.28");
    expect(price(DisplayCurrency.USD, 19_752_000, "id")).toBe("$1.234,50");
    expect(price(DisplayCurrency.USD, 19_752_000, "en")).toBe("$1,234.50");
    // A USD buyer without a rate gets the explicit Rupiah in their own language.
    const noRate = userPriceFormatter(DisplayCurrency.USD, null, "en");
    expect(noRate.price(79000)).toBe("Rp79,000");
    expect(noRate.fellBack).toBe(true);
  });

  it("price() and compact() agree with the language, the USD compact being the full price", () => {
    const idrId = userPriceFormatter(DisplayCurrency.IDR, RATE, "id");
    const idrEn = userPriceFormatter(DisplayCurrency.IDR, RATE, "en");
    expect(idrId.lang).toBe("id");
    expect(idrId.price(30000)).toBe("Rp30.000");
    expect(idrEn.price(30000)).toBe("Rp30,000");
    expect(idrId.compact(1_640_000)).toBe("Rp1,64jt");
    expect(idrEn.compact(1_640_000)).toBe("Rp1.64M");
    expect(idrId.compact(79000)).toBe("Rp79K");
    expect(idrEn.compact(79000)).toBe("Rp79K");
    expect(userPriceFormatter(DisplayCurrency.USD, RATE, "id").compact(4480)).toBe("$0,28");
    expect(userPriceFormatter(DisplayCurrency.USD, RATE, "en").compact(4480)).toBe("$0.28");
  });

  it("the language-less call keeps the long-standing output", () => {
    const legacy = userPriceFormatter(DisplayCurrency.IDR, RATE);
    expect(legacy.lang).toBeUndefined();
    expect(legacy.price(30000)).toBe("Rp30.000");
    expect(legacy.compact(1_640_000)).toBe("Rp1.64M");
    expect(userPriceFormatter(DisplayCurrency.USD, RATE).price(19_752_000)).toBe("$1,234.50");
  });

  it("ctxPriceFormatter takes the language from the session", () => {
    const usdId = { session: { lang: "id", dbUser: { preferredCurrency: "USD" as const } } };
    const idrEn = { session: { lang: "en", dbUser: { preferredCurrency: "IDR" as const } } };
    expect(ctxPriceFormatter(usdId, RATE).price(4480)).toBe("$0,28");
    expect(ctxPriceFormatter(idrEn, RATE).price(4480)).toBe("Rp4,480");
  });

  it("orderAmount, mixedAmount and priceIdr localize Rupiah and never touch USDT", () => {
    expect(orderAmount({ totalAmount: "40000", currency: "IDR" }, 2, "en")).toBe("Rp40,000");
    expect(orderAmount({ totalAmount: "40000", currency: "IDR" }, 2, "id")).toBe("Rp40.000");
    expect(orderAmount({ totalAmount: "2.5", currency: "USDT" }, 2, "id")).toBe("2.50 USDT");
    expect(orderAmount({ totalAmount: "2.5", currency: "USDT" }, 4, "en")).toBe("2.5000 USDT");
    expect(orderAmount({ totalAmount: "40000", currency: "IDR" })).toBe("Rp40.000");
    expect(mixedAmount("1234000", "5", "en")).toBe("Rp1,234,000 + 5 USDT");
    expect(mixedAmount("1234000", "5", "id")).toBe("Rp1.234.000 + 5 USDT");
    expect(mixedAmount("1234000", "5")).toBe("Rp1.234.000 + 5 USDT");
    // 79000 / 16000 = 4.9375 → 4.94 (ceil); only the separators move.
    expect(priceIdr(79000, RATE, "en")).toBe("Rp79,000 (≈ $4.94)");
    expect(priceIdr(79000, RATE, "id")).toBe("Rp79.000 (≈ $4,94)");
    expect(priceIdr(79000, RATE)).toBe("Rp79.000 (≈ $4.94)");
    expect(priceIdr(79000, null, "en")).toBe("Rp79,000");
  });

  it("mixedAmount never shows a USDT balance with exactly three decimals", () => {
    expect(mixedAmount("1234000", "12.345", "id")).toBe("Rp1.234.000 + 12.3450 USDT");
    expect(mixedAmount("0", "12.345", "en")).toBe("12.3450 USDT");
    expect(mixedAmount("0", "12.34", "id")).toBe("12.34 USDT");
    expect(mixedAmount("0", "12.3456", "id")).toBe("12.3456 USDT");
  });

  it("priceIdr lets the $ hint use its own spelling so a USDT order reads as one style", () => {
    // An Indonesian buyer's USDT order shows "2.50 USDT" as the total, so the "≈ $" hint beside the Rupiah
    // snapshot must not flip to a decimal comma on the same screen.
    expect(priceIdr(79000, RATE, "id", "en")).toBe("Rp79.000 (≈ $4.94)");
    expect(priceIdr(79000, RATE, "en", "id")).toBe("Rp79,000 (≈ $4,94)");
    // Omitted → the hint follows `lang`, exactly as before.
    expect(priceIdr(79000, RATE, "id")).toBe("Rp79.000 (≈ $4,94)");
    expect(priceIdr(79000, null, "id", "en")).toBe("Rp79.000");
  });
});

describe("payAlongsidePriceLine", () => {
  it("shows the $ price next to the native payable for a USD user on an IDR rail", () => {
    const f = userPriceFormatter(DisplayCurrency.USD, RATE);
    expect(payAlongsidePriceLine(f, 156800, "Rp160.000", "en")).toBe(
      `\n\n${coreT("checkout.price_and_pay", "en", { price: "$9.80", pay: "Rp160.000" })}`,
    );
    expect(payAlongsidePriceLine(f, 156800, "Rp160.000", "en")).toContain("Price $9.80 · Pay Rp160.000");
    expect(payAlongsidePriceLine(f, 156800, "Rp160.000", "id")).toContain("Harga $9.80 · Bayar Rp160.000");
  });

  it("adds nothing when the display currency already matches the rail (IDR/NULL user, or USD with no rate)", () => {
    expect(payAlongsidePriceLine(userPriceFormatter(DisplayCurrency.IDR, RATE), 156800, "Rp160.000", "en")).toBe("");
    expect(payAlongsidePriceLine(userPriceFormatter(null, RATE), 156800, "Rp160.000", "en")).toBe("");
    expect(payAlongsidePriceLine(userPriceFormatter(DisplayCurrency.USD, null), 156800, "Rp160.000", "en")).toBe("");
  });
});

describe("displayValidationArgs", () => {
  it("formats a voucher minimum purchase (IDR-canonical) in the display currency", () => {
    const usd = userPriceFormatter(DisplayCurrency.USD, RATE);
    expect(displayValidationArgs("error.voucher_min_purchase", { min: "80000" }, usd)).toEqual({ min: "$5.00" });
    const idr = userPriceFormatter(DisplayCurrency.IDR, RATE);
    expect(displayValidationArgs("error.voucher_min_purchase", { min: "80000" }, idr)).toEqual({ min: "Rp80.000" });
  });

  it("leaves every other error's args untouched", () => {
    const usd = userPriceFormatter(DisplayCurrency.USD, RATE);
    const args = { min: "5", currency: "USDT" };
    expect(displayValidationArgs("error.amount_below_rail_minimum", args, usd)).toBe(args);
  });

  it("writes an IDR rail minimum as Rupiah in the buyer's language, never converted to the display currency", () => {
    const args = { min: "10000", currency: "IDR" };
    // The minimum is what the rail charges in Rupiah, so a USD-display buyer still reads Rupiah.
    expect(displayValidationArgs("error.amount_below_rail_minimum", args, userPriceFormatter(DisplayCurrency.USD, RATE, "id"))).toEqual({ min: "Rp10.000", currency: "IDR" });
    expect(displayValidationArgs("error.amount_below_rail_minimum", args, userPriceFormatter(DisplayCurrency.IDR, RATE, "en"))).toEqual({ min: "Rp10,000", currency: "IDR" });
    // Without a language, the long-standing Indonesian spelling.
    expect(displayValidationArgs("error.amount_below_rail_minimum", args, userPriceFormatter(DisplayCurrency.IDR, RATE))).toEqual({ min: "Rp10.000", currency: "IDR" });
  });
});
