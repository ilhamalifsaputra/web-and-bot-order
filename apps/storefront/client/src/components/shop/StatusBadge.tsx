import type { OrderFulfillment } from "../../api/types";
import { fulfillmentPresentation } from "../../lib/orderFulfillment";
import { statusLabel } from "./StatusBadge.helpers";

const GRASS = new Set(["delivered", "paid", "available", "active", "closed", "sent", "matched", "credited_to_balance", "completed"]);
const AMBER = new Set([
  "pending_verification",
  "reserved",
  "open",
  "waiting_admin",
  "replied",
  "waiting_customer",
  "pending",
  "underpaid",
  "processing",
  "partially_delivered",
  "under_review",
  "automatic_processing",
]);
const PINE = new Set(["pending_payment", "waiting_payment"]);
const RUST = new Set(["cancelled", "rejected", "refunded", "dead", "failed", "unmatched"]);

export interface StatusBadgeProps {
  value: string;
  fulfillment?: OrderFulfillment;
}

export default function StatusBadge({ value, fulfillment }: StatusBadgeProps) {
  if (fulfillment && !["credited_to_balance", "underpaid", "pending_verification", "partially_delivered"].includes(value.toLowerCase())) {
    const badge = fulfillmentPresentation(fulfillment).badge;
    value = badge === "processing" && fulfillment.mode === "AUTO" ? "automatic_processing" : badge;
  }
  const v = String(value).toLowerCase();
  const toneClass = GRASS.has(v)
    ? "bg-grass-tint text-grass-dark"
    : AMBER.has(v)
      ? "bg-amberx-tint text-amberx"
      : PINE.has(v)
        ? "bg-pine-tint text-pine-dark"
        : RUST.has(v)
          ? "bg-rust-tint text-rust-dark"
          : "bg-sand text-ink-soft";
  return <span className={`chip ${toneClass}`}>{statusLabel(value)}</span>;
}
