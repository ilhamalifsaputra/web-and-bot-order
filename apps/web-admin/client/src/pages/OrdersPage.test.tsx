import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrdersPage } from "./OrdersPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const ORDER = {
  id: 1,
  orderCode: "ORD-0001",
  status: "PENDING_VERIFICATION",
  currency: "IDR",
  totalAmount: "50000",
  paymentMethod: "BINANCE_PAY",
  createdAt: "2026-01-01T00:00:00.000Z",
  user: { id: 10, fullName: "Andi Santoso", username: "andi" },
};

const ORDERS_DATA = {
  orders: [ORDER],
  total: 1,
  page: 1,
  pageSize: 50,
  hasNext: false,
  statuses: ["PENDING_PAYMENT", "PENDING_VERIFICATION", "DELIVERED", "REJECTED"],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("OrdersPage", () => {
  it("shows order rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(ORDERS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-0001")).toBeInTheDocument());
    expect(screen.getByText("Andi Santoso")).toBeInTheDocument();
    expect(screen.getByText("BINANCE_PAY")).toBeInTheDocument();
  });

  it("shows empty state when no orders", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ orders: [], total: 0, page: 1, pageSize: 50, hasNext: false, statuses: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no orders found/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
