/**
 * Human-readable labels for support ticket status enum values
 * (SCREAMING_SNAKE_CASE, e.g. `OPEN`, `REPLIED`, `CLOSED`). Shared across
 * any page that needs to render a ticket status to an admin.
 */
export const TICKET_STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  REPLIED: "Waiting Customer",
  CLOSED: "Closed",
};

/** Human-readable label for a raw ticket status; falls back to the raw value
 * for any status not in the map (e.g. an enum value added on the backend
 * before this map is updated), so nothing silently disappears. */
export function ticketStatusLabel(status: string): string {
  return TICKET_STATUS_LABELS[status] ?? status;
}
