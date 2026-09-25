import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductRatingsCard, type ProductRatingSummary } from "./ProductRatingsCard";

// Two different denominations can legitimately share a display name (e.g.
// two different parent products both offering a "1 Month" tier) —
// `productName` is not `@unique` in the schema, only `productId`/`slug` are.
// Regression coverage for the duplicate-React-key bug: keying by
// `productName` collapsed/misrendered rows for same-named products; keying
// by `productId` (added to this component's local interface) must not.
const DUPLICATE_NAME_SUMMARIES: ProductRatingSummary[] = [
  { productId: 1, productName: "1 Month", count: 10, hiddenCount: 0, avg: 4.5 },
  { productId: 2, productName: "1 Month", count: 7, hiddenCount: 0, avg: 3.8 },
];

beforeEach(() => {
  // Radix Select uses pointer-capture APIs jsdom doesn't implement.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("ProductRatingsCard", () => {
  it("renders one row per product even when productName is duplicated across products, without a React duplicate-key warning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<ProductRatingsCard summaries={DUPLICATE_NAME_SUMMARIES} />);

    const rows = screen.getAllByText("1 Month");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("4.5 · 10")).toBeInTheDocument();
    expect(screen.getByText("3.8 · 7")).toBeInTheDocument();

    const duplicateKeyWarning = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes("Encountered two children with the same key"),
    );
    expect(duplicateKeyWarning).toBe(false);

    errorSpy.mockRestore();
  });

  it("Highest Rated does not let a thin sample (1 review) outrank a large one with a lower-but-real average", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const summaries: ProductRatingSummary[] = [
      { productId: 1, productName: "Fluke Five-Star", count: 1, hiddenCount: 0, avg: 5 },
      { productId: 2, productName: "Proven Favorite", count: 200, hiddenCount: 0, avg: 4.8 },
    ];
    render(<ProductRatingsCard summaries={summaries} />);

    await user.click(screen.getByRole("combobox", { name: /sort product ratings/i }));
    await user.click(await screen.findByRole("option", { name: "Highest Rated" }));

    const rows = screen.getAllByText(/Fluke Five-Star|Proven Favorite/);
    expect(rows[0]).toHaveTextContent("Proven Favorite"); // real sample ranks first
    expect(rows[1]).toHaveTextContent("Fluke Five-Star"); // thin sample sorts last despite the higher average

    expect(screen.getByText(/ranked among products with 3\+ reviews/i)).toBeInTheDocument();
  });

  it("Lowest Rated applies the same minimum-sample rule", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const summaries: ProductRatingSummary[] = [
      { productId: 1, productName: "Fluke One-Star", count: 1, hiddenCount: 0, avg: 1 },
      { productId: 2, productName: "Consistently Mediocre", count: 50, hiddenCount: 0, avg: 3 },
    ];
    render(<ProductRatingsCard summaries={summaries} />);

    await user.click(screen.getByRole("combobox", { name: /sort product ratings/i }));
    await user.click(await screen.findByRole("option", { name: "Lowest Rated" }));

    const rows = screen.getAllByText(/Fluke One-Star|Consistently Mediocre/);
    expect(rows[0]).toHaveTextContent("Consistently Mediocre");
    expect(rows[1]).toHaveTextContent("Fluke One-Star");
  });

  it("shows no ranking-rule subtitle for the default Most Reviewed sort", () => {
    render(<ProductRatingsCard summaries={DUPLICATE_NAME_SUMMARIES} />);
    expect(screen.queryByText(/ranked among products with/i)).not.toBeInTheDocument();
  });
});
