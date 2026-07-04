import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ProductCard, { type ProductCardData } from "./ProductCard";

const base: ProductCardData = {
  slug: "netflix-premium",
  name: "Netflix Premium",
  category_name: "Streaming",
  from_price: "79000",
  variant_count: 1,
  image: "",
  available: 10,
  rating: 4.6,
  rating_count: 12,
  bulk_discount: null,
  bulk_min_qty: null,
};

describe("ProductCard", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("shows name, category, from-price and rating count", () => {
    render(
      <MemoryRouter>
        <ProductCard p={base} fx="16000" lowThreshold={5} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument();
    expect(screen.getByText("Streaming")).toBeInTheDocument();
    expect(screen.getByText("Rp79.000")).toBeInTheDocument();
    expect(screen.getByText("· 12 reviews")).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
  });

  it("shows the bulk discount badge and hint when present", () => {
    const withBulk: ProductCardData = { ...base, bulk_discount: "15", bulk_min_qty: 3 };
    render(
      <MemoryRouter>
        <ProductCard p={withBulk} fx="16000" lowThreshold={5} />
      </MemoryRouter>,
    );
    expect(screen.getByText("−15%")).toBeInTheDocument();
    expect(screen.getByText("Buy 3+ and save 15%")).toBeInTheDocument();
  });

  it("shows the out-of-stock presentation when available is 0", () => {
    const outOfStock: ProductCardData = { ...base, available: 0 };
    render(
      <MemoryRouter>
        <ProductCard p={outOfStock} fx="16000" lowThreshold={5} />
      </MemoryRouter>,
    );
    const badge = screen.getByText("Out of stock");
    expect(badge).toHaveClass("bg-rust-tint", "text-rust-dark");
  });
});
