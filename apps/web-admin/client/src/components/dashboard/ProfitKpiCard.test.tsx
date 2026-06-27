import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProfitKpiCard } from "./ProfitKpiCard";

function renderWithKpis(profit: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        revenue: { idr: null, usdt: null, usd: null, trendPct: { idr: null, usdt: null } },
        profit,
        orders: { total: 0, delivered: 0, pending: 0, failed: 0 },
        pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
      }),
    })),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProfitKpiCard />
    </QueryClientProvider>,
  );
}

describe("ProfitKpiCard", () => {
  it("shows net profit and margin% per currency, never blended", async () => {
    renderWithKpis({
      idr: { netProfit: "8000", marginPct: "40", excludedItemCount: 0 },
      usdt: { netProfit: "8", marginPct: "80", excludedItemCount: 0 },
    });
    await waitFor(() => expect(screen.getByText("Rp8.000")).toBeInTheDocument());
    expect(screen.getByText("8.00 USDT")).toBeInTheDocument();
    expect(screen.getByText(/40% margin/)).toBeInTheDocument();
    expect(screen.getByText(/80% margin/)).toBeInTheDocument();
  });

  it("flags excluded (cost-unknown) items instead of showing a fake margin", async () => {
    renderWithKpis({ idr: { netProfit: "0", marginPct: null, excludedItemCount: 3 }, usdt: null });
    await waitFor(() => expect(screen.getByText(/3 items? without a cost price/i)).toBeInTheDocument());
  });

  it("shows an empty state when there is no profit data", async () => {
    renderWithKpis({ idr: null, usdt: null });
    await waitFor(() => expect(screen.getByText(/no profit yet/i)).toBeInTheDocument());
  });
});
