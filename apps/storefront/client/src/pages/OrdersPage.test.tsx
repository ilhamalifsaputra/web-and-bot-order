import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OrdersPage from "./OrdersPage";
import { apiGet } from "../api/client";
import type { AccountOrdersData, ShopContext } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
}));

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

// Task 16 (page-templates.md §6): two distinguishable orders — different codes,
// different item names, different statuses — so a search substring or a status
// pick can narrow to exactly one.
const TWO_ORDERS: AccountOrdersData = {
  orders: [
    { code: "ORD-NFLX", status: "delivered", currency: "IDR", total: "158000", created_at_display: "2026-07-01 10:00", items: "Netflix 1 month" },
    { code: "ORD-SPOT", status: "pending", currency: "IDR", total: "20000", created_at_display: "2026-07-02 09:00", items: "Spotify Premium" },
  ],
};

function renderOrders(respond: (path: string) => unknown, ctx: ShopContext = context) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return ctx;
    return respond(path);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/account/orders"]}>
        <Routes>
          <Route path="/account/orders" element={<OrdersPage />} />
          <Route path="/account/orders/:code" element={<div>order-detail-stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("OrdersPage", () => {
  it("uses the canonical automatic fulfillment badge for a processing top-up", async () => {
    renderOrders(() => ({ orders: [{ ...TWO_ORDERS.orders[0], status: "PROCESSING", fulfillment: { mode: "AUTO", provider: "DIGIFLAZZ", status: "PROCESSING", payment_status: "PAID", can_edit_customer_data: false } }] }));
    expect(await screen.findByText("Processing")).toBeInTheDocument();
    expect(screen.queryByText("Being prepared")).not.toBeInTheDocument();
  });
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders order rows with the display date and total", async () => {
    const data: AccountOrdersData = {
      orders: [
        {
          code: "ORD1",
          status: "delivered",
          currency: "IDR",
          total: "158000",
          created_at_display: "2026-07-01 10:00",
          items: "Netflix 1 month",
        },
      ],
    };
    renderOrders(() => data);
    expect(await screen.findByRole("heading", { name: "My orders" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ORD1" })).toHaveAttribute("href", "/account/orders/ORD1");
    expect(screen.getByText("Netflix 1 month")).toBeInTheDocument();
    expect(screen.getByText("Rp158,000")).toBeInTheDocument();
    expect(screen.getByText("2026-07-01 10:00")).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
  });

  // Task 5 fix pass: `total` is each order's OWN settlement amount, in its own
  // `currency` — the viewer's display preference must never re-convert it
  // (9.88 USDT pushed through IDR→USD would print "$0.01").
  describe("settled totals ignore the display-currency preference", () => {
    const MIXED: AccountOrdersData = {
      orders: [
        { code: "ORD-USDT", status: "delivered", currency: "USDT", total: "9.88", created_at_display: "2026-07-01 10:00", items: "Netflix 1 month" },
        { code: "ORD-IDR", status: "delivered", currency: "IDR", total: "158000", created_at_display: "2026-07-02 09:00", items: "Spotify Premium" },
      ],
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each([["USD" as const], ["IDR" as const], [null]])(
      "cards show each order's native total (viewer preference %s)",
      async (currency) => {
        renderOrders(() => MIXED, { ...context, currency });
        expect(await screen.findByText("9.88 USDT")).toBeInTheDocument();
        expect(screen.getByText("Rp158,000")).toBeInTheDocument();
        expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
      },
    );

    it.each([["USD" as const], ["IDR" as const]])(
      "the desktop table shows each order's native total (viewer preference %s)",
      async (currency) => {
        vi.stubGlobal("matchMedia", (query: string) => ({
          matches: true,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }));
        renderOrders(() => MIXED, { ...context, currency });
        expect(await screen.findByRole("table")).toBeInTheDocument();
        expect(screen.getByText("9.88 USDT")).toBeInTheDocument();
        expect(screen.getByText("Rp158,000")).toBeInTheDocument();
        expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
      },
    );
  });

  // The point of the card layout: on a phone this page used to be a
  // five-column table behind a horizontal scroll. jsdom has no matchMedia, so
  // useIsDesktop() reports false and the mobile branch is what renders here.
  it("renders orders as cards, with no table, on a small viewport", async () => {
    const data: AccountOrdersData = {
      orders: [
        { code: "ORD1", status: "delivered", currency: "IDR", total: "158000", created_at_display: "2026-07-01 10:00", items: "Netflix 1 month" },
        { code: "ORD2", status: "pending", currency: "IDR", total: "20000", created_at_display: "2026-07-02 09:00", items: "Spotify" },
      ],
    };
    renderOrders(() => data);
    await screen.findByRole("link", { name: "ORD1" });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    // Whole card is the tap target, one per order.
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "ORD2" })).toHaveAttribute("href", "/account/orders/ORD2");
  });

  // STO-016: the empty state used to be a dead end — it now offers a way
  // back to the catalog.
  it("renders the empty-state row with a Continue shopping CTA when there are no orders", async () => {
    renderOrders(() => ({ orders: [] }));
    expect(await screen.findByText("No orders yet — your purchases will show up here.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/");
  });

  // ---- Task 16: client-side filter row (page-templates.md §6) ----

  // Render gate: the filter row mirrors SortSelect's "more than one to filter"
  // precedent — a filter over a single order narrows nothing.
  it("hides the filter row when there is only one order to filter", async () => {
    renderOrders(() => ({
      orders: [
        { code: "ORD1", status: "delivered", currency: "IDR", total: "158000", created_at_display: "2026-07-01 10:00", items: "Netflix 1 month" },
      ],
    }));
    await screen.findByRole("link", { name: "ORD1" });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Status" })).not.toBeInTheDocument();
  });

  it("shows the search input and status select once there are at least two orders", async () => {
    renderOrders(() => TWO_ORDERS);
    await screen.findByRole("link", { name: "ORD-NFLX" });
    expect(screen.getByRole("searchbox", { name: "Search by code or item" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Status" })).toBeInTheDocument();
  });

  it("narrows the visible list to the matching order when a search term is typed", async () => {
    const user = userEvent.setup();
    renderOrders(() => TWO_ORDERS);
    await screen.findByRole("link", { name: "ORD-NFLX" });
    await user.type(screen.getByRole("searchbox", { name: "Search by code or item" }), "spotify");
    expect(screen.queryByRole("link", { name: "ORD-NFLX" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ORD-SPOT" })).toBeInTheDocument();
  });

  it("filters by status, and restores the full list when 'All statuses' is reselected", async () => {
    const user = userEvent.setup();
    renderOrders(() => TWO_ORDERS);
    await screen.findByRole("link", { name: "ORD-NFLX" });
    const statusSelect = screen.getByRole("combobox", { name: "Status" });
    await user.selectOptions(statusSelect, "delivered");
    expect(screen.getByRole("link", { name: "ORD-NFLX" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "ORD-SPOT" })).not.toBeInTheDocument();
    await user.selectOptions(statusSelect, "all");
    expect(screen.getByRole("link", { name: "ORD-NFLX" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ORD-SPOT" })).toBeInTheDocument();
  });

  // §16: a filter that matches nothing gets its own copy (web.orders_no_match),
  // never the first-time "no orders yet" wording, plus a way back out.
  it("shows the no-match empty state (distinct from 'no orders yet') and a working Clear filters reset", async () => {
    const user = userEvent.setup();
    renderOrders(() => TWO_ORDERS);
    await screen.findByRole("link", { name: "ORD-NFLX" });
    await user.type(screen.getByRole("searchbox", { name: "Search by code or item" }), "no-such-order");
    // web.orders_no_match — NOT web.no_orders.
    expect(screen.getByText("No orders match your filter")).toBeInTheDocument();
    expect(screen.queryByText("No orders yet — your purchases will show up here.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("link", { name: "ORD-NFLX" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ORD-SPOT" })).toBeInTheDocument();
    expect(screen.queryByText("No orders match your filter")).not.toBeInTheDocument();
  });

  // The two empty states never collide: zero orders keeps the first-time copy
  // (web.no_orders) and its catalogue CTA.
  it("shows the first-time 'no orders yet' empty state, not the no-match one, when there are zero orders", async () => {
    renderOrders(() => ({ orders: [] }));
    expect(await screen.findByText("No orders yet — your purchases will show up here.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/");
    expect(screen.queryByText("No orders match your filter")).not.toBeInTheDocument();
  });
});
