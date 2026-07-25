/**
 * Human-readable labels for support ticket priority enum values
 * (SCREAMING_SNAKE_CASE, e.g. `LOW`, `MEDIUM`, `HIGH`, `URGENT`).
 * Shared across any page that needs to render a ticket priority to an admin.
 */
export const TICKET_PRIORITY_LABELS: Record<string, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

/** Human-readable label for a raw ticket priority; falls back to the raw value
 * for any priority not in the map (e.g. an enum value added on the backend
 * before this map is updated), so nothing silently disappears. */
export function ticketPriorityLabel(priority: string): string {
  return TICKET_PRIORITY_LABELS[priority] ?? priority;
}

/** Priority order for sorting (highest to lowest precedence). Used for client-side
 * sorting in the support tickets table — admins may sort by priority to focus on
 * urgent/high-priority tickets first. */
export const TICKET_PRIORITY_ORDER = ["URGENT", "HIGH", "MEDIUM", "LOW"];
