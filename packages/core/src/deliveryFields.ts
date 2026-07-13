/**
 * Shared spec + validation for a manual_with_info SKU's custom checkout fields.
 *
 * Single source of truth reused by the bot (info-collection wizard), the
 * storefront (checkout step) and the admin API (field-editor validation), so the
 * field schema and per-answer validation never drift between surfaces.
 *
 * Two JSON-in-TEXT shapes live here:
 *   - Denomination.additionalFields — the admin-defined field SPEC (AdditionalField[]).
 *   - Order.customerData            — the buyer's ANSWERS, one map per unit.
 */
import { z } from "zod";
import { ValidationError } from "./errors";

/** Field input types an admin can define for a manual_with_info SKU. */
export const AdditionalFieldType = {
  TEXT: "text",
  EMAIL: "email",
  NUMBER: "number",
  URL: "url",
  SELECT: "select",
} as const;
export type AdditionalFieldType =
  (typeof AdditionalFieldType)[keyof typeof AdditionalFieldType];

/** A bilingual label for a custom field (shown to the buyer in their language). */
export const zFieldLabel = z.object({
  id: z.string().min(1),
  en: z.string().min(1),
});
export type FieldLabel = z.infer<typeof zFieldLabel>;

/** One admin-defined custom field. `options` is used only when type === "select". */
export const zAdditionalField = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/, "Key must be lowercase letters, numbers, or underscores."),
    label: zFieldLabel,
    type: z.nativeEnum(AdditionalFieldType),
    required: z.boolean().default(true),
    options: z.array(z.string().min(1)).default([]),
    placeholder: z.string().max(200).default(""),
  })
  .refine((f) => f.type !== AdditionalFieldType.SELECT || f.options.length > 0, {
    message: "A select field needs at least one option.",
  });
export type AdditionalField = z.infer<typeof zAdditionalField>;

/** The full field spec stored (as JSON text) on Denomination.additionalFields.
 * Keys must be unique — validateCustomerData's `out[field.key] = ...` loop
 * would otherwise let a later duplicate-key field silently overwrite an
 * earlier one's buyer answer, even though the checkout UI still separately
 * prompts for (and the buyer still separately types) both. */
export const zAdditionalFields = z.array(zAdditionalField).refine(
  (fields) => new Set(fields.map((f) => f.key)).size === fields.length,
  { message: "Field keys must be unique." },
);

/** Buyer answers stored on Order.customerData: one { key: value } map per unit. */
export const zCustomerData = z.array(z.record(z.string()));
export type CustomerData = z.infer<typeof zCustomerData>;

/** Parse the stored field spec; returns [] on null/blank/invalid (never throws). */
export function parseAdditionalFields(
  json: string | null | undefined,
): AdditionalField[] {
  if (!json) return [];
  try {
    const parsed = zAdditionalFields.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Parse stored buyer answers; returns [] on null/blank/invalid (never throws). */
export function parseCustomerData(json: string | null | undefined): CustomerData {
  if (!json) return [];
  try {
    const parsed = zCustomerData.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate & normalize a single buyer answer against its field spec.
 * Returns the trimmed value to store, or throws ValidationError with a
 * buyer-facing i18n key (the field key rides along under formatArgs for context).
 */
export function validateFieldAnswer(field: AdditionalField, rawValue: unknown): string {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) {
    if (field.required) throw new ValidationError("error.field_required", { key: field.key });
    return "";
  }
  switch (field.type) {
    case AdditionalFieldType.EMAIL:
      if (!EMAIL_RE.test(value)) {
        throw new ValidationError("error.field_invalid_email", { key: field.key });
      }
      return value;
    case AdditionalFieldType.NUMBER:
      if (!/^\d+$/.test(value)) {
        throw new ValidationError("error.field_invalid_number", { key: field.key });
      }
      return value;
    case AdditionalFieldType.URL:
      try {
        const u = new URL(value);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
      } catch {
        throw new ValidationError("error.field_invalid_url", { key: field.key });
      }
      return value;
    case AdditionalFieldType.SELECT:
      if (!field.options.includes(value)) {
        throw new ValidationError("error.field_invalid_select", { key: field.key });
      }
      return value;
    case AdditionalFieldType.TEXT:
    default:
      return value;
  }
}

/**
 * Validate a full set of answers for `quantity` units against `fields`.
 * `answers` must be a list of per-unit maps (fields collected once per unit — 3
 * seats = 3 answer maps). Returns the normalized list ready to JSON.stringify
 * onto Order.customerData. Throws ValidationError on the first bad/missing answer.
 */
export function validateCustomerData(
  fields: AdditionalField[],
  answers: unknown,
  quantity: number,
): Array<Record<string, string>> {
  if (fields.length === 0) return [];
  if (!Array.isArray(answers) || answers.length !== quantity) {
    throw new ValidationError("error.customer_data_incomplete");
  }
  return answers.map((unit) => {
    const map = unit && typeof unit === "object" ? (unit as Record<string, unknown>) : {};
    const out: Record<string, string> = {};
    for (const field of fields) {
      out[field.key] = validateFieldAnswer(field, map[field.key]);
    }
    return out;
  });
}
