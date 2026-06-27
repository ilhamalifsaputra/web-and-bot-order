import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PendingActionsKpiCard } from "./PendingActionsKpiCard";

function renderWith(pendingActions: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        revenue: { idr: null, usdt: null, usd: null, trendPct: { idr: null, usdt: null } },
        profit: { idr: null, usdt: null },
        orders: { total: 0, delivered: 0, pending: 0, failed: 0 },
        pendingActions,
      }),
    })),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PendingActionsKpiCard />
    </QueryClientProvider>,
  );
}

describe("PendingActionsKpiCard", () => {
  it("sums the four pending-action counts and lists each", async () => {
    renderWith({ toReview: 3, refundDecisions: 1, failedDeliveries: 2, manualApprovals: 0 });
    await waitFor(() => expect(screen.getByText("6")).toBeInTheDocument()); // 3+1+2+0
    expect(screen.getByText(/3 to review/i)).toBeInTheDocument();
    expect(screen.getByText(/2 failed deliveries/i)).toBeInTheDocument();
  });

  it("shows an all-clear empty state when every count is zero", async () => {
    renderWith({ toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 });
    await waitFor(() => expect(screen.getByText(/all caught up/i)).toBeInTheDocument());
  });
});
