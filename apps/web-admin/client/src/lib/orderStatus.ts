/**
 * Human-readable labels for backend order status enum values
 * (SCREAMING_SNAKE_CASE, e.g. `PENDING_VERIFICATION`). Shared across any
 * page that needs to render an order status to an admin — currently the
 * Orders status filter dropdown (`OrdersPage.tsx`); `StatusBadge` already
 * title-cases raw status strings for the table/detail badge, but keeping an
 * explicit map here means a status's label can be tuned independently of
 * generic title-casing without hunting down every call site.
 */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: "Pending Payment",
  PAYMENT_DETECTED: "Payment Detected",
  CONFIRMING: "Confirming",
  CONFIRMED: "Confirmed",
  PENDING_VERIFICATION: "Pending Verification",
  PAID: "Paid",
  PROCESSING: "Processing",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  REJECTED: "Rejected",
  REFUNDED: "Refunded",
  UNDERPAID: "Underpaid",
  FAILED: "Failed",
};

/** Human-readable label for a raw order status; falls back to the raw value
 * for any status not in the map (e.g. an enum value added on the backend
 * before this map is updated), so nothing silently disappears. */
export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}
