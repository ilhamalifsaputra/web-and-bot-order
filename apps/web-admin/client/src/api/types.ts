export interface CurrencyProfit {
  netProfit: string;
  marginPct: string | null;
  excludedItemCount: number;
}

export interface DashboardKpis {
  revenue: {
    idr: string | null;
    usdt: string | null;
    usd: string | null;
    trendPct: { idr: string | null; usdt: string | null };
  };
  profit: { idr: CurrencyProfit | null; usdt: CurrencyProfit | null };
  orders: { total: number; delivered: number; pending: number; failed: number };
  pendingActions: {
    toReview: number;
    refundDecisions: number;
    failedDeliveries: number;
    manualApprovals: number;
  };
}
