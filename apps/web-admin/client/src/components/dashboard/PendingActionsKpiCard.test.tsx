import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
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
      <MemoryRouter>
        <PendingActionsKpiCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PendingActionsKpiCard", () => {
  it("shows the total and four drill-down links with the exact hrefs", async () => {
    renderWith({ toReview: 3, refundDecisions: 1, failedDeliveries: 2, manualApprovals: 0 });
    await waitFor(() => expect(screen.getByText("6")).toBeInTheDocument()); // 3+1+2+0
    const hrefOf = (name: RegExp) => screen.getByRole("link", { name }).getAttribute("href");
    expect(hrefOf(/payments to review/i)).toBe("/orders?status=PENDING_VERIFICATION");
    expect(hrefOf(/underpaid orders/i)).toBe("/orders?status=UNDERPAID");
    expect(hrefOf(/failed deliveries/i)).toBe("/payments?outcome=delivery_failed&actionable=1");
    expect(hrefOf(/unmatched payments/i)).toBe("/payments?outcome=unmatched&actionable=1");
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });

  it("still renders a zero row, muted, as a link", async () => {
    renderWith({ toReview: 3, refundDecisions: 1, failedDeliveries: 2, manualApprovals: 0 });
    const link = await screen.findByRole("link", { name: /unmatched payments/i });
    expect(link).toHaveTextContent("0");
    expect(link.className).toMatch(/text-ink-soft/);
    expect(screen.getByRole("link", { name: /failed deliveries/i }).className).not.toMatch(/text-ink-soft/);
  });

  it("shows an all-clear empty state when every count is zero", async () => {
    renderWith({ toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 });
    await waitFor(() => expect(screen.getByText(/all caught up/i)).toBeInTheDocument());
  });
});
