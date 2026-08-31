import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useWalletTransactions } from "./useWalletTransactions";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useWalletTransactions", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ rows: [], total: 0, page: 1, pageSize: 20, hasNext: false, reasons: [] }),
      })),
    );
  });

  it("fetches /api/wallet-transactions with the query string built from params, with credentials", async () => {
    const { result } = renderHook(() => useWalletTransactions({ page: 3, reason: "adjustment" }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.total).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      "/api/wallet-transactions?page=3&reason=adjustment",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
