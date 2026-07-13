import { describe, it, expect } from "vitest";
import { emptyFieldDraft, fieldToDraft, draftsToFields, hasAtLeastOneField, fieldsAreValid } from "./additionalFields";
import type { AdditionalField, AdditionalFieldDraft } from "../api/types";

describe("emptyFieldDraft", () => {
  it("returns a blank draft with type text and required true", () => {
    const draft = emptyFieldDraft();
    expect(draft).toEqual({
      key: "",
      labelId: "",
      labelEn: "",
      type: "text",
      required: true,
      optionsText: "",
      placeholder: "",
    });
  });
});

describe("fieldToDraft", () => {
  it("converts a stored AdditionalField into its editable draft shape, joining options with a comma", () => {
    const field: AdditionalField = {
      key: "server",
      label: { id: "Server", en: "Server" },
      type: "select",
      required: true,
      options: ["Asia", "EU", "NA"],
      placeholder: "Pick a server",
    };
    expect(fieldToDraft(field)).toEqual({
      key: "server",
      labelId: "Server",
      labelEn: "Server",
      type: "select",
      required: true,
      optionsText: "Asia, EU, NA",
      placeholder: "Pick a server",
    });
  });
});

describe("draftsToFields", () => {
  it("trims strings and converts a text-field draft with empty options", () => {
    const draft: AdditionalFieldDraft = {
      key: "  ign  ",
      labelId: " IGN ",
      labelEn: " IGN ",
      type: "text",
      required: true,
      optionsText: "should be ignored for non-select",
      placeholder: " Your in-game name ",
    };
    expect(draftsToFields([draft])).toEqual([
      {
        key: "ign",
        label: { id: "IGN", en: "IGN" },
        type: "text",
        required: true,
        options: [],
        placeholder: "Your in-game name",
      },
    ]);
  });

  it("splits a select field's optionsText on commas and newlines, trimming and dropping blanks", () => {
    const draft: AdditionalFieldDraft = {
      key: "server",
      labelId: "Server",
      labelEn: "Server",
      type: "select",
      required: true,
      optionsText: "Asia,\nEU, ,NA",
      placeholder: "",
    };
    expect(draftsToFields([draft])[0]!.options).toEqual(["Asia", "EU", "NA"]);
  });

  it("drops rows with an empty (or whitespace-only) key", () => {
    const blank = emptyFieldDraft();
    const filled: AdditionalFieldDraft = { ...emptyFieldDraft(), key: "ign", labelId: "IGN", labelEn: "IGN" };
    const whitespaceKey: AdditionalFieldDraft = { ...emptyFieldDraft(), key: "   " };
    expect(draftsToFields([blank, filled, whitespaceKey])).toEqual([
      { key: "ign", label: { id: "IGN", en: "IGN" }, type: "text", required: true, options: [], placeholder: "" },
    ]);
  });
});

describe("hasAtLeastOneField", () => {
  it("is false for an empty draft list or a list of only empty-key drafts", () => {
    expect(hasAtLeastOneField([])).toBe(false);
    expect(hasAtLeastOneField([emptyFieldDraft(), { ...emptyFieldDraft(), key: "   " }])).toBe(false);
  });

  it("is true once at least one draft has a non-empty key", () => {
    expect(hasAtLeastOneField([emptyFieldDraft(), { ...emptyFieldDraft(), key: "ign" }])).toBe(true);
  });
});

describe("fieldsAreValid", () => {
  const good = (over: Partial<AdditionalFieldDraft> = {}): AdditionalFieldDraft => ({
    ...emptyFieldDraft(),
    key: "ign",
    labelId: "IGN",
    labelEn: "IGN",
    ...over,
  });

  it("is false with no active (non-empty-key) rows", () => {
    expect(fieldsAreValid([])).toBe(false);
    expect(fieldsAreValid([emptyFieldDraft()])).toBe(false);
  });

  it("is true for a well-formed single field", () => {
    expect(fieldsAreValid([good()])).toBe(true);
  });

  it("is false when the key doesn't match the server's lowercase/underscore pattern", () => {
    expect(fieldsAreValid([good({ key: "Invite Email" })])).toBe(false);
    expect(fieldsAreValid([good({ key: "IGN" })])).toBe(false);
  });

  it("is false when either bilingual label is blank", () => {
    expect(fieldsAreValid([good({ labelId: "" })])).toBe(false);
    expect(fieldsAreValid([good({ labelEn: "  " })])).toBe(false);
  });

  it("is false for a select field with no options", () => {
    expect(fieldsAreValid([good({ type: "select", optionsText: "" })])).toBe(false);
  });

  it("is true for a select field with at least one option", () => {
    expect(fieldsAreValid([good({ type: "select", optionsText: "a, b" })])).toBe(true);
  });

  it("is false when two active rows share the same key", () => {
    expect(fieldsAreValid([good({ key: "dup" }), good({ key: "dup" })])).toBe(false);
  });

  it("ignores a trailing blank draft row (in-progress '+ Add Field')", () => {
    expect(fieldsAreValid([good(), emptyFieldDraft()])).toBe(true);
  });
});
