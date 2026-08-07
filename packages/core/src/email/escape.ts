/**
 * HTML-context escaping for the email design system. Standalone copy of
 * packages/outbox-dispatcher/src/templates.ts's `escape()` — packages/core
 * cannot depend on packages/outbox-dispatcher (wrong direction of the
 * dependency graph), and the same &/</>/"/' entity set is correct for both
 * Telegram HTML and email HTML body/attribute context.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
