type Tone = "success" | "warning" | "danger" | "neutral";

const TONE: Record<string, Tone> = {
  DELIVERED: "success",
  PAID: "success",
  MATCHED: "success",
  SENT: "success",
  RETURNING: "success",
  PENDING_PAYMENT: "warning",
  PAYMENT_DETECTED: "warning",
  CONFIRMING: "warning",
  CONFIRMED: "warning",
  PENDING_VERIFICATION: "warning",
  UNDERPAID: "warning",
  LOW_STOCK: "warning",
  IN_STOCK: "success",
  EXPIRING_SOON: "warning",
  UNMATCHED: "warning",
  CANCELLED: "danger",
  REJECTED: "danger",
  FAILED: "danger",
  BANNED: "danger",
  NEW_CUSTOMER: "success",
  OUT_OF_STOCK: "danger",
  DELIVERY_FAILED: "danger",
  REFUNDED: "neutral",
  DRAFT: "neutral",
  // Settings-page configuration status vocabulary (Settings refinement §4).
  CONFIGURED: "success",
  OPTIONAL: "neutral",
  NOT_CONFIGURED: "warning",
  ERROR: "danger",
  // Flash Sale lifecycle (FlashSalesPage's Flash Status column).
  RUNNING: "success",
  SCHEDULED: "warning",
  EXPIRED: "neutral",
  INACTIVE: "neutral",
  // Voucher lifecycle (VouchersPage's Voucher Status column).
  ACTIVE: "success",
  DISABLED: "neutral",
  USAGE_LIMIT_REACHED: "warning",
  // NotificationStatus (OutboxPage) — align PENDING/SENDING with the same
  // warning tone PENDING_PAYMENT already gets, instead of falling back to neutral.
  PENDING: "warning",
  SENDING: "warning",
  // Binance ledger outcome (PaymentsPage) — money successfully resolved to
  // the buyer's credit balance, per docs/superpowers/specs/2026-06-16-dual-credit-balance-design.md.
  CREDITED_TO_BALANCE: "success",
  // TicketStatus (Tickets page) — OPEN/REPLIED need attention, RESOLVED is done,
  // CLOSED already falls back to neutral but is listed explicitly for clarity.
  OPEN: "warning",
  REPLIED: "neutral",
  RESOLVED: "success",
  CLOSED: "neutral",
  // TicketPriority (Tickets page) — only HIGH/URGENT are visually flagged.
  LOW: "neutral",
  MEDIUM: "neutral",
  HIGH: "warning",
  URGENT: "danger",
  // ReviewStatus / ReviewSentiment (Reviews dashboard, Phase A) — REPLIED and
  // CLOSED already fall back to neutral; NEUTRAL sentiment falls back to
  // neutral too, so only the tone-bearing values need an explicit entry.
  PENDING_REPLY: "warning",
  HIDDEN: "danger",
  POSITIVE: "success",
  NEGATIVE: "danger",
};

const TONE_CLASS: Record<Tone, string> = {
  success: "bg-grass-tint text-grass-dark",
  warning: "bg-amberx-tint text-amberx",
  danger: "bg-rust-tint text-rust-dark",
  neutral: "bg-sand text-ink-soft",
};

function titleCase(status: string): string {
  return status
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function StatusBadge({ status }: { status: string }) {
  const tone = TONE[status] ?? "neutral";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]}`}>
      {titleCase(status)}
    </span>
  );
}
