/**
 * formatUserPrice / userPriceFormatter — the bot's single render-edge entry
 * point for catalog prices in the user's display currency. Canonical amounts
 * are IDR; USD is derived once (usdtFromIdr, ceil 0.01) and a missing rate
 * falls back to an explicit "Rp…" string, never a bare number or an invented
 * rate.
 */
import { describe, it, expect } from "vitest";
import { Decimal } from "@app/core/money";
import { DisplayCurrency } from "@app/core/enums";
import {
  formatUserPrice,
  userPriceFormatter,
  ctxPriceFormatter,
  payAlongsidePriceLine,
  displayValidationArgs,
} from "../src/util/format";
import { coreT } from "../src/util/i18n";

const RATE = new Decimal(16000);

describe("formatUserPrice", () => {
  it("renders a USD user's IDR price as $ with 2dp", () => {
    expect(formatUserPrice(DisplayCurrency.USD, 79000, RATE)).toEqual({
      text: "$4.94",
      currency: DisplayCurrency.USD,
      fellBack: false,
    });
  });

  it("renders an IDR user's price as Rp only — no ≈ $ hint", () => {
    const r = formatUserPrice(DisplayCurrency.IDR, 79000, RATE);
    expect(r.text).toBe("Rp79.000");
    expect(r.text).not.toContain("$");
    expect(r.fellBack).toBe(false);
  });

  it("treats a NULL preference as IDR-labelled, never USD", () => {
    expect(formatUserPrice(null, 79000, RATE).text).toBe("Rp79.000");
    expect(formatUserPrice(undefined, 79000, RATE).text).toBe("Rp79.000");
  });

  it("rounds USD up to the next cent (ceil), matching what the USDT rails charge", () => {
    expect(formatUserPrice(DisplayCurrency.USD, 15999, RATE).text).toBe("$1.00");
    expect(formatUserPrice(DisplayCurrency.USD, 16001, RATE).text).toBe("$1.01");
  });

  it("falls back to an explicit Rp string with fellBack when the rate is unavailable", () => {
    expect(formatUserPrice(DisplayCurrency.USD, 79000, null)).toEqual({
      text: "Rp79.000",
      currency: DisplayCurrency.IDR,
      fellBack: true,
    });
  });

  it("groups large USD amounts with commas", () => {
    expect(formatUserPrice(DisplayCurrency.USD, 20_000_000, RATE).text).toBe("$1,250.00");
  });

  it("converts exactly once: the IDR path never rescales, the USD path divides a single time", () => {
    // An already-converted figure must only ever go through the explicit
    // IDR path (which leaves the number alone), never through USD again.
    expect(formatUserPrice(DisplayCurrency.IDR, "4.94", RATE).text).toBe("Rp5");
    // 16000 IDR → $1.00; a second conversion would give $0.01.
    expect(formatUserPrice(DisplayCurrency.USD, 16000, RATE).text).toBe("$1.00");
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
});
