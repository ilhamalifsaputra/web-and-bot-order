import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import FlashPage from "./FlashPage";
import { apiGet } from "../api/client";
import type { ShelfPageData, ShopContext } from "../api/types";
import type { ProductCardData } from "../components/shop/ProductCard";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
}));

const context: ShopContext = {
  lang: "en",
  fx: "16000",
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 0,
  customer: null,
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  wa_number: null,
  tzname: "Asia/Jakarta",
};

const product: ProductCardData = {
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
  all_non_auto: false,
};

function renderFlash(data: ShelfPageData) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    return data;
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/flash"]}>
        <Routes>
          <Route path="/flash" element={<FlashPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("FlashPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders the flash heading, a breadcrumb and the 5-up product grid", async () => {
    const second = { ...product, slug: "spotify-premium", name: "Spotify Premium" };
    renderFlash({ products: [product, second], low_threshold: 5 });
    expect(await screen.findByRole("heading", { name: "Flash sale" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(nav).toHaveTextContent("Flash sale");
    const grid = screen.getByRole("heading", { name: "Netflix Premium" }).closest(".grid");
    expect(grid?.className).toMatch(/xl:grid-cols-5/);
  });

  it("renders the empty state when no sale is running", async () => {
    renderFlash({ products: [], low_threshold: 5 });
    expect(
      await screen.findByText("No flash sale is running right now — check back soon."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse products" })).toHaveAttribute("href", "/products");
  });

  it("shows a loading skeleton before data arrives", async () => {
    let resolveData!: (value: unknown) => void;
    (apiGet as Mock).mockImplementation(async (path: string) => {
      if (path === "/api/v1/pages/context") return context;
      return new Promise((resolve) => {
        resolveData = resolve;
      });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/flash"]}>
          <Routes>
            <Route path="/flash" element={<FlashPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByLabelText("Loading…")).toBeInTheDocument();
    resolveData({ products: [product], low_threshold: 5 });
    expect(await screen.findByRole("heading", { name: "Flash sale" })).toBeInTheDocument();
  });
});
