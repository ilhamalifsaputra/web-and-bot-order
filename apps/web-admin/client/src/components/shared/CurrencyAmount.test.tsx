import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { formatCurrencyDisplay, formatCurrencyParts, CurrencyStack } from "./CurrencyAmount";

describe("formatCurrencyDisplay", () => {
  it("formats IDR with a Rp prefix and dotted thousands, no decimals", () => {
    expect(formatCurrencyDisplay("1250000", "IDR")).toBe("Rp1.250.000");
  });

  it("formats USD with 2 decimals and a currency suffix", () => {
    expect(formatCurrencyDisplay("5", "USD")).toBe("5.00 USD");
  });

  it("formats USDT up to 4dp, stripping trailing zeros, with a currency suffix", () => {
    expect(formatCurrencyDisplay("20.25", "USDT")).toBe("20.25 USDT");
    expect(formatCurrencyDisplay("20.0000", "USDT")).toBe("20 USDT");
    expect(formatCurrencyDisplay("0", "USDT")).toBe("0 USDT");
    expect(formatCurrencyDisplay("123.456789", "USDT")).toBe("123.4568 USDT");
  });
});

describe("formatCurrencyParts", () => {
  it("returns the full Rp-prefixed amount with no suffix for IDR", () => {
    expect(formatCurrencyParts("1250000", "IDR")).toEqual({ amount: "Rp1.250.000", suffix: "" });
  });

  it("splits the amount from a USDT suffix", () => {
    expect(formatCurrencyParts("20.25", "USDT")).toEqual({ amount: "20.25", suffix: "USDT" });
  });

  it("splits the amount from a USD suffix", () => {
    expect(formatCurrencyParts("5", "USD")).toEqual({ amount: "5.00", suffix: "USD" });
  });
});

describe("CurrencyStack", () => {
  it("renders each currency on its own line, never concatenated into one string", () => {
    render(
      <CurrencyStack
        amounts={[
          { currency: "IDR", value: "137" },
          { currency: "USDT", value: "20.25" },
        ]}
      />,
    );
    expect(screen.getByText("Rp137")).toBeInTheDocument();
    expect(screen.getByText("20.25 USDT")).toBeInTheDocument();
    // The exact reported bug shape — must never appear as one joined string.
    expect(screen.queryByText(/Rp137.*\+.*20\.25/)).not.toBeInTheDocument();
  });

  it("renders a single currency with no extra row", () => {
    render(<CurrencyStack amounts={[{ currency: "IDR", value: "50000" }]} />);
    expect(screen.getByText("Rp50.000")).toBeInTheDocument();
    expect(screen.queryByText(/USDT|USD/)).not.toBeInTheDocument();
  });
});
