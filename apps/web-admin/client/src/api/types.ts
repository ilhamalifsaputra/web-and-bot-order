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

export interface OperationsSummary {
  pendingPayments: number;
  manualReviews: number;
  failedDeliveries: number;
  ordersProcessing: number;
  expiredPayments: number;
}

export interface InventoryRow {
  denominationId: number;
  productName: string;
  available: number;
  threshold: number;
}

export interface ExpirationRow {
  orderId: number;
  orderCode: string;
  productName: string;
  customerLabel: string;
  remainingDays: number;
}

export interface RecentOrderRow {
  orderId: number;
  orderCode: string;
  productLabel: string;
  customerLabel: string;
  amount: string;
  currency: "IDR" | "USDT" | "USD";
  status: string;
  createdAt: string;
}

export type HealthLevel = "green" | "yellow" | "red" | "unmonitored";

export interface HealthStatus {
  telegramBot: HealthLevel;
  binance: HealthLevel;
  bybit: HealthLevel;
  tokopay: HealthLevel;
  paydisini: HealthLevel;
  nowpayments: HealthLevel;
}

export interface TopProductRow {
  productId: number;
  name: string;
  unitsSold: number;
  revenueIdrEquiv: string;
  profitIdrEquiv: string | null;
  costUnknownUnits: number;
}

export type AnalyticsRange = "7d" | "30d";
export type AnalyticsCurrency = "idr" | "usdt" | "combined";
export type AnalyticsMetric = "revenue" | "orders";

export interface AnalyticsPoint {
  day: string; // YYYY-MM-DD
  value: string | number; // string for money series, number for order-count series
}
