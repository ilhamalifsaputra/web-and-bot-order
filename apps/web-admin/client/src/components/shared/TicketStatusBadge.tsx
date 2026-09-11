import { ticketStatusLabel } from "@/lib/ticketStatus"

/**
 * Ticket status → color tone mapping. Six statuses collapse to four hues
 * (Task 1 fix: WAITING_ADMIN/WAITING_CUSTOMER are now live values a
 * ticket's status column can hold — see TicketStatus's own doc comment,
 * @app/core/enums — sharing OPEN's/REPLIED's tone since they mean the same
 * thing to an admin reading this badge):
 *  - `OPEN`/`WAITING_ADMIN` (amber/amberx) — awaiting an admin's response.
 *  - `REPLIED`/`WAITING_CUSTOMER` (blue/pine) — admin has replied, awaiting
 *    the customer's next message.
 *  - `RESOLVED` (green/grass) — admin marked it resolved; still reopenable.
 *  - `CLOSED` (neutral/sand) — ticket closed.
 * This is a dedicated component, mirroring the pattern of `OrderStatusBadge`
 * for domain-specific status styling.
 */
const TONE_CLASS: Record<string, string> = {
  OPEN: "bg-amberx-tint text-amberx",
  WAITING_ADMIN: "bg-amberx-tint text-amberx",
  REPLIED: "bg-pine-tint text-pine-dark",
  WAITING_CUSTOMER: "bg-pine-tint text-pine-dark",
  RESOLVED: "bg-grass-tint text-grass-dark",
  CLOSED: "bg-sand text-ink-soft",
};

/** Defensive fallback for a status outside the 6 mapped above (shouldn't
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
