import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StockPage } from "./StockPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const DENOMINATION = {
  id: 10,
  name: "1 Month",
  isActive: true,
  product: { id: 1, name: "CapCut Pro", category: { name: "Apps" } },
};

const STOCK_DATA = {
  denominations: [DENOMINATION],
  counts: { "10": { available: 5, reserved: 0, sold: 2, dead: 0 } },
  waiting: {},
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("StockPage", () => {
  it("shows denomination rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(STOCK_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());
    expect(screen.getByText("CapCut Pro")).toBeInTheDocument();
  });

  it("shows empty state when no denominations", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ denominations: [], counts: {}, waiting: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no denominations found/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
