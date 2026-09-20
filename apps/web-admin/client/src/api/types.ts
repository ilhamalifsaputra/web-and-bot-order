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
    /** % vs the same clock time yesterday; null when yesterday's base is zero or too small to compare against. */
    trendPct: { idr: string | null; usdt: string | null };
  };
  /** Refunds actually paid out today, per currency — COMPLETED
   *  RefundExecution.amount, the real payout figure, never the Refund request's
   *  amount. `null` means none (same null-when-zero convention as `revenue`). */
  refunds: { idr: string | null; usdt: string | null };
  /** Today's gross sales (`revenue` above) minus today's `refunds`, per
   *  currency. Never clamped at zero: a refund may be for an order sold on an
   *  earlier day, so this can legitimately be negative and must render as such. */
  netSales: { idr: string | null; usdt: string | null };
  profit: { idr: CurrencyProfit | null; usdt: CurrencyProfit | null };
  /** Product orders created today. `other` (paid/processing/refunded/expired/...) is
   * everything the other three skip, so the four parts sum to `total`. */
  orders: { total: number; delivered: number; pending: number; failed: number; other: number };
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

/** One rail's health verdict, computed server-side by `evaluatePollHealth`
 * (packages/core/src/payments/pollHealth.ts) — the client only renders it, it
 * never re-derives `status` from raw heartbeat fields itself. `detail` is the
 * human-readable reason behind `status` (e.g. why a rail reads
 * "unmonitored" — disabled vs. no heartbeat recorded yet vs. never
 * configured). */
export interface HealthEntry {
  status: HealthLevel;
  detail: string;
}

export interface HealthStatus {
  telegramBot: HealthEntry;
  binance: HealthEntry;
  bybit: HealthEntry;
  bybitBsc: HealthEntry;
  tokopay: HealthEntry;
  paydisini: HealthEntry;
  nowpayments: HealthEntry;
  digiflazzCatalogSync: HealthEntry;
}

export interface TopProductRow {
  productId: number;
  productLabel: string;
  unitsSold: number;
  revenueIdrEquiv: string;
  profitIdrEquiv: string | null;
  costUnknownUnits: number;
}

/** Mirrors the shape pushed by GET /api/dashboard/digiflazz-sync/stream (and
 * returned by getDigiflazzSyncStatus, Task 3) — the hourly catalog resync's
 * last-run outcome. `null` (not this type) means no Settings row exists yet,
 * i.e. the shop has never synced. */
export interface DigiflazzSyncStatus {
  status: "success" | "aborted" | "error";
  updated: number;
  deactivated: number;
  abortReason: "sharp_change" | "no_usable_rows" | null;
  finishedAt: string;
}

/** `7d`/`30d` are rolling daily windows; `week`/`month`/`year` are calendar
 *  rollups (Financial Ledger M6, Task 6c) — 12 ISO weeks, 12 calendar months or
 *  5 calendar years, all UTC-bounded. */
export type AnalyticsRange = "7d" | "30d" | "week" | "month" | "year";
export type AnalyticsCurrency = "idr" | "usdt" | "combined";
export type AnalyticsMetric = "revenue" | "orders" | "profit";

export interface AnalyticsPoint {
  /** The bucket label: `2026-06-25` for a daily series, `2026-W38` / `2026-09` /
   *  `2026` for the calendar ranges. One field for every granularity, so the
   *  chart's `dataKey="day"` needs no per-range branching. */
  day: string;
  /** String for money series, number for order counts, and `null` for a profit
   *  bucket with no cost-known delivered sale — an unknown profit, which must be
   *  drawn as a gap and never coerced to a zero that reads like break-even. */
  value: string | number | null;
}
