import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SortSelect from "./SortSelect";
import { parseSortKey } from "../../api/types";

describe("SortSelect", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("offers bestseller, newest and cheapest when cheapest is allowed", () => {
    render(<SortSelect value="bestseller" allowCheapest onChange={() => {}} />);
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["Bestseller", "Newest", "Price: low to high"]);
    expect(screen.getByLabelText("Sort")).toHaveValue("bestseller");
  });

  it("hides cheapest when the page does not offer it", () => {
    render(<SortSelect value="bestseller" allowCheapest={false} onChange={() => {}} />);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Bestseller", "Newest"]);
  });

  it("reports the chosen key", () => {
    const onChange = vi.fn();
    render(<SortSelect value="bestseller" allowCheapest onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "newest" } });
    expect(onChange).toHaveBeenCalledWith("newest");
  });
});

describe("parseSortKey", () => {
  it("falls back to bestseller for legacy, unknown and missing values", () => {
    for (const raw of ["default", "rating", "bogus", "", null, undefined]) {
      expect(parseSortKey(raw, { allowCheapest: true })).toBe("bestseller");
    }
  });

  it("keeps newest, and cheapest only where it is allowed", () => {
    expect(parseSortKey("newest", { allowCheapest: false })).toBe("newest");
    expect(parseSortKey("cheapest", { allowCheapest: true })).toBe("cheapest");
    expect(parseSortKey("cheapest", { allowCheapest: false })).toBe("bestseller");
  });
});
