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
    expect(alert.className).toContain("text-destructive");
    expect(alert.querySelector("svg")).not.toBeNull();
  });

  it("shows an unreadable policy as a destructive alert too", () => {
    render(<PricingSummary pricing={{ ...base, calculatedPrice: null, warnings: ["unreadable_policy"] }} />);
    expect(screen.getByRole("alert").className).toContain("text-destructive");
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
