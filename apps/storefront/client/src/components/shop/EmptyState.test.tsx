import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Receipt } from "lucide-react";
import EmptyState from "./EmptyState";
import type { ProductCardData } from "./ProductCard";

function renderState(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function product(slug: string): ProductCardData {
  return {
    slug,
    name: `Product ${slug}`,
    category_name: "Streaming",
    from_price: "10000",
    variant_count: 1,
    image: "",
    available: 5,
    rating: null,
    rating_count: 0,
    bulk_discount: null,
    bulk_min_qty: null,
    all_non_auto: false,
  };
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

  // Task 10 (E4): the optional "you might like" shelf, for the pages where
  // shopping is genuinely the next step.
  describe("suggestions shelf", () => {
    it("renders no shelf when suggestions is omitted", () => {
      renderState(<EmptyState icon={Receipt} title="No orders yet" />);
      expect(screen.queryByText("You might also like")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Product / })).not.toBeInTheDocument();
    });

    it("renders no shelf when suggestions carries an empty product list", () => {
      renderState(
        <EmptyState
          icon={Receipt}
          title="No orders yet"
          suggestions={{ products: [], fx: null, lowThreshold: 5 }}
        />,
      );
      expect(screen.queryByText("You might also like")).not.toBeInTheDocument();
    });

    it("renders a heading and a product card per suggestion", () => {
      renderState(
        <EmptyState
          icon={Receipt}
          title="No orders yet"
          suggestions={{ products: [product("a"), product("b")], fx: null, lowThreshold: 5 }}
        />,
      );
      expect(screen.getByText("You might also like")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Product a/ })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Product b/ })).toBeInTheDocument();
    });

    it("caps the shelf at 4 products even when more are passed in", () => {
      const products = ["a", "b", "c", "d", "e", "f"].map(product);
      renderState(
        <EmptyState icon={Receipt} title="No orders yet" suggestions={{ products, fx: null, lowThreshold: 5 }} />,
      );
      expect(screen.getAllByRole("link", { name: /Product /, exact: false })).toHaveLength(4);
    });

    it("renders the shelf under a `bare` empty state too, without the card's action links being disturbed", () => {
      renderState(
        <EmptyState
          icon={Receipt}
          title="No orders yet"
          bare
          action={{ label: "Browse products", to: "/products" }}
          suggestions={{ products: [product("a")], fx: null, lowThreshold: 5 }}
        />,
      );
      expect(screen.getByText("You might also like")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Browse products" })).toHaveAttribute("href", "/products");
      expect(screen.getByRole("link", { name: /Product a/ })).toBeInTheDocument();
    });
  });
});
