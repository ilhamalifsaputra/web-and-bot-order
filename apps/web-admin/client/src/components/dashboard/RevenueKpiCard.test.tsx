import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RevenueKpiCard } from "./RevenueKpiCard";

function renderWithQuery() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RevenueKpiCard />
    </QueryClientProvider>,
  );
}

describe("RevenueKpiCard", () => {
  it("renders each currency on its own line once data loads, never joined into one string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          revenue: { idr: "137", usdt: "20.25", usd: "20.25", trendPct: { idr: null, usdt: null } },
          profit: { idr: null, usdt: null },
          orders: { total: 0, delivered: 0, pending: 0, failed: 0 },
          pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
        }),
      })),
    );
    renderWithQuery();
    await waitFor(() => expect(screen.getByText("Rp137")).toBeInTheDocument());
    expect(screen.getByText("20.25 USDT")).toBeInTheDocument();
    expect(screen.queryByText(/Rp137.*\+.*20\.25/)).not.toBeInTheDocument();
  });

  it("shows a no-revenue message when every currency is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          revenue: { idr: null, usdt: null, usd: null, trendPct: { idr: null, usdt: null } },
          profit: { idr: null, usdt: null },
          orders: { total: 0, delivered: 0, pending: 0, failed: 0 },
          pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
        }),
      })),
    );
    renderWithQuery();
    await waitFor(() => expect(screen.getByText("No revenue yet today.")).toBeInTheDocument());
  });
});
