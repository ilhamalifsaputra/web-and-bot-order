import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TopProductsList } from "./TopProductsList";

function renderWith(rows: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TopProductsList />
    </QueryClientProvider>,
  );
}

describe("TopProductsList", () => {
  it("shows units, IDR-equivalent revenue, and profit per product", async () => {
    renderWith([
      { productId: 1, name: "Product A", unitsSold: 3, revenueIdrEquiv: "30000", profitIdrEquiv: "12000", costUnknownUnits: 0 },
    ]);
    await waitFor(() => expect(screen.getByText("Product A")).toBeInTheDocument());
    expect(screen.getByText(/3 sold/)).toBeInTheDocument();
    expect(screen.getByText(/Rp30\.000 revenue/)).toBeInTheDocument();
    expect(screen.getByText(/Rp12\.000 profit/)).toBeInTheDocument();
  });

  it("shows N/A profit when some units have unknown cost", async () => {
    renderWith([
      { productId: 2, name: "Product B", unitsSold: 1, revenueIdrEquiv: "10000", profitIdrEquiv: null, costUnknownUnits: 1 },
    ]);
    await waitFor(() => expect(screen.getByText(/N\/A profit/)).toBeInTheDocument());
  });

  it("shows an empty state with no sales", async () => {
    renderWith([]);
    await waitFor(() => expect(screen.getByText(/no sales in this period/i)).toBeInTheDocument());
  });
});
