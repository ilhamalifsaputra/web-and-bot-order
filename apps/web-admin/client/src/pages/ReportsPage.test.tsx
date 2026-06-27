import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Recharts' ResponsiveContainer uses ResizeObserver which jsdom doesn't provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub;
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReportsPage } from "./ReportsPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const MOCK_DATA = {
  daily: [{ date: "2026-06-25", revenue_idr: "500000", revenue_usdt: "0", orders: 3 }],
  totalIdr: "500000",
  totalUsdt: null,
  products: [{ productName: "Netflix 1mo", sold: 5, revenue_idr: "500000" }],
  funnel: { DELIVERED: 10, PENDING_PAYMENT: 2 },
  vouchers: [],
  days: 30,
};

beforeEach(() => { vi.restoreAllMocks(); });

describe("ReportsPage", () => {
  it("renders revenue totals and product table", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ReportsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Netflix 1mo")).toBeInTheDocument());
    expect(screen.getByText(/30-day revenue/i)).toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<ReportsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
