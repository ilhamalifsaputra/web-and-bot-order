/**
 * TSX port of `status_badge(value)` in packages/web-ui/views/_macros.njk —
 * the order/ticket status chip used by orders.njk, order_detail.njk,
 * support.njk and ticket_detail.njk. The macro's labels are plain English
 * words hardcoded in the NJK itself (no `t()` call, so they don't change
 * with `lang`) — ported verbatim, unknown values still get NJK's
 * `replace('_', ' ') | title` fallback.
 */
const STATUS_LABELS: Record<string, string> = {
  delivered: "Delivered",
  paid: "Paid",
  available: "In stock",
  active: "Active",
  closed: "Closed",
  sent: "Sent",
  matched: "Matched",
  pending_verification: "Awaiting check",
  reserved: "Reserved",
  open: "Open",
  replied: "Replied",
  pending: "Waiting",
  pending_payment: "Awaiting payment",
  underpaid: "Paid too little",
  cancelled: "Cancelled",
  rejected: "Rejected",
  refunded: "Refunded",
  dead: "Used up",
  failed: "Failed",
  unmatched: "Unmatched",
  credited_to_balance: "Added to credit balance",
};

const GRASS = new Set(["delivered", "paid", "available", "active", "closed", "sent", "matched", "credited_to_balance"]);
const AMBER = new Set(["pending_verification", "reserved", "open", "replied", "pending", "underpaid"]);
const PINE = new Set(["pending_payment"]);
const RUST = new Set(["cancelled", "rejected", "refunded", "dead", "failed", "unmatched"]);

function titleCase(value: string): string {
  return value
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export interface StatusBadgeProps {
  value: string;
}

export default function StatusBadge({ value }: StatusBadgeProps) {
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
  const label = STATUS_LABELS[v] ?? titleCase(v.replace(/_/g, " "));
  return <span className={`chip ${toneClass}`}>{label}</span>;
}
