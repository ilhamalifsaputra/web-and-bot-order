import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import Badge from "./Badge";

describe("Badge", () => {
  it("discount → soft grass tint, 6px radius, bold, 10px label", () => {
    render(<Badge variant="discount">15% OFF</Badge>);
    expect(screen.getByText("15% OFF")).toHaveClass(
      "bg-grass-tint",
      "text-grass-dark",
      "rounded-md",
      "font-bold",
      "text-2xs",
    );
  });

  it("savings uses the same soft grass pairing as discount", () => {
    render(<Badge variant="savings">Hemat Rp150</Badge>);
    expect(screen.getByText("Hemat Rp150")).toHaveClass(
      "bg-grass-tint",
      "text-grass-dark",
      "text-2xs",
    );
  });

  it("category → lowercase pine pill", () => {
    render(<Badge variant="category">TopUp</Badge>);
    expect(screen.getByText("TopUp")).toHaveClass(
      "lowercase",
      "rounded-full",
      "bg-pine-tint",
      "text-pine-dark",
    );
  });

  it.each([
    ["neutral", ["chip", "bg-sand", "text-ink-soft"]],
    ["success", ["chip", "bg-grass-tint", "text-grass-dark"]],
    ["pending", ["chip", "bg-amberx-tint", "text-amberx"]],
    ["failed", ["chip", "bg-rust-tint", "text-rust-dark"]],
  ] as const)("status variant %s composes .chip + the right tone", (variant, classes) => {
    render(<Badge variant={variant}>{variant}</Badge>);
    expect(screen.getByText(variant)).toHaveClass(...classes);
  });

  it("renders the icon slot before the text and forwards ref", () => {
    const ref = createRef<HTMLSpanElement>();
    render(
      <Badge ref={ref} variant="hot" icon={<svg data-testid="flame" />}>
        Hot
      </Badge>,
    );
    expect(ref.current).toBeInstanceOf(HTMLSpanElement);
    expect(screen.getByTestId("flame")).toBeInTheDocument();
    expect(screen.getByText("Hot")).toHaveClass("text-ink-soft");
  });

  it("defaults to the neutral variant", () => {
    render(<Badge>plain</Badge>);
    expect(screen.getByText("plain")).toHaveClass("chip", "bg-sand");
  });
});
