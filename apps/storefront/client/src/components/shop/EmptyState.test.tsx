import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Receipt } from "lucide-react";
import EmptyState from "./EmptyState";

function renderState(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("EmptyState", () => {
  it("shows the title, description and both actions", () => {
    renderState(
      <EmptyState
        icon={Receipt}
        title="No orders yet"
        description="Your purchases will show up here."
        action={{ label: "Browse products", to: "/products" }}
        secondaryAction={{ label: "Home", to: "/" }}
      />,
    );
    expect(screen.getByText("No orders yet")).toBeInTheDocument();
    expect(screen.getByText("Your purchases will show up here.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse products" })).toHaveAttribute("href", "/products");
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  });

  it("renders without actions when there is no next step to offer", () => {
    renderState(<EmptyState icon={Receipt} title="No reviews yet" />);
    expect(screen.getByText("No reviews yet")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  // The icon is decoration beside a heading that already says the same thing —
  // announcing it twice adds noise for a screen-reader user.
  it("hides the decorative icon from assistive technology", () => {
    const { container } = renderState(<EmptyState icon={Receipt} title="Nothing here" />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("uses a real anchor for an external destination", () => {
    renderState(<EmptyState icon={Receipt} title="Gone" action={{ label: "Help", href: "/how-to-order" }} />);
    expect(screen.getByRole("link", { name: "Help" })).toHaveAttribute("href", "/how-to-order");
  });
});
