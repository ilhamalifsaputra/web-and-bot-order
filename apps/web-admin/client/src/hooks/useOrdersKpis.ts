import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";

export interface OrdersKpis {
  totalOrders: number;
  revenueToday: { idr: string | null; usdt: string | null; usd: string | null };
  /** Status PROCESSING — paid, awaiting manual hand-delivery. */
  awaitingFulfillment: number;
  /** Status CONFIRMED/PAID — payment confirming/confirmed, auto-settling. */
  processing: number;
  delivered: number;
  /** Status CANCELLED + REJECTED, folded together. */
  cancelled: number;
}

/** Global snapshot for the Orders page's KPI row and status-tab count badges
 *  — deliberately ignores whatever list filters/tab are active (confirmed
 *  decision, see the Orders refactor plan). */
export function useOrdersKpis() {
  return useQuery({
    queryKey: ["orders", "kpis"],
    queryFn: () => apiGet<OrdersKpis>("/api/orders/kpis"),
    refetchInterval: 30_000,
  });
}
