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

function isActiveDraft(d: AdditionalFieldDraft): boolean {
  return d.labelId.trim() !== "" || d.labelEn.trim() !== "";
}

/** Turns free-typed question text into the `^[a-z0-9_]+$` shape
 * `zAdditionalField.key` requires (packages/core/src/deliveryFields.ts). */
function slugifyKey(text: string): string {
  const base = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
    .replace(/_+$/g, "");
  return base || "field";
}

/** Dedupes a candidate key against every key already used in this
 * submission, appending `_2`, `_3`, … — mirrors packages/db/src/migrate/slug.ts's
 * uniqueSlug, underscore-joined since that's what the key regex allows. */
function uniqueKey(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) {
    candidate = `${base}_${n}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Convert drafts to the real AdditionalField[] shape for submission. Rows
 * with no question text typed in either language are dropped — they're
 * incomplete/abandoned rows, mirroring the "at least one field" canSubmit
 * gate. This is a UX convenience only: the server's
 * zAdditionalFields.safeParse (via @app/core/deliveryFields) is still the
 * authority on full shape validity (labels present, select has options, …).
 *
 * `key` is never admin-typed (AdditionalFieldsEditor has no Key input — it's
 * a pure implementation detail the buyer never sees, see the field's doc
 * comment in api/types.ts). An edited row keeps its existing key (prefilled
 * by fieldToDraft) so re-saving doesn't rename it out from under stored order
 * data; a brand-new row's blank key is generated here from its English
 * question text (falling back to the Indonesian one).
 */
export function draftsToFields(drafts: AdditionalFieldDraft[]): AdditionalField[] {
  const active = drafts.filter(isActiveDraft);
  const taken = new Set(active.filter((d) => d.key.trim() !== "").map((d) => d.key.trim()));
  return active.map((d) => {
    const key = d.key.trim() || uniqueKey(slugifyKey(d.labelEn.trim() || d.labelId.trim()), taken);
    return {
      key,
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
    };
  });
}

/** True once at least one draft row has a question typed in either language
 * — gates the Create/Edit pages' submit button when deliveryType is
 * manual_with_info, mirroring the server's "at least one custom field is
 * required" rule. */
export function hasAtLeastOneField(drafts: AdditionalFieldDraft[]): boolean {
  return drafts.some(isActiveDraft);
}

/**
 * Mirrors @app/core/deliveryFields's zAdditionalField/zAdditionalFields
 * requirements client-side (both bilingual labels present, select-type needs
 * options) — so Save/Create can't enable itself on a spec the server is
 * guaranteed to reject with only a generic error. Only checks rows
 * draftsToFields would actually submit (some question text typed); a
 * still-blank "+ Add Field" row in progress doesn't block submission. Key
 * uniqueness/format isn't checked here — draftsToFields generates it, so
 * it's always valid by construction.
 */
export function fieldsAreValid(drafts: AdditionalFieldDraft[]): boolean {
  const active = drafts.filter(isActiveDraft);
  if (active.length === 0) return false;
  return active.every((d) => {
    if (!d.labelId.trim() || !d.labelEn.trim()) return false;
    if (d.type === "select") {
      const options = d.optionsText.split(/[,\n]/).map((o) => o.trim()).filter((o) => o !== "");
      if (options.length === 0) return false;
    }
    return true;
  });
}
