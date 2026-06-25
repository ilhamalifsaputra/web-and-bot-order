import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useDashboardKpis } from "./useDashboardKpis";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useDashboardKpis", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          revenue: { idr: "10000", usdt: null, usd: null, trendPct: { idr: null, usdt: null } },
          profit: { idr: null, usdt: null },
          orders: { total: 1, delivered: 1, pending: 0, failed: 0 },
          pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
        }),
      })),
    );
  });

  it("fetches /api/dashboard/kpis with credentials and returns the parsed response", async () => {
    const { result } = renderHook(() => useDashboardKpis(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.revenue.idr).toBe("10000");
    expect(fetch).toHaveBeenCalledWith("/api/dashboard/kpis", expect.objectContaining({ credentials: "include" }));
  });
});
