import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Receipt } from "lucide-react";
import NotFoundState from "./NotFoundState";
import EmptyState from "./EmptyState";

function renderS(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("NotFoundState", () => {
  it("shows a 'not found' title distinct from EmptyState's copy", () => {
    const { unmount } = renderS(<NotFoundState />);
    expect(screen.getByText("Page not found")).toBeInTheDocument();
    expect(screen.getByText(/couldn't find the page/i)).toBeInTheDocument();
    unmount();

    renderS(<EmptyState icon={Receipt} title="No orders yet" />);
    expect(screen.queryByText("Page not found")).not.toBeInTheDocument();
  });

  it("defaults its action to a link home", () => {
    renderS(<NotFoundState />);
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
  });

  it("accepts an override action and copy", () => {
    renderS(
      <NotFoundState
        title="Product not found"
        description="This item may have been delisted."
        action={{ label: "Browse catalog", to: "/products" }}
      />,
    );
    expect(screen.getByText("Product not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse catalog" })).toHaveAttribute("href", "/products");
  });
});
