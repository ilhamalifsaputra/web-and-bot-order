import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { ExpirationRow } from "../api/types";

export function useExpirations() {
  return useQuery({
    queryKey: ["dashboard", "expirations"],
    queryFn: () => apiGet<ExpirationRow[]>("/api/dashboard/expirations"),
    refetchInterval: 30_000,
  });
}
