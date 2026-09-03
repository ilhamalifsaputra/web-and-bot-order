import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SearchOverlayProvider, useSearchOverlay } from "./SearchOverlay";
import SearchRedirect from "../../pages/SearchRedirect";
import { apiGet } from "../../api/client";
import type { SearchPageData } from "../../api/types";
import type { ProductCardData } from "./ProductCard";
import { RECENT_KEY } from "../../lib/recentSearches";

vi.mock("../../api/client", () => ({ apiGet: vi.fn() }));

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
const product2: ProductCardData = { ...product, slug: "spotify-premium", name: "Spotify Premium" };

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
function installStorage(overrides: Partial<FakeStorage> = {}): void {
  const entries = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (k: string) => (entries.has(k) ? entries.get(k)! : null),
      setItem: (k: string, v: string) => void entries.set(k, v),
      removeItem: (k: string) => void entries.delete(k),
      ...overrides,
    },
    configurable: true,
  });
}

function Trigger() {
  const { open } = useSearchOverlay();
  return (
    <button type="button" onClick={() => open()}>
      Open search
    </button>
  );
}
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderOverlay(data: SearchPageData, initialPath = "/") {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path.startsWith("/api/v1/pages/search")) return data;
    throw new Error(`unexpected apiGet ${path}`);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SearchOverlayProvider fx="16000">
          <LocationProbe />
          <Routes>
            <Route
              path="/"
              element={
                <>
                  <Trigger />
                  <div>home content</div>
                </>
              }
            />
            <Route path="/p/:slug" element={<div>product page</div>} />
            <Route path="/products" element={<div>all products</div>} />
            <Route path="/search" element={<SearchRedirect />} />
          </Routes>
        </SearchOverlayProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const emptyData: SearchPageData = { q: "", products: [], low_threshold: 5 };

describe("SearchOverlay", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    installStorage();
  });

  it("opens from a trigger as a labelled modal dialog", async () => {
    const user = userEvent.setup();
    renderOverlay(emptyData);
    await user.click(screen.getByRole("button", { name: "Open search" }));
    const dialog = screen.getByRole("dialog", { name: "Search" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("combobox")).toHaveFocus();
  });

  it("debounces a fetch on the existing endpoint and renders result rows (no ?sort=)", async () => {
    const user = userEvent.setup();
    renderOverlay({ q: "netflix", products: [product], low_threshold: 5 });
    await user.click(screen.getByRole("button", { name: "Open search" }));
    await user.type(screen.getByRole("combobox"), "netflix");

    const option = await screen.findByRole("option", { name: /Netflix Premium/ });
    expect(option).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith("/api/v1/pages/search?q=netflix");
    expect(apiGet).not.toHaveBeenCalledWith(expect.stringContaining("sort="));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("navigates to /p/:slug when a result is chosen, and closes", async () => {
    const user = userEvent.setup();
    renderOverlay({ q: "netflix", products: [product], low_threshold: 5 });
    await user.click(screen.getByRole("button", { name: "Open search" }));
    await user.type(screen.getByRole("combobox"), "netflix");
    await user.click(await screen.findByRole("option", { name: /Netflix Premium/ }));

    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/p/netflix-premium"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("moves the active option with the arrow keys and opens it on Enter", async () => {
    const user = userEvent.setup();
    renderOverlay({ q: "p", products: [product, product2], low_threshold: 5 });
    await user.click(screen.getByRole("button", { name: "Open search" }));
    const combobox = screen.getByRole("combobox");
    await user.type(combobox, "p");
    await screen.findByRole("option", { name: /Netflix Premium/ });

    await user.keyboard("{ArrowDown}");
    const first = screen.getByRole("option", { name: /Netflix Premium/ });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(combobox).toHaveAttribute("aria-activedescendant", first.id);

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /Spotify Premium/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/p/spotify-premium"));
  });

  it("closes on Esc and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    renderOverlay(emptyData);
    const trigger = screen.getByRole("button", { name: "Open search" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("keeps the overlay open on Enter with nothing highlighted, and remembers the term", async () => {
    const user = userEvent.setup();
    renderOverlay({ q: "netflix", products: [product], low_threshold: 5 });
    await user.click(screen.getByRole("button", { name: "Open search" }));
    const combobox = screen.getByRole("combobox");
    await user.type(combobox, "netflix");
    await screen.findByRole("option", { name: /Netflix Premium/ });

    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(RECENT_KEY)!)).toEqual(["netflix"]);
  });

  it("shows recent searches when idle, re-runs one on click, and clears them", async () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["spotify", "netflix"]));
    const user = userEvent.setup();
    renderOverlay({ q: "spotify", products: [product2], low_threshold: 5 });
    await user.click(screen.getByRole("button", { name: "Open search" }));

    expect(screen.getByText("Recent searches")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "spotify" }));
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith("/api/v1/pages/search?q=spotify"),
    );

    // Back to idle (clear the field, wait out the debounce) to reach Clear.
    await user.clear(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.queryByText("Recent searches")).not.toBeInTheDocument());
    expect(window.localStorage.getItem(RECENT_KEY)).toBeNull();
  });

  it("shows a compact empty state (not the full card) for a no-results query", async () => {
    const user = userEvent.setup();
    renderOverlay({ q: "zzz", products: [], low_threshold: 5 });
    await user.click(screen.getByRole("button", { name: "Open search" }));
    await user.type(screen.getByRole("combobox"), "zzz");

    expect(await screen.findByText(/No results for "zzz"/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse all products" })).toHaveAttribute(
      "href",
      "/products",
    );
  });

  it("still opens when localStorage is unavailable (Safari private mode)", async () => {
    installStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    const user = userEvent.setup();
    renderOverlay(emptyData);
    await user.click(screen.getByRole("button", { name: "Open search" }));
    expect(screen.getByRole("dialog", { name: "Search" })).toBeInTheDocument();
  });
});
