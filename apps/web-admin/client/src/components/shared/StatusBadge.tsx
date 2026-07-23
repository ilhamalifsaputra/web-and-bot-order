type Tone = "success" | "warning" | "danger" | "neutral";

const TONE: Record<string, Tone> = {
  DELIVERED: "success",
  PAID: "success",
  MATCHED: "success",
  SENT: "success",
  PENDING_PAYMENT: "warning",
  PAYMENT_DETECTED: "warning",
  CONFIRMING: "warning",
  CONFIRMED: "warning",
  PENDING_VERIFICATION: "warning",
  UNDERPAID: "warning",
  LOW_STOCK: "warning",
  EXPIRING_SOON: "warning",
  UNMATCHED: "warning",
  CANCELLED: "danger",
  REJECTED: "danger",
  FAILED: "danger",
  BANNED: "danger",
  OUT_OF_STOCK: "danger",
  DELIVERY_FAILED: "danger",
  REFUNDED: "neutral",
  DRAFT: "neutral",
  // Settings-page configuration status vocabulary (Settings refinement §4).
  CONFIGURED: "success",
  OPTIONAL: "neutral",
  NOT_CONFIGURED: "warning",
  ERROR: "danger",
  // Flash Sale lifecycle (FlashSalesPage's Flash Status/Status columns).
  LIVE: "success",
  SCHEDULED: "warning",
  ENDED: "neutral",
  // NotificationStatus (OutboxPage) — align PENDING/SENDING with the same
  // warning tone PENDING_PAYMENT already gets, instead of falling back to neutral.
  PENDING: "warning",
  SENDING: "warning",
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
