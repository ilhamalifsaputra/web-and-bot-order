import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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

/** Mirrors the private constant in SearchPage.tsx — the tests seed and inspect
 *  the stored history directly so they exercise the same key the page uses. */
const RECENT_KEY = "storefront.recent_searches";

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * jsdom under this repo's Vitest config exposes no `window.localStorage` at
 * all — which is itself one of the shapes the page has to survive — so the
 * tests install a minimal in-memory one and can swap in a version that throws
 * to stand in for Safari's private mode.
 */
function installStorage(overrides: Partial<FakeStorage> = {}): void {
  const entries = new Map<string, string>();
  const storage: FakeStorage = {
    getItem: (key) => (entries.has(key) ? entries.get(key)! : null),
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    ...overrides,
  };
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}

describe("SearchPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    installStorage();
  });

  // The heading now carries a result-count badge, so it is matched by prefix
  // rather than by its full accessible name.
  it("echoes the query and renders results, with the result count beside it", async () => {
    renderSearch("/search?q=netflix", { q: "netflix", products: [product], low_threshold: 5 });
    expect(await screen.findByRole("heading", { name: /^Results for "netflix"/ })).toBeInTheDocument();
    // The count badge shows a bare digit but is labelled with the localized
    // phrase, so the heading's accessible name spells the number out.
    expect(screen.getByRole("heading", { name: 'Results for "netflix" 1 results' })).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: /^Results for "netflix"/ })).toBeInTheDocument();
  });

  // A shopper who mistypes on a phone should not have to retype the whole
  // term, so the last few queries are remembered client-side and offered back
  // exactly where they help — the screen that found nothing.
  it("remembers a searched term and offers it back after a later miss", async () => {
    const { unmount } = renderSearch("/search?q=netflix", {
      q: "netflix",
      products: [product],
      low_threshold: 5,
    });
    await screen.findByRole("heading", { name: "Netflix Premium" });
    // A page with results has nothing to recover from, so no history is shown.
    expect(screen.queryByText("Recent searches")).not.toBeInTheDocument();
    unmount();

    renderSearch("/search?q=netflx", { q: "netflx", products: [], low_threshold: 5 });
    expect(await screen.findByText("Recent searches")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "netflix" })).toHaveAttribute("href", "/search?q=netflix");
    // The query that just failed is not offered back as an alternative to itself.
    expect(screen.queryByRole("link", { name: "netflx" })).not.toBeInTheDocument();
  });

  it("offers recent searches for a blank query too", async () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["spotify"]));
    renderSearch("/search", { q: "", products: [], low_threshold: 5 });
    expect(await screen.findByRole("link", { name: "spotify" })).toHaveAttribute(
      "href",
      "/search?q=spotify",
    );
  });

  it("keeps the history capped, most-recent-first and free of duplicates", async () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["alpha", "beta", "gamma", "delta", "epsilon"]));
    renderSearch("/search?q=beta", { q: "beta", products: [], low_threshold: 5 });
    await screen.findByText("Recent searches");

    // "beta" moved to the front instead of being stored twice, which also means
    // nothing was pushed off the end of the five-entry list.
    expect(JSON.parse(window.localStorage.getItem(RECENT_KEY)!)).toEqual([
      "beta",
      "alpha",
      "gamma",
      "delta",
      "epsilon",
    ]);
    // Scoped to the history panel — the empty state below it has links of its own.
    const panel = screen.getByRole("region", { name: "Recent searches" });
    const terms = within(panel).getAllByRole("link").map((el) => el.textContent);
    expect(terms).toEqual(["alpha", "gamma", "delta", "epsilon"]);
  });

  it("drops the oldest entry once a sixth term is searched", async () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["alpha", "beta", "gamma", "delta", "epsilon"]));
    renderSearch("/search?q=zeta", { q: "zeta", products: [], low_threshold: 5 });
    await screen.findByText("Recent searches");
    expect(JSON.parse(window.localStorage.getItem(RECENT_KEY)!)).toEqual([
      "zeta",
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
    expect(screen.queryByRole("link", { name: "epsilon" })).not.toBeInTheDocument();
  });

  it("clears the remembered searches, in the page and in storage", async () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["spotify", "netflix"]));
    renderSearch("/search", { q: "", products: [], low_threshold: 5 });
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.queryByText("Recent searches")).not.toBeInTheDocument());
    expect(window.localStorage.getItem(RECENT_KEY)).toBeNull();
  });

  // Safari in private mode throws on localStorage access. Remembering searches
  // is a convenience; it must never be the reason a search page fails to render.
  it("still renders when localStorage throws on read and on write", async () => {
    installStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    renderSearch("/search?q=netflix", { q: "netflix", products: [], low_threshold: 5 });
    expect(await screen.findByText("Nothing found — try another keyword.")).toBeInTheDocument();
    expect(screen.queryByText("Recent searches")).not.toBeInTheDocument();
  });
});
