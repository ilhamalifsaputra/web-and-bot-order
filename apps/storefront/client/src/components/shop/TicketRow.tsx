/**
 * One ticket in the /help "My tickets" list, in both layouts:
 *   - `TicketTableRow` — a `<tr>` for the desktop `.data-table`.
 *   - `TicketCard`     — a full-width `<button>` card for the mobile stack.
 *
 * They share the same `{ ticket, onSelect, selected }` contract and the
 * `subjectOf` helper. Kept in one file because the two are the same row in two
 * skins (see OrdersPage.tsx / SupportPage.tsx for the table-vs-cards split this
 * follows).
 *
 * A `<tr>` cannot itself be a button, so the desktop row uses `onClick` on the
 * `<tr>` for pointer users plus a real focusable `<button>` on the `#TK-…`
 * cell — that button carries the row's accessible name and gives keyboard
 * users a genuine Enter/Space target. `e.stopPropagation()` on it keeps the
 * two handlers from both firing.
 */
import { ChevronRight } from "lucide-react";
import { t } from "../../lib/i18n";
import { formatRelativeTime } from "../../lib/formatRelativeTime";
import type { SupportTicketSummary } from "../../api/types";
import TicketStatusBadge from "./TicketStatusBadge";

const SUBJECT_MAX = 80;

/** First line of `message`, trimmed and clipped to ~80 chars with an ellipsis. */
function firstLine(message: string): string {
  const line = (message.split("\n")[0] ?? "").trim();
  return line.length > SUBJECT_MAX ? `${line.slice(0, SUBJECT_MAX).trimEnd()}…` : line;
}

/** The subject to show for a ticket: its own subject, else the message's first line. */
export function subjectOf(ticket: SupportTicketSummary): string {
  return ticket.subject?.trim() || firstLine(ticket.message);
}

export interface TicketRowProps {
  ticket: SupportTicketSummary;
  onSelect: (id: number) => void;
  selected?: boolean;
}

const ticketRef = (id: number): string => `#TK-${id}`;

export function TicketTableRow({ ticket, onSelect, selected }: TicketRowProps) {
  const label = t("web.help_ticket_row_label", { id: ticketRef(ticket.id) });
  return (
    <tr
      onClick={() => onSelect(ticket.id)}
      aria-current={selected ? "true" : undefined}
      className={`cursor-pointer transition-colors hover:bg-sand/40 ${
        selected ? "bg-pine-tint/40 ring-1 ring-inset ring-pine" : ""
      }`}
    >
      <td>
        <button
          type="button"
          className="link"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(ticket.id);
          }}
        >
          {ticketRef(ticket.id)}
        </button>
        {ticket.order_code && (
          <span className="block text-xs text-ink-faint">Order #{ticket.order_code}</span>
        )}
      </td>
      <td className="max-w-[22rem] truncate text-sm text-ink">{subjectOf(ticket)}</td>
      <td>
        <TicketStatusBadge value={ticket.status} />
      </td>
      <td className="text-xs text-ink-soft">{formatRelativeTime(ticket.updated_at_iso)}</td>
      <td className="text-xs text-ink-soft">{ticket.created_at_display}</td>
      <td className="text-right">
        <ChevronRight className="inline h-4 w-4 text-ink-faint" aria-hidden="true" />
      </td>
    </tr>
  );
}

export function TicketCard({ ticket, onSelect, selected }: TicketRowProps) {
  const label = t("web.help_ticket_row_label", { id: ticketRef(ticket.id) });
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(ticket.id)}
      className={`card block w-full p-4 text-left transition-colors hover:bg-sand/40 ${
        selected ? "bg-pine-tint/40 ring-1 ring-pine" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold text-pine">{ticketRef(ticket.id)}</span>
        <TicketStatusBadge value={ticket.status} />
      </div>
      <p className="mt-1 line-clamp-2 text-sm text-ink">{subjectOf(ticket)}</p>
      {ticket.order_code && <p className="text-xs text-ink-faint">Order #{ticket.order_code}</p>}
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-ink-soft">
        <span>
          {formatRelativeTime(ticket.updated_at_iso)} • {ticket.created_at_display}
        </span>
        <ChevronRight className="h-4 w-4 text-ink-faint" aria-hidden="true" />
      </div>
    </button>
  );
}
