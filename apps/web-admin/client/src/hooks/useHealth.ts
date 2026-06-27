import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { HealthStatus } from "../api/types";

export function useHealth() {
  return useQuery({
    queryKey: ["dashboard", "health"],
    queryFn: () => apiGet<HealthStatus>("/api/dashboard/health"),
    refetchInterval: 30_000,
  });
}
