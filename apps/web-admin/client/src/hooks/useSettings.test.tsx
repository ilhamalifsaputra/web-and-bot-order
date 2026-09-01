import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSettings } from "./useSettings";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSettings", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          fields: [],
          payMethodState: {},
          bybitHealth: { status: "unmonitored", detail: "n/a" },
          bybitBscHealth: { status: "unmonitored", detail: "n/a" },
          isOwner: true,
          twoFaEnabled: false,
          twoFaPending: null,
        }),
      })),
    );
  });

  it("fetches /api/settings with credentials and returns the parsed response", async () => {
    const { result } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.isOwner).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/settings", expect.objectContaining({ credentials: "include" }));
  });
});
