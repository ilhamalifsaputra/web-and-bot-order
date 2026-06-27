import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { OperationsSummary } from "../api/types";

export function useOperations() {
  return useQuery({
    queryKey: ["dashboard", "operations"],
    queryFn: () => apiGet<OperationsSummary>("/api/dashboard/operations"),
    refetchInterval: 30_000,
  });
}
