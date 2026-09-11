/**
 * Human-readable labels for support ticket status enum values
 * (SCREAMING_SNAKE_CASE, e.g. `OPEN`, `REPLIED`, `CLOSED`). Shared across
 * any page that needs to render a ticket status to an admin.
 */
// Task 1 fix (backend): WAITING_ADMIN/WAITING_CUSTOMER are now live values a
// ticket's status column can hold (see TicketStatus's own doc comment,
// @app/core/enums) — labeled under the same bucket as their OPEN/REPLIED
// counterpart, since they mean the same thing to an admin reading this page.
export const TICKET_STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  WAITING_ADMIN: "Open",
  REPLIED: "Waiting Customer",
  WAITING_CUSTOMER: "Waiting Customer",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

/** Human-readable label for a raw ticket status; falls back to the raw value
 * for any status not in the map (e.g. an enum value added on the backend
 * before this map is updated), so nothing silently disappears. */
export function ticketStatusLabel(status: string): string {
  return TICKET_STATUS_LABELS[status] ?? status;
}
