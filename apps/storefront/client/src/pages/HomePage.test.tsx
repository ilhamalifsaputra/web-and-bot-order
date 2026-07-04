import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import HomePage from "./HomePage";
import { apiGet } from "../api/client";
import type { HomePageData, ShopContext } from "../api/types";
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

function homeFixture(overrides: Partial<HomePageData> = {}): HomePageData {
  return {
    hero_image: null,
    categories: [
      { id: 1, name: "Streaming", slug: "streaming", emoji: "🎬", description: null, image: "", sortOrder: 0, isActive: true },
    ],
    products: [product],
    stats: { has_data: false, customers: 0, orders: 0, satisfaction: null },
    testimonials: [],
    low_threshold: 5,
    bot_username: "tokobot",
    wa_number: "6281234567890",
    ...overrides,
  };
}

function renderHome(data: HomePageData) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    if (path === "/api/v1/pages/home") return data;
    throw new Error(`unexpected path ${path}`);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HomePage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders the hero, a product card, and a category pill", async () => {
    renderHome(homeFixture());
    expect(await screen.findByText("Digital products, delivered instantly")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View products/ })).toHaveAttribute("href", "/c/streaming");
  });

  it("renders the static Our Promise section regardless of stats.has_data (home.njk no longer has a data-driven stats band)", async () => {
    renderHome(homeFixture({ stats: { has_data: true, customers: 120, orders: 340, satisfaction: 96 } }));
    expect(await screen.findByText("What every order comes with")).toBeInTheDocument();
    expect(screen.getByText("Delivered in minutes")).toBeInTheDocument();
    // The raw numbers never appear — the section is static value-props either way.
    expect(screen.queryByText("120")).not.toBeInTheDocument();
    expect(screen.queryByText("340")).not.toBeInTheDocument();
  });

  it("renders testimonials when present, and hides the section when empty", async () => {
    const { unmount } = renderHome(
      homeFixture({
        testimonials: [{ name: "Ahmad F.", initial: "A", product: "Netflix Premium", rating: 5, comment: "Great service!" }],
      }),
    );
    expect(await screen.findByText("Ahmad F.")).toBeInTheDocument();
    expect(screen.getByText("“Great service!”")).toBeInTheDocument();
    unmount();

    renderHome(homeFixture({ testimonials: [] }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument());
    expect(screen.queryByText("What customers say")).not.toBeInTheDocument();
  });

  it("hides the WhatsApp contact card when wa_number is empty", async () => {
    renderHome(homeFixture({ wa_number: "" }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByText("WhatsApp")).not.toBeInTheDocument();
    // Telegram card still renders (bot_username is set) — contact section itself isn't hidden.
    expect(screen.getByText("Telegram")).toBeInTheDocument();
  });
});
