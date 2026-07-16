import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CategoryPage from "./CategoryPage";
import { apiGet } from "../api/client";
import type { CategoryPageData, ShopContext } from "../api/types";
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

const categoryData: CategoryPageData = {
  category: { id: 1, name: "Streaming", slug: "streaming", emoji: "🎬", description: null, image: null, sortOrder: 0, isActive: true },
  categories: [
    { id: 1, name: "Streaming", slug: "streaming", emoji: "🎬", description: null, image: null, sortOrder: 0, isActive: true },
    { id: 2, name: "Gaming", slug: "gaming", emoji: "🎮", description: null, image: null, sortOrder: 1, isActive: true },
  ],
  products: [product],
  low_threshold: 5,
};

function renderCategory(slug: string, respond: (path: string) => unknown) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    return respond(path);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/c/${slug}`]}>
        <Routes>
          <Route path="/c/:slug" element={<CategoryPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CategoryPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders the category name and products, highlighting the active pill", async () => {
    renderCategory("streaming", () => categoryData);
    expect(await screen.findByRole("heading", { name: "🎬 Streaming" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument();
    const activePill = screen.getByRole("link", { name: "🎬 Streaming" });
    expect(activePill).toHaveClass("bg-pine", "text-white");
    const otherPill = screen.getByRole("link", { name: "🎮 Gaming" });
    expect(otherPill).toHaveClass("bg-sand", "text-ink-soft");
  });

  it("renders the empty state when the category has no products", async () => {
    renderCategory("streaming", () => ({ ...categoryData, products: [] }));
    expect(await screen.findByText("No products yet — check back soon.")).toBeInTheDocument();
  });

  // STO-018: a single product in a grid-cols-2/3/4 grid used to leave the
  // row visually broken — clamp to a capped-width single column instead.
  it("clamps the product grid to one column when there's only one product", async () => {
    renderCategory("streaming", () => categoryData);
    const grid = (await screen.findByRole("heading", { name: "Netflix Premium" })).closest(".grid");
    expect(grid?.className).toContain("max-w-xs");
    expect(grid?.className).not.toMatch(/grid-cols-2|grid-cols-3|grid-cols-4/);
  });

  it("keeps the multi-column grid when there's more than one product", async () => {
    const second = { ...product, slug: "spotify-premium", name: "Spotify Premium" };
    renderCategory("streaming", () => ({ ...categoryData, products: [product, second] }));
    const grid = (await screen.findByRole("heading", { name: "Netflix Premium" })).closest(".grid");
    expect(grid?.className).toMatch(/grid-cols-2/);
  });

  // STO-007: picking a sort re-fetches with ?sort= in the URL instead of
  // re-ordering client-side (the server owns rating/price computation).
  it("offers a sort dropdown once there's more than one product, and re-fetches on change", async () => {
    const second = { ...product, slug: "spotify-premium", name: "Spotify Premium" };
    renderCategory("streaming", () => ({ ...categoryData, products: [product, second] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(apiGet).toHaveBeenCalledWith("/api/v1/pages/category/streaming?sort=default");
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "cheapest" } });
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith("/api/v1/pages/category/streaming?sort=cheapest"),
    );
  });

  it("omits the sort dropdown when there's only one product", async () => {
    renderCategory("streaming", () => categoryData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByLabelText("Sort")).not.toBeInTheDocument();
  });

  // STO-006/performance.md: rendering nothing while the query is pending
  // reads as a blank/broken page — a skeleton signals "loading" instead.
  it("shows a loading skeleton before data arrives", async () => {
    let resolveData!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveData = resolve;
    });
    renderCategory("streaming", () => pending);
    expect(await screen.findByLabelText("Loading…")).toBeInTheDocument();
    resolveData(categoryData);
    expect(await screen.findByRole("heading", { name: "🎬 Streaming" })).toBeInTheDocument();
  });

  it("renders the ErrorPage copy on a 404", async () => {
    renderCategory("does-not-exist", () => {
      const err = new Error("not_found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    expect(await screen.findByText("404")).toBeInTheDocument();
    expect(screen.getByText("That page doesn't exist.")).toBeInTheDocument();
  });
});
