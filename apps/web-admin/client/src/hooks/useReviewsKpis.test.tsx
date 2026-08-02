import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useReviewsKpis } from "./useReviewsKpis";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useReviewsKpis", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          totalReviews: 42,
          avgRating: 4.2,
          pendingReplyCount: 7,
          negativeCount: 3,
          hiddenCount: 2,
          ratingDistribution: { 1: 1, 2: 2, 3: 4, 4: 15, 5: 20 },
        }),
      })),
    );
  });

  it("fetches /api/reviews/kpis with credentials and returns the parsed response", async () => {
    const { result } = renderHook(() => useReviewsKpis(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.totalReviews).toBe(42);
    expect(result.current.data?.avgRating).toBe(4.2);
    expect(result.current.data?.pendingReplyCount).toBe(7);
    expect(result.current.data?.negativeCount).toBe(3);
    expect(result.current.data?.hiddenCount).toBe(2);
    expect(result.current.data?.ratingDistribution).toEqual({ 1: 1, 2: 2, 3: 4, 4: 15, 5: 20 });
    expect(fetch).toHaveBeenCalledWith("/api/reviews/kpis", expect.objectContaining({ credentials: "include" }));
  });

  it("returns a null avgRating as-is (no reviews yet)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          totalReviews: 0,
          avgRating: null,
          pendingReplyCount: 0,
          negativeCount: 0,
          hiddenCount: 0,
          ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        }),
      })),
    );
    const { result } = renderHook(() => useReviewsKpis(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.avgRating).toBeNull();
  });
});
