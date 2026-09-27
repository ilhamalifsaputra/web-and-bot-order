import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CategoriesPage from "./CategoriesPage";
import { apiGet } from "../api/client";
import type { CategoriesPageData, ShopContext } from "../api/types";

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
  currency: null,
};

const streaming = {
  id: 1,
  name: "Streaming",
  slug: "streaming",
  emoji: "🎬",
  description: null,
  sortOrder: 0,
  isActive: true,
  image: "",
};

function renderCategories(data: CategoriesPageData) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    if (path === "/api/v1/pages/suggestions") return { products: [], low_threshold: 5 };
    return data;
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/categories"]}>
        <Routes>
          <Route path="/categories" element={<CategoriesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CategoriesPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders the heading, a breadcrumb and a tile per category", async () => {
    renderCategories({ categories: [streaming, { ...streaming, id: 2, name: "Gaming", slug: "gaming", emoji: "🎮" }] });
    expect(await screen.findByRole("heading", { name: "Categories", level: 1 })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(nav).toHaveTextContent("Categories");
    const tile = screen.getByRole("heading", { name: "Streaming", level: 2 }).closest("a");
    expect(tile).toHaveAttribute("href", "/c/streaming");
    // Tile grid stays 3-up — it holds tiles, not product cards, so it is not 5-upped.
    const grid = tile?.closest(".grid");
    expect(grid?.className).toMatch(/lg:grid-cols-3/);
    expect(grid?.className).not.toMatch(/xl:grid-cols-5/);
  });

  it("renders the empty state when there are no categories", async () => {
    renderCategories({ categories: [] });
    expect(await screen.findByText("No categories yet — check back soon.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
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
        <MemoryRouter initialEntries={["/categories"]}>
          <Routes>
            <Route path="/categories" element={<CategoriesPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByLabelText("Loading…")).toBeInTheDocument();
    resolveData({ categories: [streaming] });
    expect(await screen.findByRole("heading", { name: "Categories", level: 1 })).toBeInTheDocument();
  });
});
