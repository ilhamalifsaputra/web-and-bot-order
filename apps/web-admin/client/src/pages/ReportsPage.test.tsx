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
  daily: [{ day: "2026-06-25", revenue_idr: "500000", revenue_usdt: "0", orders: 3 }],
  totalIdr: "500000",
  totalUsdt: null,
  products: [{ productId: 1, name: "Netflix 1mo", qty: 5, revenue: "500000" }],
  funnel: [{ status: "DELIVERED", count: 10 }, { status: "PENDING_PAYMENT", count: 2 }],
  vouchers: [{ id: 1, code: "SAVE10", usedCount: 4, usageLimit: 100, isActive: true }],
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
    // Regression: funnel is an array of {status, count}, not a Record — this
    // used to crash the page with "Objects are not valid as a React child".
    // Rendered via StatusBadge, which title-cases the raw status string.
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("SAVE10")).toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<ReportsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
