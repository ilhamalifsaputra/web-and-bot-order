/** `tel:` link for a free-text phone number: only digits and a leading "+"
 * survive, so spaces, dashes and parentheses the owner typed never reach the
 * href. Returns null when nothing dialable is left. */
export function telHref(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  return `tel:${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}
