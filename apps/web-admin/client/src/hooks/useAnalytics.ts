import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { AnalyticsCurrency, AnalyticsMetric, AnalyticsPoint, AnalyticsRange } from "../api/types";

export function useAnalytics(range: AnalyticsRange, currency: AnalyticsCurrency, metric: AnalyticsMetric) {
  return useQuery({
    queryKey: ["dashboard", "analytics", range, currency, metric],
    queryFn: () =>
      apiGet<AnalyticsPoint[]>(
        `/api/dashboard/analytics?range=${range}&currency=${currency}&metric=${metric}`,
      ),
    refetchInterval: 30_000,
  });
}
