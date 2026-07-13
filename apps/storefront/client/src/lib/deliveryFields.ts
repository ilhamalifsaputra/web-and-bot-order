/**
 * Client-side pre-check for a manual_with_info SKU's custom checkout fields —
 * mirrors packages/core/src/deliveryFields.ts's validateFieldAnswer /
 * validateCustomerData rule-for-rule (same regexes, same required/select/url/
 * number checks), same pattern as lib/format.ts mirroring packages/core's
 * formatters instead of taking @app/core as a runtime client dependency
 * (neither React SPA in this repo does — see api/types.ts's AdditionalField
 * doc comment).
 *
 * This is a UX convenience only: it lets CheckoutPage disable "Place Order"
 * before a wasted round trip. The SERVER (apps/storefront/src/routes/
 * checkout.ts performCheckout, via the real validateCustomerData) is the
 * actual authority and re-validates from scratch — this file must never be
 * treated as a security boundary.
 *
 * Returns i18n error KEYS (e.g. "error.field_required"), not messages, so
 * callers render them through the same lib/i18n.ts `t()` the rest of the
 * client uses — same keys the server's ValidationError.key carries, so a
 * client-caught error and a server-rejected one read identically.
 */
import type { AdditionalField } from "../api/types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate one answer against its field spec. Returns an i18n error key, or
 * null when the (trimmed) value is valid. */
export function fieldError(field: AdditionalField, rawValue: string): string | null {
  const value = (rawValue ?? "").trim();
  if (!value) return field.required ? "error.field_required" : null;
  switch (field.type) {
    case "email":
      return EMAIL_RE.test(value) ? null : "error.field_invalid_email";
    case "number":
      return /^\d+$/.test(value) ? null : "error.field_invalid_number";
    case "url":
      try {
        const u = new URL(value);
        if (u.protocol !== "http:" && u.protocol !== "https:") return "error.field_invalid_url";
        return null;
      } catch {
        return "error.field_invalid_url";
      }
    case "select":
      return field.options.includes(value) ? null : "error.field_invalid_select";
    case "text":
    default:
      return null;
  }
}

/**
 * True iff every field in every unit's answer map passes fieldError — gates
 * CheckoutPage's "Place Order" button. `answers` must have exactly
 * `expectedUnits` entries (defaults to `answers.length`, i.e. no length
 * check) — mirrors validateCustomerData's `answers.length !== quantity` guard.
 */
export function allFieldsValid(
  fields: AdditionalField[],
  answers: Array<Record<string, string>>,
  expectedUnits: number = answers.length,
): boolean {
  if (answers.length !== expectedUnits) return false;
  return answers.every((unit) => fields.every((field) => fieldError(field, unit[field.key] ?? "") === null));
}
