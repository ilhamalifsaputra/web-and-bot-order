import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrdersKpiCard } from "./OrdersKpiCard";

function renderWithOrders(orders: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        revenue: { idr: null, usdt: null, usd: null, trendPct: { idr: null, usdt: null } },
        profit: { idr: null, usdt: null },
        orders,
        pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
      }),
    })),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OrdersKpiCard />
    </QueryClientProvider>,
  );
}

describe("OrdersKpiCard", () => {
  it("shows the total prominently and the delivered/pending/failed breakdown", async () => {
    renderWithOrders({ total: 12, delivered: 9, pending: 2, failed: 1 });
    await waitFor(() => expect(screen.getByText("12")).toBeInTheDocument());
    expect(screen.getByText(/9 delivered/)).toBeInTheDocument();
    expect(screen.getByText(/2 pending/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });
});
