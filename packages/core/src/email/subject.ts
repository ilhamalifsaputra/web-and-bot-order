/**
 * Substitutes only the literal `{shop_name}` token into an admin-edited
 * subject string — never any payload-derived token (order code, total,
 * transaction id, reset link), even if an admin types that literal token
 * name into the Settings field. See Global Constraints: for the order-paid
 * email the order code is half the guest `/track` credential, and
 * mailer.ts logs every subject verbatim, so no other token may ever be
 * substituted here.
 *
 * Shared by every template's subject building so this security-relevant
 * logic has exactly one implementation — it previously existed as an
 * identical copy in both templates/orderPaid.ts and
 * templates/resetPassword.ts, which risked drifting apart under future
 * edits.
 */
import type { BrandConfig, EmailCopy } from "./types";

export function buildSubject(copy: EmailCopy, brand: BrandConfig): string {
  return copy.subject.replaceAll("{shop_name}", brand.shopName);
}
