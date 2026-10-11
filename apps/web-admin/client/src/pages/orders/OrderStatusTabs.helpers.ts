

export type StatusTabKey = "all" | "awaiting" | "processing" | "delivered" | "cancelled" | "refunded";

export interface StatusTabDef {
  key: StatusTabKey;
  label: string;
  /** Raw order statuses this tab requests (comma-joined for the API's
   *  `status` param). Empty = no status filter ("All"). */
  statuses: string[];
}

/**
 * 6 display buckets over 13 raw statuses (confirmed during planning).
 * "Awaiting" deliberately folds in the raw `PROCESSING` status too — the
 * tab spec only has one "Awaiting" bucket, not a separate "Awaiting
 * Fulfillment" tab, so this tab is coarser than `OrderStatusBadge`'s own
 * bucketing (which keeps them visually distinct via icon). Tabs and badges
 * are allowed to group at different granularities.
 */
export const STATUS_TABS: StatusTabDef[] = [
  { key: "all", label: "All", statuses: [] },
  {
    key: "awaiting",
    label: "Awaiting",
    statuses: ["PENDING_PAYMENT", "PAYMENT_DETECTED", "CONFIRMING", "PENDING_VERIFICATION", "UNDERPAID", "PROCESSING"],
  },
  { key: "processing", label: "Processing", statuses: ["CONFIRMED", "PAID"] },
  { key: "delivered", label: "Delivered", statuses: ["DELIVERED"] },
  { key: "cancelled", label: "Cancelled", statuses: ["CANCELLED", "REJECTED"] },
  { key: "refunded", label: "Refunded", statuses: ["REFUNDED"] },
];

/** Comma-joined raw statuses for a tab, matching the API's `status` param
 *  shape — "" for "All" (no filter). */
export function statusesForTab(key: StatusTabKey): string {
  return STATUS_TABS.find((t) => t.key === key)?.statuses.join(",") ?? "";
}
