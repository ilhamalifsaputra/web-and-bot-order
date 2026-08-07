/**
 * Parallel plain-text builders for the `text` fallback every template
 * returns (`sendMail` requires it, and some clients render text-only).
 * Deliberately dumb: no markdown, no line-wrapping logic beyond a blank
 * line between sections, no escaping (plain text has no markup to escape —
 * escaping here would corrupt the literal value the reader sees).
 */

/** A section heading, e.g. "Order Summary", followed by a blank line. */
export function ptSection(heading: string): string {
  return `${heading}\n`;
}

/** One "Label: value" line. */
export function ptKeyValue(label: string, value: string): string {
  return `${label}: ${value}`;
}

/** A visual separator between sections. */
export function ptDivider(): string {
  return "----------------------------------------";
}
