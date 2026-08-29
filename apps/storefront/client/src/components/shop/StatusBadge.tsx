import { t } from "../../lib/i18n";

/**
 * TSX port of `status_badge(value)` in packages/web-ui/views/_macros.njk —
 * the order/stock/ticket status chip used by orders.njk, order_detail.njk,
 * support.njk and ticket_detail.njk (list-view chips only — the ticket
 * detail page's own chip is TicketStatusBadge, which keeps its friendlier
 * ticket-specific copy and is not touched here).
 *
 * Labels route through t() so they follow <html lang>. Where an existing
 * key already carried the exact English wording below, it's reused
 * (status.label.* — the bot/web-shared coarse OrderStatus labels — and
 * web.order_processing_title); everything else is a new web.status_chip_*
 * key. Deliberately NOT reusing web.ticket_status_open/replied/closed:
 * those carry ticket-flavoured copy ("Waiting for Support") chosen for the
 * ticket detail page, and this component also renders non-ticket statuses
 * (orders, stock) where that wording would be wrong.
 */
const STATUS_LABEL_KEY: Record<string, string> = {
  delivered: "status.label.delivered",
  // Unreachable today (see OrderStatus.PARTIALLY_DELIVERED in @app/core/enums),
  // but mapped anyway: without a key the fallback title-cases the raw value,
  // which would render untranslated English to an Indonesian buyer. Toned
  // AMBER rather than GRASS — part of the order did not arrive, so it must not
  // look like a clean success.
  partially_delivered: "status.label.partially_delivered",
  paid: "status.label.paid",
  available: "web.status_chip_available",
  active: "web.status_chip_active",
  closed: "web.status_chip_closed",
  sent: "web.status_chip_sent",
  matched: "web.status_chip_matched",
  pending_verification: "web.status_chip_pending_verification",
  reserved: "web.status_chip_reserved",
  processing: "web.order_processing_title",
  open: "web.status_chip_open",
  // Phase C whole-branch review fix: the real live values a ticket takes
  // after its first reply (Task 1's automatic WAITING_ADMIN/WAITING_CUSTOMER
  // transition) — without these, the fallback title-cases the raw enum
  // ("Waiting Admin") in untranslated English and drops out of the AMBER
  // tone set below into neutral sand.
  waiting_admin: "web.status_chip_open",
  replied: "web.status_chip_replied",
  waiting_customer: "web.status_chip_replied",
  pending: "web.status_chip_pending",
  pending_payment: "web.status_chip_pending_payment",
  underpaid: "web.status_chip_underpaid",
  cancelled: "web.status_chip_cancelled",
  rejected: "web.status_chip_rejected",
  refunded: "status.label.refunded",
  dead: "web.status_chip_dead",
  failed: "status.label.failed",
  unmatched: "web.status_chip_unmatched",
  credited_to_balance: "web.status_chip_credited_to_balance",
};

const GRASS = new Set(["delivered", "paid", "available", "active", "closed", "sent", "matched", "credited_to_balance"]);
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
]);
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
  const key = STATUS_LABEL_KEY[v];
  const label = key ? t(key) : titleCase(v.replace(/_/g, " "));
  return <span className={`chip ${toneClass}`}>{label}</span>;
}
