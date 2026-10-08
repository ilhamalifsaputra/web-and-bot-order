/**
 * Human-readable labels for support ticket status enum values
 * (SCREAMING_SNAKE_CASE, e.g. `OPEN`, `REPLIED`, `CLOSED`). Shared across
 * any page that needs to render a ticket status to an admin.
 */
// Task 1 fix (backend): WAITING_ADMIN/WAITING_CUSTOMER are now live values a
// ticket's status column can hold (see TicketStatus's own doc comment,
// @app/core/enums). REPLIED means the same as WAITING_CUSTOMER to an admin
// (the ball is in the customer's court), so they share a label.
export const TICKET_STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  WAITING_ADMIN: "Waiting for admin",
  REPLIED: "Waiting for customer",
  WAITING_CUSTOMER: "Waiting for customer",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

/** Human-readable label for a raw ticket status; falls back to the raw value
 * for any status not in the map (e.g. an enum value added on the backend
 * before this map is updated), so nothing silently disappears. */
export function ticketStatusLabel(status: string): string {
  return TICKET_STATUS_LABELS[status] ?? status;
}
