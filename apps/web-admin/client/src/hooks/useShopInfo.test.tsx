import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useShopInfo } from "./useShopInfo";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useShopInfo", () => {
  it("resolves shop_name from /api/settings' fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ fields: [{ key: "shop_name", value: "My Shop" }] }),
      })),
    );
    const { result } = renderHook(() => useShopInfo(), { wrapper });
    await waitFor(() => expect(result.current.shopName).toBe("My Shop"));
    expect(fetch).toHaveBeenCalledWith("/api/settings", expect.objectContaining({ credentials: "include" }));
  });

  it("falls back to null shopName when the request fails, without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "",
      })),
    );
    const { result } = renderHook(() => useShopInfo(), { wrapper });
    // Give the query a tick to settle; it should resolve to null, not error.
    await waitFor(() => expect(result.current.shopName).toBeNull());
  });
});
