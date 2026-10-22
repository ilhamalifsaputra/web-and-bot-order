import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PricingMargin, PricingSourceBadge, PricingSummary, type CatalogPricingInfo } from "./PricingSummary";

const base: CatalogPricingInfo = {
  automaticAvailable: true, automaticPricing: true, source: "global_default", calculatedPrice: "11500", effectivePrice: "11500",
  costPrice: "10000", grossProfit: "1500", grossMarginPct: "13.04", warnings: [], pendingReprice: false,
};

describe("PricingSummary warnings (visual review V1)", () => {
  it("shows below-cost as a destructive alert with a title, not neutral text", () => {
    render(<PricingSummary pricing={{ ...base, effectivePrice: "9000", grossMarginPct: "-11.11", grossProfit: "-1000", warnings: ["below_cost"] }} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Di bawah HPP");
    expect(alert.className).toContain("text-rust-dark");
    expect(alert.querySelector("svg")).not.toBeNull();
  });

  it("shows an unreadable policy as a destructive alert too", () => {
    render(<PricingSummary pricing={{ ...base, calculatedPrice: null, warnings: ["unreadable_policy"] }} />);
    expect(screen.getByRole("alert").className).toContain("text-rust-dark");
  });

  it("M1: the error alert is filled with the rust tint and border (stronger than the amber warning), not the plain card", () => {
    render(<PricingSummary pricing={{ ...base, effectivePrice: "9000", grossMarginPct: "-11.11", grossProfit: "-1000", warnings: ["below_cost"] }} />);
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("bg-rust-tint");
    expect(alert.className).toContain("border-rust/40");
    expect(alert.className).not.toMatch(/\bbg-card\b/);
    // I1: rust-dark on rust-tint is 5.47:1 (rust is 4.08:1) — title/icon and description both.
    expect(alert.className).toContain("text-rust-dark");
    expect(alert.className).toContain("*:data-[slot=alert-description]:text-rust-dark");
    expect(alert.className).not.toContain("text-destructive");
  });

  it("(a) below cost hides the redundant low-margin alert", () => {
    render(<PricingSummary pricing={{ ...base, effectivePrice: "9000", grossMarginPct: "-11.11", grossProfit: "-1000", warnings: ["low_margin", "below_cost"] }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Di bawah HPP");
    expect(screen.queryByText("Margin rendah")).not.toBeInTheDocument();
  });

  it("(a) orders errors before warnings whatever the server order", () => {
    render(<PricingSummary pricing={{ ...base, calculatedPrice: null, warnings: ["low_margin", "unreadable_policy"] }} />);
    const error = screen.getByRole("alert");
    const warning = screen.getByRole("status");
    expect(error.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a low margin as a warning-toned alert with its own title and icon", () => {
    render(<PricingSummary pricing={{ ...base, warnings: ["low_margin"] }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Margin rendah");
    expect(status.className).toContain("bg-amberx-tint");
    expect(status.querySelector("svg")).not.toBeNull();
  });
});

describe("pricing source and margin display", () => {
  it("labels a SKU waiting for its first HPP as 'Menunggu HPP', not 'Manual' (V2)", () => {
    render(<PricingSourceBadge pricing={{ ...base, source: "manual_no_cost", costPrice: null, calculatedPrice: null }} />);
    expect(screen.getByText("Menunggu HPP")).toBeInTheDocument();
  });

  it("colours a negative margin and keeps the minus sign", () => {
    render(<PricingMargin pricing={{ ...base, grossMarginPct: "-4.18" }} />);
    const el = screen.getByText("-4.18%");
    expect(el.className).toContain("text-rust");
  });

  it("uses text-sm for the margin inside the summary like its sibling values", () => {
    render(<PricingSummary pricing={base} />);
    expect(screen.getByText("13.04%").className).toContain("text-sm");
  });
});
