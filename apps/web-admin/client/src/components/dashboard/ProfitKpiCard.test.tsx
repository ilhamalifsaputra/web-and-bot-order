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
  it("distinguishes unknown historical FX from unknown cost", async () => {
    renderWithKpis({ idr: null, usdt: { netProfit: "0", marginPct: null, excludedItemCount: 1, excludedFxItemCount: 1 } });
    expect(await screen.findByText(/1 items with unknown FX/)).toBeInTheDocument();
    expect(screen.queryByText(/without a cost price/)).toBeNull();
  });
  it("shows net profit and margin% per currency, never blended", async () => {
    renderWithKpis({
      idr: { netProfit: "8000", marginPct: "40", excludedItemCount: 0 },
      usdt: { netProfit: "8", marginPct: "80", excludedItemCount: 0 },
    });
    await waitFor(() => expect(screen.getByText("Rp8.000")).toBeInTheDocument());
    expect(screen.getByText("8 USDT")).toBeInTheDocument();
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

  it("shows the load error, not the 'no profit yet' empty state, when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "", json: async () => ({}) })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ProfitKpiCard />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/couldn't load profit/i)).toBeInTheDocument());
    expect(screen.queryByText(/no profit yet/i)).not.toBeInTheDocument();
  });

  it("states its basis under a real figure", async () => {
    renderWithKpis({ idr: { netProfit: "8000", marginPct: "40", excludedItemCount: 0 }, usdt: null });
    await waitFor(() => expect(screen.getByText(/delivered today · product orders only/i)).toBeInTheDocument());
  });
});
