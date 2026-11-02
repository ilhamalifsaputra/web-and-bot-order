import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import GroupPage from "./GroupPage";
import { apiGet } from "../api/client";
import type { GroupPageData, ShopContext } from "../api/types";
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
  currency: null,
};

function card(slug: string, name: string, category: string): ProductCardData {
  return {
    slug,
    name,
    category_name: category,
    from_price: "15000",
    variant_count: 3,
    image: null,
    available: 0,
    rating: null,
    rating_count: 0,
    bulk_discount: null,
    bulk_min_qty: null,
    all_non_auto: true,
  };
}

const gamePage: GroupPageData = {
  group: { key: "GAME_TOPUP", slug: "top-up-games", label_key: "web.group_game_topup", emoji: "🎮", allow_cheapest: false },
  unavailable: false,
  categories: [
    { slug: "mobile-legends", name: "Mobile Legends", emoji: "⚔️" },
    { slug: "free-fire", name: "Free Fire", emoji: "🔥" },
  ],
  sort: "bestseller",
  products: [card("ml-diamonds", "Mobile Legends Diamonds", "Mobile Legends"), card("ff-diamonds", "Free Fire Diamonds", "Free Fire")],
  total: 3,
  next_offset: 2,
  ranking_version: 7,
  low_threshold: 5,
};

const premiumPage: GroupPageData = {
  group: { key: "PREMIUM_APPS", slug: "premium-apps", label_key: "web.group_premium_apps", emoji: "💎", allow_cheapest: true },
  unavailable: false,
  categories: [
    { slug: "streaming", name: "Streaming", emoji: "🎬" },
    { slug: "music", name: "Music", emoji: "🎵" },
  ],
  sort: "bestseller",
  products: [card("netflix", "Netflix Premium", "Streaming"), card("spotify", "Spotify Premium", "Music")],
  total: 2,
  next_offset: null,
  ranking_version: 7,
  low_threshold: 5,
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderGroup(slug: string, respond: (path: string) => unknown, search = "") {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    if (path.startsWith("/api/v1/pages/group/")) return respond(path);
    throw new Error(`unexpected path ${path}`);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/g/${slug}${search}`]}>
        <Routes>
          <Route
            path="/g/:slug"
            element={
              <>
                <GroupPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function notFound(): never {
  throw Object.assign(new Error("not found"), { status: 404 });
}

const groupCalls = () => (apiGet as Mock).mock.calls.map((c) => c[0] as string).filter((p) => p.startsWith("/api/v1/pages/group/"));

describe("GroupPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "";
    vi.clearAllMocks();
  });

  it("renders the 404 page for an unknown group slug", async () => {
    renderGroup("no-such-group", notFound);
    expect(await screen.findByText("404")).toBeInTheDocument();
  });

  it("says the service is unavailable and links home when the group's web service is off", async () => {
    renderGroup("top-up-games", () => ({ ...gamePage, unavailable: true, categories: [], products: [], total: 0, next_offset: null }));
    expect(await screen.findByText("This service is currently unavailable")).toBeInTheDocument();
    expect(screen.getByText("We are not taking orders for this service right now. Please check back later.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
    expect(screen.queryByLabelText("Sort")).not.toBeInTheDocument();
  });

  it("heads the page with the group emoji and name, and fetches the first page of 20", async () => {
    renderGroup("premium-apps", () => premiumPage);
    expect(await screen.findByRole("heading", { level: 1, name: "💎 Premium Apps" })).toBeInTheDocument();
    expect(groupCalls()[0]).toBe("/api/v1/pages/group/premium-apps?offset=0&limit=20");
    await waitFor(() => expect(document.title).toBe("Premium Apps — Toko Digital"));
  });

  it("filters by category with a segmented control that keeps the sort in the URL", async () => {
    renderGroup("premium-apps", () => premiumPage, "?sort=newest");
    const filter = await screen.findByRole("group", { name: "Categories" });
    const all = within(filter).getByRole("button", { name: "All" });
    const music = within(filter).getByRole("button", { name: "🎵 Music" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(music).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(music);
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent("?sort=newest&category=music"));
    await waitFor(() =>
      expect(groupCalls()).toContain("/api/v1/pages/group/premium-apps?category=music&sort=newest&offset=0&limit=20"),
    );
    expect(within(filter).getByRole("button", { name: "🎵 Music" })).toHaveAttribute("aria-pressed", "true");
    expect(within(filter).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(within(filter).getByRole("button", { name: "All" }));
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent(/^\?sort=newest$/));
  });

  it("offers every sort on Premium Apps and keeps the category when the sort changes", async () => {
    renderGroup("premium-apps", () => premiumPage, "?category=music");
    const select = await screen.findByLabelText("Sort");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Bestseller", "Newest", "Price: low to high"]);
    fireEvent.change(select, { target: { value: "cheapest" } });
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent("?category=music&sort=cheapest"));
    await waitFor(() =>
      expect(groupCalls()).toContain("/api/v1/pages/group/premium-apps?category=music&sort=cheapest&offset=0&limit=20"),
    );
  });

  it("does not offer cheapest on Top Up Games and corrects a typed ?sort=cheapest in the URL", async () => {
    renderGroup("top-up-games", () => gamePage, "?sort=cheapest");
    const select = await screen.findByLabelText("Sort");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Bestseller", "Newest"]);
    expect(select).toHaveValue("bestseller");
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent(/^$/));
  });

  it("loads more with the first page's ranking version and drops products already shown", async () => {
    renderGroup("top-up-games", (path) =>
      path.includes("offset=2")
        ? {
            ...gamePage,
            // The ranking moved: one repeat plus one genuinely new product.
            products: [card("ff-diamonds", "Free Fire Diamonds", "Free Fire"), card("pubg-uc", "PUBG Mobile UC", "PUBG Mobile")],
            next_offset: null,
            ranking_version: 8,
          }
        : gamePage,
    );
    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("heading", { name: "PUBG Mobile UC" })).toBeInTheDocument();
    expect(groupCalls()).toContain("/api/v1/pages/group/top-up-games?offset=2&limit=20&v=7");
    expect(screen.getAllByRole("heading", { name: "Free Fire Diamonds" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("shows Load more as a pending button (spinner, label kept) while the next page loads", async () => {
    renderGroup("top-up-games", (path) => (path.includes("offset=2") ? new Promise(() => {}) : gamePage));
    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more" })).toHaveAttribute("data-pending", "true"));
    const button = screen.getByRole("button", { name: "Load more" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector("[data-slot=spinner]")).toBeInTheDocument();
  });

  it("says so under the button when Load more fails, keeping what is shown", async () => {
    renderGroup("top-up-games", (path) => {
      if (path.includes("offset=2")) throw Object.assign(new Error("boom"), { status: 500 });
      return gamePage;
    });
    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
    expect(screen.getByRole("heading", { name: "Mobile Legends Diamonds" })).toBeInTheDocument();
    // Still offered, so the visitor can try again.
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
  });

  it("offers no usable Load more while a new filter's first page is still loading", async () => {
    let releaseMusic!: (value: GroupPageData) => void;
    renderGroup("top-up-games", (path) =>
      path.includes("category=free-fire")
        ? new Promise<GroupPageData>((resolve) => {
            releaseMusic = resolve;
          })
        : gamePage,
    );
    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
    fireEvent.click(screen.getByRole("button", { name: "🔥 Free Fire" }));
    // The previous filter's grid stays up as a placeholder; paging it would
    // append the wrong filter's products, so Load more is gone or disabled.
    await waitFor(() => expect(screen.getByRole("button", { name: "🔥 Free Fire" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("heading", { name: "Mobile Legends Diamonds" })).toBeInTheDocument();
    const loadMore = screen.queryByRole("button", { name: "Load more" });
    if (loadMore) expect(loadMore).toBeDisabled();
    releaseMusic({ ...gamePage, products: [card("ff-diamonds", "Free Fire Diamonds", "Free Fire")], total: 1, next_offset: null });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument());
  });

  it("hides Load more when the first page is the whole group", async () => {
    renderGroup("premium-apps", () => premiumPage);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("keeps each family's own card wording", async () => {
    const { unmount } = renderGroup("premium-apps", () => premiumPage);
    const premiumGrid = (await screen.findByRole("heading", { name: "Netflix Premium" })).closest(".grid")!;
    expect(premiumGrid.textContent).not.toMatch(/diamond|top up|player id/i);
    unmount();

    renderGroup("top-up-games", () => gamePage);
    const gameGrid = (await screen.findByRole("heading", { name: "Mobile Legends Diamonds" })).closest(".grid")!;
    expect(gameGrid.textContent).not.toMatch(/premium|subscription|account|warranty/i);
  });
});
