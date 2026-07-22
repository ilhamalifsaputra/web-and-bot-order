import type { LucideIcon } from "lucide-react"
import { Clock, RefreshCw, PackageSearch, CheckCircle2, XCircle, Undo2, AlertTriangle, Circle } from "lucide-react"
import { orderStatusLabel } from "@/lib/orderStatus"

interface BucketStyle {
  icon: LucideIcon;
  className: string;
}

/**
 * 13 raw order statuses (`packages/core/src/enums.ts` `OrderStatus`,
 * hardcoded as string literals per this codebase's "client mirrors, never
 * cross-imports `@app/core` enums" convention — see `lib/orderStatus.ts`)
 * collapse to 6 display buckets, confirmed during planning. Only 5 hue
 * tokens exist in the design system, so two bucket pairs deliberately share
 * a hue and are differentiated by icon (and label) alone:
 *  - `PROCESSING` (raw status, "Awaiting Fulfillment") shares amber with the
 *    payment-side "Awaiting" bucket — it's a manual-fulfillment queue, not a
 *    payment wait, so it gets its own icon.
 *  - `CANCELLED`/`REJECTED` ("Cancelled") and `FAILED` ("Failed") share
 *    rust — both are terminal-negative outcomes, differentiated by icon.
 * This is a dedicated component, not an extension of the generic
 * cross-domain `StatusBadge` (shared with stock/other taxonomies) — see
 * the Orders refactor plan for why conflating the two was rejected.
 */
const BUCKET_STYLE: Record<string, BucketStyle> = {
  // Awaiting (payment side) — amber, Clock icon.
  PENDING_PAYMENT: { icon: Clock, className: "bg-amberx-tint text-amberx" },
  PAYMENT_DETECTED: { icon: Clock, className: "bg-amberx-tint text-amberx" },
  CONFIRMING: { icon: Clock, className: "bg-amberx-tint text-amberx" },
  PENDING_VERIFICATION: { icon: Clock, className: "bg-amberx-tint text-amberx" },
  UNDERPAID: { icon: Clock, className: "bg-amberx-tint text-amberx" },

  // Processing (auto-settling) — blue/pine, RefreshCw icon.
  CONFIRMED: { icon: RefreshCw, className: "bg-pine-tint text-pine-dark" },
  PAID: { icon: RefreshCw, className: "bg-pine-tint text-pine-dark" },

  // Awaiting Fulfillment (manual hand-delivery queue) — amber, different icon.
  PROCESSING: { icon: PackageSearch, className: "bg-amberx-tint text-amberx" },

  // Delivered — green/grass.
  DELIVERED: { icon: CheckCircle2, className: "bg-grass-tint text-grass-dark" },

  // Cancelled — red/rust.
  CANCELLED: { icon: XCircle, className: "bg-rust-tint text-rust-dark" },
  REJECTED: { icon: XCircle, className: "bg-rust-tint text-rust-dark" },

  // Refunded — neutral gray/sand.
  REFUNDED: { icon: Undo2, className: "bg-sand text-ink-soft" },

  // Failed — red/rust, different icon from Cancelled.
  FAILED: { icon: AlertTriangle, className: "bg-rust-tint text-rust-dark" },
};

/** Defensive fallback for a status outside the 13 mapped above (shouldn't
 * happen — all are covered — but mirrors `orderStatusLabel`'s own
 * never-silently-disappear convention). Neutral styling, generic icon. */
const FALLBACK_STYLE: BucketStyle = { icon: Circle, className: "bg-sand text-ink-soft" };

interface OrderStatusBadgeProps {
  status: string;
}

export function OrderStatusBadge({ status }: OrderStatusBadgeProps): JSX.Element {
  const style = BUCKET_STYLE[status] ?? FALLBACK_STYLE;
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${style.className}`}>
      <Icon className="h-3 w-3" />
      {orderStatusLabel(status)}
    </span>
  )
}
