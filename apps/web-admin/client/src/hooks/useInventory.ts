import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { InventoryRow } from "../api/types";

export function useInventory() {
  return useQuery({
    queryKey: ["dashboard", "inventory"],
    queryFn: () => apiGet<InventoryRow[]>("/api/dashboard/inventory"),
    refetchInterval: 30_000,
  });
}
