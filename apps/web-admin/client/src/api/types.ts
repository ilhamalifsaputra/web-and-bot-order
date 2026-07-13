/** One admin-defined custom checkout field for a manual_with_info SKU — JSON
 * twin of AdditionalField (packages/core/src/deliveryFields.ts). Defined
 * locally rather than cross-imported: this client mirrors server-side shapes
 * elsewhere too (e.g. this file's other JSON-response twins), so this follows
 * that established convention instead of taking @app/core as a runtime
 * client dependency (@app/web-admin-client's package.json does not depend on
 * @app/core — same "mirror don't cross-import" reasoning the storefront
 * client's api/types.ts already documents for its own AdditionalField). */
export interface AdditionalField {
  key: string;
  label: { id: string; en: string };
  type: "text" | "email" | "number" | "url" | "select";
  required: boolean;
  options: string[];
  placeholder: string;
}

/** In-progress draft of an AdditionalField as edited in the admin form —
 * `key`/`label.id`/`label.en`/`options` are free-typed text the admin may
 * still be mid-edit (e.g. an empty key, an options textarea not yet split
 * into an array), so this is intentionally looser than AdditionalField
 * itself. AdditionalFieldsEditor is the controlled component that owns this
 * shape; the page components convert to real AdditionalField[] on submit. */
export interface AdditionalFieldDraft {
  key: string;
  labelId: string;
  labelEn: string;
  type: "text" | "email" | "number" | "url" | "select";
  required: boolean;
  optionsText: string;
  placeholder: string;
}

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
  /** Manual/manual_with_info orders paid and awaiting an admin to hand-fulfill
   * (status PROCESSING). Distinct from `ordersProcessing`, which counts the
   * unrelated legacy CONFIRMED/PAID payment-gateway metric. */
  awaitingFulfillment: number;
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
  createdAtDisplay: string | null;
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
