import { ticketStatusLabel } from "@/lib/ticketStatus"

/**
 * Ticket status → color tone mapping. Three statuses collapse to three hues:
 *  - `OPEN` (amber/amberx) — new ticket awaiting first response.
 *  - `REPLIED` (blue/pine) — admin has replied, awaiting customer's next message.
 *  - `CLOSED` (neutral/sand) — ticket resolved.
 * This is a dedicated component, mirroring the pattern of `OrderStatusBadge`
 * for domain-specific status styling.
 */
const TONE_CLASS: Record<string, string> = {
  OPEN: "bg-amberx-tint text-amberx",
  REPLIED: "bg-pine-tint text-pine-dark",
  CLOSED: "bg-sand text-ink-soft",
};

/** Defensive fallback for a status outside the 3 mapped above (shouldn't
 * happen — all are covered — but mirrors `ticketStatusLabel`'s own
 * never-silently-disappear convention). Neutral styling. */
const FALLBACK_TONE = "bg-sand text-ink-soft";

interface TicketStatusBadgeProps {
  status: string;
}

export function TicketStatusBadge({ status }: TicketStatusBadgeProps): JSX.Element {
  const tone = TONE_CLASS[status] ?? FALLBACK_TONE;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {ticketStatusLabel(status)}
    </span>
  )
}
