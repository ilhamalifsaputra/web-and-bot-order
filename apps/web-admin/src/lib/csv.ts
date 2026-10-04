/**
 * The one CSV cell writer for every admin export (users, orders, support,
 * stock, reports).
 *
 * Quotes a field per RFC 4180: wrap in double quotes if it contains a comma,
 * quote, or newline, doubling any embedded quotes. Also neutralises CSV
 * formula injection: a leading `=`, `+`, `-`, or `@` is interpreted by
 * Excel/Google Sheets as the start of a formula, and several exported fields
 * carry text someone outside the shop controls (a storefront registration's
 * `fullName`, a guest's `guestEmail`, a ticket `message`, a supplier-synced
 * product name) — prefixing with a single quote forces the cell to render as
 * literal text instead of evaluating.
 */
export function csvField(value: string): string {
  const escaped = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(escaped)) {
    return `"${escaped.replace(/"/g, '""')}"`;
  }
  return escaped;
}

/** One CSV line (CRLF-terminated) from its cells. */
export function csvRow(fields: string[]): string {
  return fields.map(csvField).join(",") + "\r\n";
}
