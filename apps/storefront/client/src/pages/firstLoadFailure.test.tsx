import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { apiGet } from "../api/client";
import type { ShopContext } from "../api/types";
import AccountPage from "./AccountPage";
import CartPage from "./CartPage";
import CategoriesPage from "./CategoriesPage";
import FlashPage from "./FlashPage";
import HomePage from "./HomePage";
import OrdersPage from "./OrdersPage";
import ProductsPage from "./ProductsPage";
import ReferralPage from "./ReferralPage";
import ReviewsPage from "./ReviewsPage";
import SettingsPage from "./SettingsPage";

vi.mock("../api/client", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

const context: ShopContext = {
  lang: "en",
  fx: "16000",
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 0,
  customer: { username: "alice", email: null, telegram_linked: false },
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  wa_number: null,
  tzname: "Asia/Jakarta",
  currency: null,
};

/** H3 (UI-states audit): every page that used to test only `!data`. */
const PAGES: Array<{ name: string; path: string; endpoint: string; Page: ComponentType }> = [
  { name: "Cart", path: "/cart", endpoint: "/api/v1/cart", Page: CartPage },
  { name: "Orders", path: "/account/orders", endpoint: "/api/v1/account/orders", Page: OrdersPage },
  { name: "Account", path: "/account", endpoint: "/api/v1/account", Page: AccountPage },
  { name: "Home", path: "/", endpoint: "/api/v1/pages/home", Page: HomePage },
  { name: "Products", path: "/products", endpoint: "/api/v1/pages/products", Page: ProductsPage },
  { name: "Categories", path: "/categories", endpoint: "/api/v1/pages/categories", Page: CategoriesPage },
  { name: "Flash", path: "/flash", endpoint: "/api/v1/pages/flash", Page: FlashPage },
  { name: "Referral", path: "/account/referral", endpoint: "/api/v1/account/referral", Page: ReferralPage },
  { name: "Reviews", path: "/account/reviews", endpoint: "/api/v1/account/reviews", Page: ReviewsPage },
  { name: "Settings", path: "/account/settings", endpoint: "/api/v1/account/settings", Page: SettingsPage },
];

function serverError(path: string): Error {
  const err = new Error(`${path} responded 502`) as Error & { status?: number };
  err.status = 502;
  return err;
}

/** Calls to exactly this endpoint (a `?query` suffix counts, a longer path does not). */
function callsTo(endpoint: string): number {
  return (apiGet as Mock).mock.calls.filter(([p]: [string]) => p === endpoint || p.startsWith(`${endpoint}?`)).length;
}

describe("first-load failure on data-bound pages (H3)", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it.each(PAGES)("$name: a failed first load shows an error with Try again, and Try again refetches once", async ({ path, endpoint, Page }) => {
    (apiGet as Mock).mockImplementation(async (p: string) => {
      if (p === "/api/v1/pages/context") return context;
      throw serverError(p);
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={path} element={<Page />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    // Cart's key waits on the shop context, so it can read twice on load.
    const before = callsTo(endpoint);
    expect(before).toBeGreaterThan(0);

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(callsTo(endpoint)).toBe(before + 1));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
  });
});
