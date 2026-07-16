import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SearchPage from "./SearchPage";
import { apiGet } from "../api/client";
import type { SearchPageData, ShopContext } from "../api/types";
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

function renderSearch(entry: string, data: SearchPageData) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    return data;
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/search" element={<SearchPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SearchPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("echoes the query and renders results", async () => {
    renderSearch("/search?q=netflix", { q: "netflix", products: [product], low_threshold: 5 });
    expect(await screen.findByRole("heading", { name: 'Results for "netflix"' })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument();
  });

  it("shows the search-empty copy and a back-home link when there are no results", async () => {
    renderSearch("/search?q=nothing-like-this", { q: "nothing-like-this", products: [], low_threshold: 5 });
    expect(await screen.findByText("Nothing found — try another keyword.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
  });

  it("shows the same search-empty copy for a blank query (NJK uses one conditional for both)", async () => {
    renderSearch("/search", { q: "", products: [], low_threshold: 5 });
    expect(await screen.findByText("Nothing found — try another keyword.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: 'Results for ""' })).toBeInTheDocument();
  });

  // STO-007: picking a sort re-fetches with ?sort= in the URL (and keeps q=)
  // instead of re-ordering client-side.
  it("offers a sort dropdown once there's more than one result, and re-fetches with q+sort on change", async () => {
    const second = { ...product, slug: "spotify-premium", name: "Spotify Premium" };
    renderSearch("/search?q=netflix", { q: "netflix", products: [product, second], low_threshold: 5 });
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(apiGet).toHaveBeenCalledWith("/api/v1/pages/search?q=netflix&sort=default");
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "rating" } });
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith("/api/v1/pages/search?q=netflix&sort=rating"),
    );
  });

  it("omits the sort dropdown when there's only one result", async () => {
    renderSearch("/search?q=netflix", { q: "netflix", products: [product], low_threshold: 5 });
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByLabelText("Sort")).not.toBeInTheDocument();
  });

  // STO-006/performance.md: rendering nothing while the query is pending
  // reads as a blank/broken page — a skeleton signals "loading" instead.
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
        <MemoryRouter initialEntries={["/search?q=netflix"]}>
          <Routes>
            <Route path="/search" element={<SearchPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByLabelText("Loading…")).toBeInTheDocument();
    resolveData({ q: "netflix", products: [product], low_threshold: 5 });
    expect(await screen.findByRole("heading", { name: 'Results for "netflix"' })).toBeInTheDocument();
  });
});
