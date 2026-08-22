import "./setup-env"; // FIRST import — sets env before @app/* load
import { describe, it, expect } from "vitest";
import { formatDenominationLabel, gameTopUpDenomLabel } from "../src/util/denominationLabel";

describe("formatDenominationLabel", () => {
  it('moves quantity to front: "Bonds 1580" → "1580 Bonds"', () => {
    expect(formatDenominationLabel("Bonds", "Bonds 1580")).toBe("1580 Bonds");
  });

  it('collapses noise: "Arena Breakout Bonds 1580" → "1580 Bonds"', () => {
    expect(formatDenominationLabel("Bonds", "Arena Breakout Bonds 1580")).toBe("1580 Bonds");
  });

  it('preserves multi-word product names: "1 Month" unchanged when product is "Capcut Pro 1 Month"', () => {
    expect(formatDenominationLabel("Capcut Pro 1 Month", "1 Month")).toBe("1 Month");
  });

  it('preserves no-match labels: "1 month preorder" unchanged when product is "Capcut Pro 1 Month"', () => {
    expect(formatDenominationLabel("Capcut Pro 1 Month", "1 month preorder")).toBe("1 month preorder");
  });

  it('appends diamond suffix: "86 Diamonds" → "86 Diamonds 💎"', () => {
    expect(formatDenominationLabel("Diamonds", "86 Diamonds")).toBe("86 Diamonds 💎");
  });

  it('is idempotent on diamond suffix: "86 Diamonds 💎" stays "86 Diamonds 💎"', () => {
    expect(formatDenominationLabel("Diamonds", "86 Diamonds 💎")).toBe("86 Diamonds 💎");
  });

  it('handles empty strings: "" → ""', () => {
    expect(formatDenominationLabel("Bonds", "")).toBe("");
  });
});

describe("gameTopUpDenomLabel", () => {
  it("qtyValue+qtyUnit set → compact label with formatCompactQty/formatCompactPrice", () => {
    const d = { qtyValue: 1580, qtyUnit: "Bonds", durationLabel: "1580 Bonds", name: "1580 Bonds" };
    expect(gameTopUpDenomLabel(d, 79000)).toBe("1.58K Bonds — Rp79K");
  });

  it("small qtyValue stays as-is under formatCompactQty (<1000)", () => {
    const d = { qtyValue: 86, qtyUnit: "Diamonds", durationLabel: "86 Diamonds", name: "86 Diamonds" };
    expect(gameTopUpDenomLabel(d, 25000)).toBe("86 Diamonds — Rp25K");
  });

  it("qtyValue null → falls back to durationLabel||name", () => {
    const d = { qtyValue: null, qtyUnit: null, durationLabel: "1 Month", name: "1 Month Plan" };
    expect(gameTopUpDenomLabel(d, 50000)).toBe("1 Month");
  });

  it("qtyUnit missing (empty string) → falls back to durationLabel||name", () => {
    const d = { qtyValue: 100, qtyUnit: "", durationLabel: "", name: "Fallback Name" };
    expect(gameTopUpDenomLabel(d, 50000)).toBe("Fallback Name");
  });

  it("falls back to name when durationLabel is empty", () => {
    const d = { qtyValue: null, qtyUnit: null, durationLabel: "", name: "Plain Name" };
    expect(gameTopUpDenomLabel(d, 50000)).toBe("Plain Name");
  });

  it("prefixes the compact label with variantEmoji when provided", () => {
    const d = { qtyValue: 1580, qtyUnit: "Bonds", durationLabel: "1580 Bonds", name: "1580 Bonds" };
    expect(gameTopUpDenomLabel(d, 79000, "🔫")).toBe("🔫 1.58K Bonds — Rp79K");
  });

  it("omits the prefix when variantEmoji is null/undefined", () => {
    const d = { qtyValue: 1580, qtyUnit: "Bonds", durationLabel: "1580 Bonds", name: "1580 Bonds" };
    expect(gameTopUpDenomLabel(d, 79000, null)).toBe("1.58K Bonds — Rp79K");
    expect(gameTopUpDenomLabel(d, 79000, undefined)).toBe("1.58K Bonds — Rp79K");
  });
});
