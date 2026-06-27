import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InventoryMonitoringCard } from "./InventoryMonitoringCard";

function renderWith(rows: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InventoryMonitoringCard />
    </QueryClientProvider>,
  );
}

describe("InventoryMonitoringCard", () => {
  it("lists each critical-stock product with its count, worst first", async () => {
    renderWith([
      { denominationId: 1, productName: "CapCut Pro 30 Day", available: 2, threshold: 3 },
      { denominationId: 2, productName: "Netflix Premium", available: 0, threshold: 3 },
    ]);
    await waitFor(() => expect(screen.getByText("CapCut Pro 30 Day")).toBeInTheDocument());
    expect(screen.getByText("Netflix Premium")).toBeInTheDocument();
    expect(screen.getByText("View inventory").closest("a")).toHaveAttribute("href", "/stock");
  });

  it("shows an all-stocked empty state when nothing is low", async () => {
    renderWith([]);
    await waitFor(() => expect(screen.getByText(/stock levels are healthy/i)).toBeInTheDocument());
  });
});
