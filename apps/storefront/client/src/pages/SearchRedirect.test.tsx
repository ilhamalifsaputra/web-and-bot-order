import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SearchRedirect from "./SearchRedirect";
import { SearchOverlayProvider } from "../components/shop/SearchOverlay";
import { apiGet } from "../api/client";
import type { SearchPageData } from "../api/types";
import type { ProductCardData } from "../components/shop/ProductCard";

vi.mock("../api/client", () => ({ apiGet: vi.fn() }));

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

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderAt(path: string, data: SearchPageData) {
  (apiGet as Mock).mockImplementation(async (p: string) => {
    if (p.startsWith("/api/v1/pages/search")) return data;
    throw new Error(`unexpected apiGet ${p}`);
  });
  Object.defineProperty(window, "localStorage", {
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    configurable: true,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SearchOverlayProvider fx="16000">
          <LocationProbe />
          <Routes>
            <Route path="/" element={<div>home content</div>} />
            <Route path="/search" element={<SearchRedirect />} />
          </Routes>
        </SearchOverlayProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SearchRedirect", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("resolves /search?q=x to / with the overlay open and pre-filled", async () => {
    renderAt("/search?q=netflix", { q: "netflix", products: [product], low_threshold: 5 });

    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/"));
    expect(screen.getByTestId("loc")).not.toHaveTextContent("/search");
    expect(screen.getByText("home content")).toBeInTheDocument();

    const dialog = await screen.findByRole("dialog", { name: "Search" });
    expect(within(dialog).getByRole("combobox")).toHaveValue("netflix");
    expect(await screen.findByRole("option", { name: /Netflix Premium/ })).toBeInTheDocument();
  });

  it("resolves a bare /search (no query) to / with an empty overlay", async () => {
    renderAt("/search", { q: "", products: [], low_threshold: 5 });

    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/"));
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    expect(within(dialog).getByRole("combobox")).toHaveValue("");
  });
});
