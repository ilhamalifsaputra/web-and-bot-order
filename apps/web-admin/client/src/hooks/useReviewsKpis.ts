import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";

export interface ReviewsKpis {
  totalReviews: number;
  avgRating: number | null;
  pendingReplyCount: number;
  negativeCount: number;
  hiddenCount: number;
  ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

// Query key is a plain ["reviews", "kpis"] tuple (not ["reviews", "kpis", ...]),
// deliberately sharing the "reviews" prefix with ReviewsPage.tsx's own list
// query (queryKey: ["reviews", applied]) so a broad
// invalidateQueries({ queryKey: ["reviews"] }) after a mutation (hide/reply)
// refreshes this KPI row too, not just the list.
export function useReviewsKpis() {
  return useQuery({
    queryKey: ["reviews", "kpis"],
    queryFn: () => apiGet<ReviewsKpis>("/api/reviews/kpis"),
    refetchInterval: 30_000,
  });
}
