import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";

export interface CustomersKpis {
  totalCustomers: number;
  newToday: number;
  activeToday: number;
  returningCustomers: number;
  totalRevenue: { idr: string | null; usdt: string | null };
}

export function useCustomersKpis() {
  return useQuery({
    queryKey: ["users", "kpis"],
    queryFn: () => apiGet<CustomersKpis>("/api/users/kpis"),
    refetchInterval: 30_000,
  });
}
