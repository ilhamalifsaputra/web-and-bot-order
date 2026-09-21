import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RefundsKpiCard } from "./RefundsKpiCard";

function stubKpis(over: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        revenue: { idr: null, usdt: null, usd: null, trendPct: { idr: null, usdt: null } },
        refunds: { idr: null, usdt: null },
        netSales: { idr: null, usdt: null },
        profit: { idr: null, usdt: null },
        orders: { total: 0, delivered: 0, pending: 0, failed: 0 },
        pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
        ...over,
      }),
    })),
  );
}

function renderWithQuery() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RefundsKpiCard />
    </QueryClientProvider>,
  );
}

describe("RefundsKpiCard", () => {
  it("renders each currency's refund total on its own line, never joined into one string", async () => {
    stubKpis({ refunds: { idr: "54000", usdt: "3.43" } });
    renderWithQuery();
    await waitFor(() => expect(screen.getByText("Rp54.000")).toBeInTheDocument());
    expect(screen.getByText("3.43 USDT")).toBeInTheDocument();
    expect(screen.queryByText(/Rp54\.000.*3\.43/)).not.toBeInTheDocument();
  });

  it("shows an honest no-refunds message rather than a fabricated Rp0 when nothing was refunded", async () => {
    stubKpis({ refunds: { idr: null, usdt: null } });
    renderWithQuery();
    await waitFor(() => expect(screen.getByText("No refunds yet today.")).toBeInTheDocument());
  });

  // Every card on this dashboard states its own "today" basis, because they
  // genuinely differ: this one buckets on the payout's own executedAt, while
  // Revenue/Profit bucket on deliveredAt and Orders Today on createdAt.
  it("says the figure is what was paid out today, not what was requested", async () => {
    stubKpis({ refunds: { idr: "2000", usdt: null } });
    renderWithQuery();
    await waitFor(() =>
      expect(screen.getByText(/Paid out today · the payout itself, not the amount requested/)).toBeInTheDocument(),
    );
  });
});
