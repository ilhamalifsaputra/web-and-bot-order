import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { TopProductRow } from "../api/types";

export function useTopProducts() {
  return useQuery({
    queryKey: ["dashboard", "top-products"],
    queryFn: () => apiGet<TopProductRow[]>("/api/dashboard/top-products"),
    refetchInterval: 30_000,
  });
}
