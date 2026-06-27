import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { DashboardKpis } from "../api/types";

export function useDashboardKpis() {
  return useQuery({
    queryKey: ["dashboard", "kpis"],
    queryFn: () => apiGet<DashboardKpis>("/api/dashboard/kpis"),
    refetchInterval: 30_000,
  });
}
