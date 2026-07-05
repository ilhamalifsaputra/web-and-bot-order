import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OrderDetailPage from "./OrderDetailPage";
import { apiGet } from "../api/client";
import type { OrderDetailData, ShopContext } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
}));

const context: ShopContext = {
  lang: "en",
  fx: null,
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 0,
  customer: { username: "alice", email: null, telegram_linked: false },
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  tzname: "Asia/Jakarta",
};

const baseOrder: OrderDetailData["order"] = {
  code: "ORD1",
  status: "delivered",
  subtotal: "158000",
  discount: "0",
  bulk_discount: "0",
  total: "158000",
  created_at_display: "2026-07-01 10:00",
  items: [
    { name: "Netflix", duration: "1 month", unit_price: "158000", warranty_days: 30, credentials: null },
  ],
};

function renderDetail(respond: (path: string) => unknown, code = "ORD1") {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    return respond(path);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/account/orders/${code}`]}>
        <Routes>
          <Route path="/account/orders/:code" element={<OrderDetailPage />} />
          <Route path="/checkout/:code/pay" element={<div>pay-page-stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("OrderDetailPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("shows credentials for a delivered order", async () => {
    const data: OrderDetailData = {
      order: {
        ...baseOrder,
        items: [{ ...baseOrder.items[0], credentials: "user:pass" }],
      },
      delivered: true,
      pending_payment: false,
    };
    renderDetail(() => data);
    expect(await screen.findByText("Your credentials")).toBeInTheDocument();
    expect(screen.getByText("user:pass")).toBeInTheDocument();
  });

  it("hides credentials for a non-delivered order", async () => {
    const data: OrderDetailData = {
      order: { ...baseOrder, status: "pending_payment" },
      delivered: false,
      pending_payment: false,
    };
    renderDetail(() => data);
    await screen.findByRole("heading", { name: /Order code/ });
    expect(screen.queryByText("Your credentials")).not.toBeInTheDocument();
  });

  it("shows the continue-to-payment link when pending_payment", async () => {
    const data: OrderDetailData = {
      order: { ...baseOrder, status: "pending_payment" },
      delivered: false,
      pending_payment: true,
    };
    renderDetail(() => data);
    expect(await screen.findByRole("link", { name: /Pay now/ })).toHaveAttribute(
      "href",
      "/checkout/ORD1/pay",
    );
  });

  it("renders ErrorPage on a 404", async () => {
    renderDetail(() => {
      const err = new Error("not_found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    expect(await screen.findByText("404")).toBeInTheDocument();
  });
});
