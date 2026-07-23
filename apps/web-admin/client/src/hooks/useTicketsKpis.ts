import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";

export interface TicketsKpis {
  open: number;
  waitingCustomer: number;
  resolved: number;
  unassigned: number;
  closedToday: number;
  overdue: number;
}

/** Global snapshot for the Tickets page's KPI row — deliberately ignores
 *  whatever list filters are active (same "whole-queue snapshot" convention
 *  as /api/orders/kpis / useOrdersKpis). */
export function useTicketsKpis() {
  return useQuery({
    queryKey: ["support", "kpis"],
    queryFn: () => apiGet<TicketsKpis>("/api/support/kpis"),
    refetchInterval: 30_000,
  });
}
