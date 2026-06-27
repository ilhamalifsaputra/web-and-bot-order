import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StockProductPage } from "./StockProductPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/stock/10"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/stock/:productId" element={children} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const STOCK_PRODUCT_DATA = {
  product: {
    id: 10,
    name: "1 Month",
    isActive: true,
    product: { id: 1, name: "CapCut Pro", category: { name: "Apps" } },
  },
  items: [
    { id: 101, status: "AVAILABLE", note: null, createdAt: "2026-01-01T00:00:00.000Z" },
  ],
  available: 1,
  waiting: 0,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("StockProductPage", () => {
  it("shows stock product detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(STOCK_PRODUCT_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<StockProductPage />, { wrapper: Wrapper });
    // Wait for data — "AVAILABLE" is in the status td (unique leaf cell)
    await waitFor(() => expect(screen.getByText("AVAILABLE")).toBeInTheDocument());
    // Item id appears in its own td
    expect(screen.getByText("101")).toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
