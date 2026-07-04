import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
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
  tzname: "Asia/Jakarta",
};

function renderOrders(respond: (path: string) => unknown) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
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
    expect(screen.getByText("Rp158.000")).toBeInTheDocument();
    expect(screen.getByText("2026-07-01 10:00")).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
  });

  it("renders the empty-state row when there are no orders", async () => {
    renderOrders(() => ({ orders: [] }));
    expect(await screen.findByText("No orders yet — your purchases will show up here.")).toBeInTheDocument();
  });
});
