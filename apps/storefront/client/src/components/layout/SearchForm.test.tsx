import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../shop/SearchOverlay", () => ({
  useSearchOverlay: () => ({ open: vi.fn(), close: vi.fn(), isOpen: false }),
}));

import SearchForm from "./SearchForm";

describe("SearchForm", () => {
  it("renders the header search pill at a 44px height (h-11, not h-10)", () => {
    render(<SearchForm inputAriaLabel="Search products" />);
    const pill = screen.getByRole("button", { name: "Search products" });
    expect(pill).toHaveClass("h-11");
    expect(pill).not.toHaveClass("h-10");
  });
});
