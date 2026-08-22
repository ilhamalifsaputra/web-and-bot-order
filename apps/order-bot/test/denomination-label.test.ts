import "./setup-env"; // FIRST import — sets env before @app/* load
import { describe, it, expect } from "vitest";
import { formatDenominationLabel } from "../src/util/denominationLabel";

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
