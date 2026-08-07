/**
 * Substitutes the literal `{shop_name}` token into an admin-edited subject
 * string for every template. No other payload-derived token is substituted
 * by default — mailer.ts's sendMail logs every subject verbatim, so a
 * template must opt in explicitly (via the `extraTokens` param below)
 * before any additional token can appear in a subject.
 *
 * The one deliberate exception: OWNER_EMAIL_ORDER_PAID's subject (built by
 * templates/orderPaid.ts) is allowed to substitute `{order_code}` too — a
 * decision made after weighing that this email's only recipient is the shop
 * admin, an already-trusted party with full order access via the admin
 * panel, so the order code appearing in this one subject (and, as a
 * consequence, in this app's own operator-only Pino logs) is an accepted
 * risk, not a leak to an untrusted party. Every other template — including
 * resetPassword.ts, which also calls buildSubject — must keep calling
 * buildSubject(copy, brand) with no third argument and gets no extra
 * tokens.
 *
 * Shared by every template's subject building so this security-relevant
 * logic has exactly one implementation — it previously existed as an
 * identical copy in both templates/orderPaid.ts and
 * templates/resetPassword.ts, which risked drifting apart under future
 * edits.
 */
import type { BrandConfig, EmailCopy } from "./types";

export function buildSubject(
  copy: EmailCopy,
  brand: BrandConfig,
  extraTokens?: Record<string, string>,
): string {
  let subject = copy.subject.replaceAll("{shop_name}", brand.shopName);
  if (extraTokens) {
    for (const [token, value] of Object.entries(extraTokens)) {
      subject = subject.replaceAll(`{${token}}`, value);
    }
  }
  return subject;
}
