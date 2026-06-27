import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { RecentOrderRow } from "../api/types";

export function useRecentOrders() {
  return useQuery({
    queryKey: ["dashboard", "recent-orders"],
    queryFn: () => apiGet<RecentOrderRow[]>("/api/dashboard/orders/recent"),
    refetchInterval: 30_000,
  });
}
