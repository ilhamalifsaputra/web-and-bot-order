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
    // The payload still carries the old duplicate `usd` field; the same USDT
    // amount must not be shown a second time under a "USD" label.
    expect(screen.queryByText("USD")).not.toBeInTheDocument();
    expect(screen.queryByText("20.25 USD")).not.toBeInTheDocument();
    // The basis line names both legs of the figure: master's `salesRevenueByCurrency`
    // adds the wallet credit spent on a sale to what was charged for it, so
    // saying only "product orders" would understate what the number counts.
    expect(
      screen.getByText(/Delivered today · product sales only, charged amount plus wallet credit spent/i),
    ).toBeInTheDocument();
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

  it("shows a per-currency trend line when yesterday had comparable revenue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          revenue: { idr: "10000", usdt: null, usd: null, trendPct: { idr: "12.3", usdt: null } },
          profit: { idr: null, usdt: null },
          orders: { total: 0, delivered: 0, pending: 0, failed: 0 },
          pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
        }),
      })),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <RevenueKpiCard />
      </QueryClientProvider>,
    );
    // Labelled with its currency and the real comparison basis.
    await waitFor(() => expect(screen.getByText("IDR 12.3% vs same time yesterday")).toBeInTheDocument());
  });

  it("labels each currency's trend line separately and shows none for a currency whose base was too small", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          revenue: { idr: "10000", usdt: "5", trendPct: { idr: "12.3", usdt: null } },
          profit: { idr: null, usdt: null },
          orders: { total: 0, delivered: 0, pending: 0, failed: 0, other: 0 },
          pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
        }),
      })),
    );
    renderWithQuery();
    await waitFor(() => expect(screen.getByText("IDR 12.3% vs same time yesterday")).toBeInTheDocument());
    expect(screen.queryByText(/USDT .*vs same time yesterday/)).not.toBeInTheDocument();
  });
});
