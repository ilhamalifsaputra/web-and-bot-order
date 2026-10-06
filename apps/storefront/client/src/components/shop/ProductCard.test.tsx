import "@testing-library/jest-dom";
import type { ReactElement } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProductCard, { type ProductCardData } from "./ProductCard";
import { apiGet } from "../../api/client";

// ProductCard renders <Price/>, which (Task 5) reads the display-currency
// preference off the shared ["context"] query itself — every render here
// needs the same QueryClientProvider wrapper the page tests already use.
// No currency-specific assertion in this file, so a single static mock
// (undefined ctx while the query is pending, same as a real cold mount) is
// enough for the null-currency default every existing assertion expects.
vi.mock("../../api/client", () => ({
  apiGet: vi.fn(),
}));

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderCard(ui: ReactElement) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const base: ProductCardData = {
  slug: "netflix-premium",
  name: "Netflix Premium",
  category_name: "Streaming",
  from_price: "79000",
  variant_count: 1,
  image: null,
  available: 10,
  rating: 4.6,
  rating_count: 12,
  bulk_discount: null,
  bulk_min_qty: null,
  all_non_auto: false,
};

describe("ProductCard", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ currency: null, fx: null });
  });

  it("shows name, category, from-price and rating count", () => {
    renderCard(
      <ProductCard p={base} fx="16000" lowThreshold={5} />,
    );
    expect(screen.getByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument();
    expect(screen.getByText("Streaming")).toBeInTheDocument();
    expect(screen.getByText("Rp79,000")).toBeInTheDocument();
    expect(screen.getByText("· 12 reviews")).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
  });

  it("says '1 review' (singular) for a single review", () => {
    renderCard(
      <ProductCard p={{ ...base, rating_count: 1 }} fx="16000" lowThreshold={5} />,
    );
    expect(screen.getByText("· 1 review")).toBeInTheDocument();
    expect(screen.queryByText("· 1 reviews")).not.toBeInTheDocument();
  });

  it("shows the bulk discount badge and hint when present", () => {
    const withBulk: ProductCardData = { ...base, bulk_discount: "15", bulk_min_qty: 3 };
    renderCard(
      <ProductCard p={withBulk} fx="16000" lowThreshold={5} />,
    );
    expect(screen.getByText("−15%")).toBeInTheDocument();
    expect(screen.getByText("Buy 3+ and save 15%")).toBeInTheDocument();
  });

  it("shows the out-of-stock presentation when available is 0", () => {
    const outOfStock: ProductCardData = { ...base, available: 0 };
    renderCard(
      <ProductCard p={outOfStock} fx="16000" lowThreshold={5} />,
    );
    const badge = screen.getByText("Out of stock");
    expect(badge).toHaveClass("bg-rust-tint", "text-rust-dark");
  });

  it("does not show out-of-stock when every denomination is non-auto delivery (STO-001)", () => {
    const manualDelivery: ProductCardData = { ...base, available: 0, all_non_auto: true };
    renderCard(
      <ProductCard p={manualDelivery} fx="16000" lowThreshold={5} />,
    );
    expect(screen.queryByText("Out of stock")).not.toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
  });

  it("uses the design-system card elevation: shadow-soft resting, shadow-lift on hover", () => {
    renderCard(
      <ProductCard p={base} fx="16000" lowThreshold={5} />,
    );
    const card = screen.getByRole("link");
    expect(card).toHaveClass("shadow-soft");
    expect(card.className).toContain("hover:shadow-lift");
    expect(card.className).not.toContain("shadow-xs");
    expect(card.className).not.toContain("hover:shadow-md");
  });

  // task-23: the badge sits over the image well, which since Fase 12 can be
  // the light DefaultThumb placeholder — bg-black/40 + text-grass fell to
  // ~2.3:1 there and failed WCAG AA. It's now an opaque grass chip (solid
  // background + white text, ~5:1), still the grass family, never amber.
  // task-24: the chip is also gated on !all_non_auto (dedicated test below);
  // `base` has all_non_auto:false so the chip still renders here.
  it("gives the instant chip an opaque, legible grass background (not bg-black/40 + text-grass) and no amber", () => {
    renderCard(
      <ProductCard p={base} fx="16000" lowThreshold={5} />,
    );
    const chip = screen.getByText("Instant delivery");
    expect(chip).toHaveClass("bg-grass-dark", "text-white");
    expect(chip.className).not.toContain("bg-black/40");
    expect(chip.className).not.toMatch(/amber/);
  });

  // task-24: a fully manual-delivery product (all_non_auto) delivers nothing
  // instantly, so the solid-green "Instant delivery" pill would be false
  // advertising — it must not render for those.
  it("uses tighter body padding on phones and lets the body shrink", () => {
    const { container } = renderCard(<ProductCard p={base} fx="16000" lowThreshold={5} />);
    const body = container.querySelector("h3")?.parentElement;
    expect(body).toHaveClass("p-3", "sm:p-4", "min-w-0");
  });

  it("keeps the instant chip off the top-left badge column so they cannot overlap", () => {
    renderCard(
      <ProductCard p={{ ...base, bulk_discount: "10", bulk_min_qty: 5, flash_discount: "20" }} fx="16000" lowThreshold={5} />,
    );
    const chip = screen.getByText("Instant delivery");
    expect(chip).toHaveClass("bottom-2", "right-2");
    expect(chip).not.toHaveClass("top-3");
  });

  it("shows the instant chip for an auto-delivery product (all_non_auto false)", () => {
    renderCard(
      <ProductCard p={base} fx="16000" lowThreshold={5} />,
    );
    expect(screen.getByText("Instant delivery")).toBeInTheDocument();
  });

  it("hides the instant chip when every denomination is manual delivery (all_non_auto)", () => {
    renderCard(
      <ProductCard p={{ ...base, all_non_auto: true }} fx="16000" lowThreshold={5} />,
    );
    expect(screen.queryByText("Instant delivery")).not.toBeInTheDocument();
  });

  // Instant delivery is only true while there is something to deliver: an
  // auto-delivery product with no available stock is out of stock, not instant.
  it("hides the instant chip when an auto-delivery product has no available stock", () => {
    renderCard(
      <ProductCard p={{ ...base, available: 0, all_non_auto: false }} fx="16000" lowThreshold={5} />,
    );
    expect(screen.queryByText("Instant delivery")).not.toBeInTheDocument();
    expect(screen.getByText("Out of stock")).toBeInTheDocument();
  });

  it("shows the instant chip for an auto-delivery product with exactly one unit available", () => {
    renderCard(
      <ProductCard p={{ ...base, available: 1, all_non_auto: false }} fx="16000" lowThreshold={5} />,
    );
    expect(screen.getByText("Instant delivery")).toBeInTheDocument();
  });

  it("keeps the instant chip hidden for a manual-delivery product even when its stock figure is positive", () => {
    renderCard(
      <ProductCard p={{ ...base, available: 10, all_non_auto: true }} fx="16000" lowThreshold={5} />,
    );
    expect(screen.queryByText("Instant delivery")).not.toBeInTheDocument();
  });

  it("renders whole-number ratings without trailing .0", () => {
    const wholeRating: ProductCardData = { ...base, rating: 5, rating_count: 1 };
    renderCard(
      <ProductCard p={wholeRating} fx="16000" lowThreshold={5} />,
    );
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.queryByText("5.0")).not.toBeInTheDocument();
  });

  // Fase 12: the old hardcoded Unsplash-fallback gradient is gone — a
  // photo-less card now renders the DefaultThumb design-system placeholder,
  // keyed by the server-resolved `image_kind`, with no <img>/<picture> at all.
  describe("image fallback (DefaultThumb)", () => {
    it("renders DefaultThumb (no <img>/<picture>) when image is null", () => {
      const { container } = renderCard(
        <ProductCard p={{ ...base, image: null, image_kind: "entertainment" }} fx="16000" lowThreshold={5} />,
      );
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("picture")).toBeNull();
      expect(container.querySelector(".lucide-clapperboard")).toBeInTheDocument();
    });

    it("defaults to the generic icon when image_kind is absent", () => {
      const { container } = renderCard(
        <ProductCard p={{ ...base, image: null, image_kind: undefined }} fx="16000" lowThreshold={5} />,
      );
      expect(container.querySelector(".lucide-package")).toBeInTheDocument();
    });

    it("renders the real <picture>/<img>, not DefaultThumb, when image is set", () => {
      const withImage: ProductCardData = {
        ...base,
        image: "/uploads/products/netflix.jpg",
        image_kind: "entertainment",
      };
      const { container } = renderCard(
        <ProductCard p={withImage} fx="16000" lowThreshold={5} />,
      );
      const img = screen.getByAltText("Netflix Premium");
      expect(img).toHaveAttribute("src", "/uploads/products/netflix.jpg");
      expect(container.querySelector(".lucide-clapperboard")).toBeNull();
    });
  });
});
