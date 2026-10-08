/**
 * Parses the status pair out of a `ticket_status_change` audit row's details.
 * The format is fixed by `transitionTicketStatus` in packages/db/src/crud/support.ts:
 * `Ticket #<id> moved from <FROM> to <TO>.` with an optional ` (<meta>)` before
 * the final period. Returns null when the text does not match, so the admin
 * page can fall back to showing the raw details.
 */
const STATUS_CHANGE_RE = /^Ticket #\d+ moved from ([A-Z_]+) to ([A-Z_]+)(?: \(.*\))?\.$/;

export function parseStatusChange(details: string | null | undefined): { from: string; to: string } | null {
  if (!details) return null;
  const m = STATUS_CHANGE_RE.exec(details.trim());
  return m && m[1] && m[2] ? { from: m[1], to: m[2] } : null;
}
