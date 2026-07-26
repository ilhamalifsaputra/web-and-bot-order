import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCustomersKpis } from "./useCustomersKpis";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useCustomersKpis", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          totalCustomers: 150,
          newToday: 5,
          activeToday: 42,
          returningCustomers: 100,
          totalRevenue: { idr: "500000", usdt: "25.50" },
        }),
      })),
    );
  });

  it("fetches /api/users/kpis with credentials and returns the parsed response", async () => {
    const { result } = renderHook(() => useCustomersKpis(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.totalCustomers).toBe(150);
    expect(result.current.data?.newToday).toBe(5);
    expect(result.current.data?.activeToday).toBe(42);
    expect(result.current.data?.returningCustomers).toBe(100);
    expect(result.current.data?.totalRevenue.idr).toBe("500000");
    expect(result.current.data?.totalRevenue.usdt).toBe("25.50");
    expect(fetch).toHaveBeenCalledWith("/api/users/kpis", expect.objectContaining({ credentials: "include" }));
  });
});
