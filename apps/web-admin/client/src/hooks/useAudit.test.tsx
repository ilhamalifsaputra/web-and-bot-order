import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAudit } from "./useAudit";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useAudit", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ rows: [], total: 0, page: 1, hasNext: false }),
      })),
    );
  });

  it("fetches /api/audit with the query string built from params, with credentials", async () => {
    const { result } = renderHook(() => useAudit({ page: 2, action: "login" }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.total).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      "/api/audit?page=2&action=login",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
