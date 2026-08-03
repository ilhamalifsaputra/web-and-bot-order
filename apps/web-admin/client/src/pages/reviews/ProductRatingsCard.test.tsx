import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
