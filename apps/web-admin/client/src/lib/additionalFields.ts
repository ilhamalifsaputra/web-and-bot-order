/**
 * Pure helpers converting between the stored AdditionalField shape
 * (packages/core/src/deliveryFields.ts's zAdditionalField, mirrored locally
 * as api/types.ts's AdditionalField) and AdditionalFieldDraft, the looser
 * free-typed shape AdditionalFieldsEditor edits (a still-typing key, an
 * options textarea not yet split into an array, etc).
 */
import type { AdditionalField, AdditionalFieldDraft } from "../api/types";

/** A fresh, blank row for "+ Add Field". Defaults mirror the server schema's
 * defaults (type "text", required true). */
export function emptyFieldDraft(): AdditionalFieldDraft {
  return { key: "", labelId: "", labelEn: "", type: "text", required: true, optionsText: "", placeholder: "" };
}

/** Seed an editable draft from a loaded/stored field (edit page prefill). */
export function fieldToDraft(field: AdditionalField): AdditionalFieldDraft {
  return {
    key: field.key,
    labelId: field.label.id,
    labelEn: field.label.en,
    type: field.type,
    required: field.required,
    optionsText: field.options.join(", "),
    placeholder: field.placeholder,
  };
}

/**
 * Convert drafts to the real AdditionalField[] shape for submission. Rows
 * with an empty (or whitespace-only) key are dropped — they're incomplete/
 * abandoned rows, mirroring the "at least one field with a non-empty key"
 * canSubmit gate. This is a UX convenience only: the server's
 * zAdditionalFields.safeParse (via @app/core/deliveryFields) is still the
 * authority on full shape validity (labels present, select has options, …).
 */
export function draftsToFields(drafts: AdditionalFieldDraft[]): AdditionalField[] {
  return drafts
    .filter((d) => d.key.trim() !== "")
    .map((d) => ({
      key: d.key.trim(),
      label: { id: d.labelId.trim(), en: d.labelEn.trim() },
      type: d.type,
      required: d.required,
      options:
        d.type === "select"
          ? d.optionsText
              .split(/[,\n]/)
              .map((o) => o.trim())
              .filter((o) => o !== "")
          : [],
      placeholder: d.placeholder.trim(),
    }));
}

const KEY_PATTERN = /^[a-z0-9_]+$/;

/** True once at least one draft row has a non-empty key — gates the
 * Create/Edit pages' submit button when deliveryType is manual_with_info,
 * mirroring the server's "at least one custom field is required" rule. */
export function hasAtLeastOneField(drafts: AdditionalFieldDraft[]): boolean {
  return drafts.some((d) => d.key.trim() !== "");
}

/**
 * Mirrors @app/core/deliveryFields's zAdditionalField/zAdditionalFields
 * requirements client-side (key format, both bilingual labels, select-type
 * needs options, unique keys) — so Save/Create can't enable itself on a spec
 * the server is guaranteed to reject with only a generic error. Only checks
 * rows draftsToFields would actually submit (non-empty key); a still-blank
 * "+ Add Field" row in progress doesn't block submission.
 */
export function fieldsAreValid(drafts: AdditionalFieldDraft[]): boolean {
  const active = drafts.filter((d) => d.key.trim() !== "");
  if (active.length === 0) return false;
  const keys = active.map((d) => d.key.trim());
  if (new Set(keys).size !== keys.length) return false;
  return active.every((d) => {
    if (!KEY_PATTERN.test(d.key.trim())) return false;
    if (!d.labelId.trim() || !d.labelEn.trim()) return false;
    if (d.type === "select") {
      const options = d.optionsText.split(/[,\n]/).map((o) => o.trim()).filter((o) => o !== "");
      if (options.length === 0) return false;
    }
    return true;
  });
}
