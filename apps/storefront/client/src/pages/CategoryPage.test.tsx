import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
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
