import { ticketPriorityLabel } from "@/lib/ticketPriority"

/**
 * Ticket priority → color tone mapping. Four priorities collapse to four hues:
 *  - `URGENT` (red/rust) — critical, requires immediate attention.
 *  - `HIGH` (amber/amberx) — important, should be addressed soon.
 *  - `MEDIUM` (blue/pine, baseline/default) — normal priority, neutral-but-branded.
 *  - `LOW` (neutral/sand) — can be addressed when capacity allows.
 * This is a dedicated component, mirroring the pattern of `OrderStatusBadge`
 * for domain-specific priority styling.
 */
const TONE_CLASS: Record<string, string> = {
  URGENT: "bg-rust-tint text-rust-dark",
  HIGH: "bg-amberx-tint text-amberx",
  MEDIUM: "bg-pine-tint text-pine-dark",
  LOW: "bg-sand text-ink-soft",
};

/** Defensive fallback for a priority outside the 4 mapped above (shouldn't
 * happen — all are covered — but mirrors `ticketPriorityLabel`'s own
 * never-silently-disappear convention). Neutral styling. */
const FALLBACK_TONE = "bg-sand text-ink-soft";

interface TicketPriorityBadgeProps {
  priority: string;
}

export function TicketPriorityBadge({ priority }: TicketPriorityBadgeProps): JSX.Element {
  const tone = TONE_CLASS[priority] ?? FALLBACK_TONE;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {ticketPriorityLabel(priority)}
    </span>
  )
}
