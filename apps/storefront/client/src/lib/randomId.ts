/**
 * A fresh v4 UUID that also works on plain http://.
 *
 * `crypto.randomUUID` is SECURE-CONTEXT ONLY: a shop served over plain http
 * (a LAN box, a staging host without TLS) has no such function, and calling it
 * during render threw a TypeError that blanked the whole page (H6, UI-states
 * audit: the ticket and help pages, and the support upload hook they share).
 * `getRandomValues`, which carries the actual entropy, has no such restriction,
 * so fall back to formatting a v4 UUID from it by hand. Callers treat the value
 * as an opaque unique string.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
