import { ticketStatusLabel } from "./ticketStatus";

/** One audit/timeline row as `GET /api/support/:ticketId` returns it. */
export interface TicketActivityRow {
  id: number;
  adminId: number | null;
  actorType: "ADMIN" | "CUSTOMER";
  action: string;
  details: string | null;
  /** ISO timestamp, used for the merge window. */
  createdAt: string;
  createdAtShort: string | null;
  createdAtDisplay: string | null;
  statusChange: { from: string; to: string } | null;
}

export interface TicketActivityEntry {
  id: number;
  time: string;
  timeTitle: string;
  text: string;
  /** Human label of the status this entry moved the ticket to, if any. */
  statusTo?: string;
}

export interface TicketActivityContext {
  /** Public ticket label that replaces "ticket #<id>" in free-text details. */
  ticketLabel: string;
  actorLabel: (row: TicketActivityRow) => string;
}

/** A status change this close to a reply/resolve/reopen/close by the same admin is one event. */
const MERGE_WINDOW_MS = 10_000;
const MERGEABLE_ACTIONS = new Set(["ticket_reply", "ticket_resolve", "ticket_reopen", "ticket_close"]);

/** "order_create" -> "Order create": a readable fallback for an action key with no details. */
export function humanizeAction(action: string): string {
  const words = action.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sentence(row: TicketActivityRow, ctx: TicketActivityContext): string {
  switch (row.action) {
    case "ticket_create":
      return "Ticket created";
    case "ticket_reply":
      return `${ctx.actorLabel(row)} replied`;
    case "ticket_note":
      return `${ctx.actorLabel(row)} added an internal note`;
    case "ticket_resolve":
      return "Resolved";
    case "ticket_reopen":
      return "Reopened";
    case "ticket_close":
      return "Closed";
    case "ticket_status_change":
      if (row.statusChange) return `Status → ${ticketStatusLabel(row.statusChange.to)}`;
  }
  return (row.details ?? humanizeAction(row.action)).replace(/ticket #\d+/gi, `ticket ${ctx.ticketLabel}`);
}

/**
 * Turns the API's newest-first timeline rows into oldest-first display
 * entries, folding a `ticket_status_change` into the adjacent
 * reply/resolve/reopen/close it belongs to (same non-null admin, within 10 s).
 */
export function buildTicketActivity(
  rows: readonly TicketActivityRow[],
  ctx: TicketActivityContext,
): TicketActivityEntry[] {
  const ordered = [...rows].reverse();
  // host entry id -> the status change folded into it
  const hosts = new Map<number, TicketActivityRow>();
  const consumed = new Set<number>();

  for (const row of ordered) {
    if (row.action !== "ticket_status_change" || !row.statusChange || row.adminId == null) continue;
    const at = Date.parse(row.createdAt);
    let best: TicketActivityRow | null = null;
    let bestGap = Infinity;
    for (const cand of ordered) {
      if (!MERGEABLE_ACTIONS.has(cand.action) || cand.adminId !== row.adminId || hosts.has(cand.id)) continue;
      const gap = Math.abs(Date.parse(cand.createdAt) - at);
      if (gap <= MERGE_WINDOW_MS && gap < bestGap) {
        best = cand;
        bestGap = gap;
      }
    }
    if (best) {
      hosts.set(best.id, row);
      consumed.add(row.id);
    }
  }

  return ordered
    .filter((row) => !consumed.has(row.id))
    .map((row) => {
      const folded = hosts.get(row.id)?.statusChange;
      return {
        id: row.id,
        time: row.createdAtShort ?? row.createdAtDisplay ?? "",
        timeTitle: row.createdAtDisplay ?? "",
        text: sentence(row, ctx),
        ...(folded ? { statusTo: ticketStatusLabel(folded.to) } : {}),
      };
    });
}
