import type { SupportTicketSummary } from "../../api/types";

export const SUBJECT_MAX = 80;

/** First line of `message`, trimmed and clipped to ~80 chars with an ellipsis. */
export function firstLine(message: string): string {
  const line = (message.split("\n")[0] ?? "").trim();
  return line.length > SUBJECT_MAX ? `${line.slice(0, SUBJECT_MAX).trimEnd()}…` : line;
}

/** The subject to show for a ticket: its own subject, else the message's first line. */
export function subjectOf(ticket: SupportTicketSummary): string {
  return ticket.subject?.trim() || firstLine(ticket.message);
}
