/** Per-ticket reply draft autosave, so a customer who navigates away (or a
 * tab crash) doesn't lose an in-progress reply. localStorage failures
 * (private browsing, quota) are swallowed — draft autosave is a convenience,
 * never worth breaking the reply flow over. */
const PREFIX = "ticket-draft:";

export function loadTicketDraft(ticketId: number): string {
  try {
    return localStorage.getItem(PREFIX + ticketId) ?? "";
  } catch {
    return "";
  }
}

export function saveTicketDraft(ticketId: number, value: string): void {
  try {
    if (value.trim()) localStorage.setItem(PREFIX + ticketId, value);
    else localStorage.removeItem(PREFIX + ticketId);
  } catch {
    // see file header comment
  }
}

export function clearTicketDraft(ticketId: number): void {
  try {
    localStorage.removeItem(PREFIX + ticketId);
  } catch {
    // see file header comment
  }
}
