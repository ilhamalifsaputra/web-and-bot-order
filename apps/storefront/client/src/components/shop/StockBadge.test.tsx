import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import StockBadge from "./StockBadge";

describe("StockBadge", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("renders the in-stock state above the low threshold", () => {
    render(<StockBadge available={10} lowThreshold={5} />);
    const badge = screen.getByText("Available");
    expect(badge).toHaveClass("bg-grass-tint", "text-grass-dark");
  });

  it("renders the low-stock state with the remaining count", () => {
    render(<StockBadge available={3} lowThreshold={5} />);
    const badge = screen.getByText("3 left");
    expect(badge).toHaveClass("bg-amberx-tint", "text-amberx");
  });

  it("renders the out-of-stock state at zero", () => {
    render(<StockBadge available={0} lowThreshold={5} />);
    const badge = screen.getByText("Out of stock");
    expect(badge).toHaveClass("bg-rust-tint", "text-rust-dark");
  });

  it("renders available (never out-of-stock) when every denomination is non-auto delivery (STO-001)", () => {
    render(<StockBadge available={0} lowThreshold={5} allNonAuto />);
    expect(screen.queryByText("Out of stock")).not.toBeInTheDocument();
    const badge = screen.getByText("Available");
    expect(badge).toHaveClass("bg-grass-tint", "text-grass-dark");
  });
});
