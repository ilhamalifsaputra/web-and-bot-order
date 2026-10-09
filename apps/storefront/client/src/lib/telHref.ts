/** True for a plain `local@domain.tld` address with no whitespace, `?` or `&`,
 * so it is safe to put straight into a `mailto:` href (anything else is shown
 * as plain text rather than risk extra mailto headers like `?cc=`). */
export function isPlainEmail(email: string): boolean {
  return /^[^\s@?&]+@[^\s@?&]+\.[^\s@?&]+$/.test(email);
}

/** `tel:` link for a free-text phone number: only digits and a leading "+"
 * survive, so spaces, dashes and parentheses the owner typed never reach the
 * href. Returns null when nothing dialable is left. */
export function telHref(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  return `tel:${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}
