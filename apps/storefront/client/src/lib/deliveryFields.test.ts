import { describe, it, expect } from "vitest";
import { fieldError, allFieldsValid } from "./deliveryFields";
import type { AdditionalField } from "../api/types";

const textField: AdditionalField = {
  key: "note",
  label: { id: "Catatan", en: "Note" },
  type: "text",
  required: true,
  options: [],
  placeholder: "",
};
const optionalTextField: AdditionalField = { ...textField, key: "opt", required: false };
const emailField: AdditionalField = { ...textField, key: "email", type: "email" };
const numberField: AdditionalField = { ...textField, key: "num", type: "number" };
const urlField: AdditionalField = { ...textField, key: "url", type: "url" };
const selectField: AdditionalField = { ...textField, key: "region", type: "select", options: ["NA", "EU"] };

describe("fieldError (client mirror of validateFieldAnswer)", () => {
  it("required text: empty -> error.field_required, non-empty -> valid", () => {
    expect(fieldError(textField, "")).toBe("error.field_required");
    expect(fieldError(textField, "   ")).toBe("error.field_required");
    expect(fieldError(textField, "hello")).toBeNull();
  });

  it("optional text: empty is valid", () => {
    expect(fieldError(optionalTextField, "")).toBeNull();
  });

  it("email: validates format", () => {
    expect(fieldError(emailField, "not-an-email")).toBe("error.field_invalid_email");
    expect(fieldError(emailField, "a@b.com")).toBeNull();
  });

  it("number: digits only", () => {
    expect(fieldError(numberField, "12a3")).toBe("error.field_invalid_number");
    expect(fieldError(numberField, "12345")).toBeNull();
  });

  it("url: must be a valid http(s) URL", () => {
    expect(fieldError(urlField, "not a url")).toBe("error.field_invalid_url");
    expect(fieldError(urlField, "ftp://x.com")).toBe("error.field_invalid_url");
    expect(fieldError(urlField, "https://example.com")).toBeNull();
  });

  it("select: value must be one of the configured options", () => {
    expect(fieldError(selectField, "ASIA")).toBe("error.field_invalid_select");
    expect(fieldError(selectField, "EU")).toBeNull();
  });
});

describe("allFieldsValid (gates Place Order)", () => {
  const fields: AdditionalField[] = [textField, emailField];

  it("false when any unit has a missing/invalid answer", () => {
    expect(allFieldsValid(fields, [{ note: "hi", email: "a@b.com" }, { note: "", email: "a@b.com" }])).toBe(false);
  });

  it("true when every unit's every field passes", () => {
    expect(allFieldsValid(fields, [{ note: "hi", email: "a@b.com" }, { note: "yo", email: "c@d.com" }])).toBe(true);
  });

  it("false when the answers array length doesn't match the expected unit count", () => {
    expect(allFieldsValid(fields, [{ note: "hi", email: "a@b.com" }], 2)).toBe(false);
  });
});
