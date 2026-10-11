/**
 * Merges a ticket's own opening message, its legacy single `admin_reply`
 * field (older tickets replied-to before the TicketMessage thread existed),
 * the message thread, and synthetic Created/Closed events into one
 * chronological feed for TicketMessageThread to render.
 *
 * Every `created_at_display` the server sends is pre-formatted
 * "yyyy-LL-dd HH:mm" (shop timezone, zero-padded) — that format sorts
 * correctly as a plain string, so no separate ISO/epoch field is needed just
 * to order the merged feed.
 */
import type { TicketMessage } from "../api/types";

export interface SystemTimelineEvent {
  id: string;
  kind: "system";
  key: "created" | "closed";
  labelKey: string;
  created_at_display: string;
}

export interface MessageTimelineEntry {
  id: string;
  kind: "message";
  from_user: boolean;
  content: string;
  created_at_display: string;
  attachments: string[];
}

export type TicketTimelineEntry = SystemTimelineEvent | MessageTimelineEntry;

export interface TicketTimelineInput {
  id: number;
  message: string;
  created_at_display: string;
  admin_reply: string | null;
  replied_at_display: string | null;
  closed_at_display: string | null;
  attachments: string[];
}

export function buildTicketTimeline(ticket: TicketTimelineInput, messages: TicketMessage[]): TicketTimelineEntry[] {
  const entries: TicketTimelineEntry[] = [
    { id: `ticket:${ticket.id}:created`, kind: "system", key: "created", labelKey: "web.ticket_event_created", created_at_display: ticket.created_at_display },
    {
      kind: "message",
      id: `ticket:${ticket.id}:opening`,
      from_user: true,
      content: ticket.message,
      created_at_display: ticket.created_at_display,
      attachments: ticket.attachments,
    },
    ...messages.map(
      (m): TicketTimelineEntry => ({
        kind: "message",
        id: `message:${m.id}`,
        from_user: m.from_user,
        content: m.content,
        created_at_display: m.created_at_display,
        attachments: m.attachments,
      }),
    ),
  ];
  if (ticket.admin_reply) {
    entries.push({
      kind: "message",
      id: `ticket:${ticket.id}:legacy-reply`,
      from_user: false,
      content: ticket.admin_reply,
      created_at_display: ticket.replied_at_display ?? ticket.created_at_display,
      attachments: [],
    });
  }
  if (ticket.closed_at_display) {
    entries.push({
      kind: "system",
      id: `ticket:${ticket.id}:closed`,
      key: "closed",
      labelKey: "web.ticket_event_closed",
      created_at_display: ticket.closed_at_display,
    });
  }
  return entries.sort((a, b) => a.created_at_display.localeCompare(b.created_at_display));
}
