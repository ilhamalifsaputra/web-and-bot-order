import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProductDetailPage } from "./ProductDetailPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/catalog/1"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/catalog/:productId" element={children} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const PRODUCT_DETAIL = {
  product: {
    id: 1,
    name: "CapCut Pro",
    isActive: true,
    category: { id: 2, name: "Apps" },
    denominations: [
      {
        id: 10,
        name: "1 Month",
        price: "50000",
        costPrice: null,
        isActive: true,
        type: "PRIVATE",
        durationLabel: "Monthly", // intentionally different from name
      },
    ],
  },
  statsByDenom: {
    "10": { id: 10, available: 5, waiting: 0, rule: null },
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ProductDetailPage", () => {
  it("shows product detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(PRODUCT_DETAIL), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    // Wait for data to load — "PRIVATE" is in the denomination type td (unique leaf cell)
    await waitFor(() => expect(screen.getByText("PRIVATE")).toBeInTheDocument());
    // Denomination name appears once (durationLabel is "Monthly", not "1 Month")
    expect(screen.getByText("1 Month")).toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
