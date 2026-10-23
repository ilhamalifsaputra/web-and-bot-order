import { describe, expect, it } from "vitest";
import { parseAccountMessage } from "./accountInput";
import { parseAdditionalFields, type AdditionalField } from "./deliveryFields";

const [userId, zoneId] = parseAdditionalFields(JSON.stringify([
  { key: "user_id", label: { id: "User ID", en: "User ID" }, type: "number", required: true, minLength: 4, maxLength: 20 },
  { key: "zone_id", label: { id: "Zone ID", en: "Zone ID" }, type: "number", required: true },
])) as [AdditionalField, AdditionalField];
const idZone = [userId, zoneId];
const wideId = { ...userId, maxLength: 30 };
const fixedZone = (len: number): AdditionalField => ({ ...zoneId, minLength: len, maxLength: len });
const textField = (key: string, extra: Partial<AdditionalField> = {}): AdditionalField =>
  ({ key, label: { id: key, en: key }, type: "text", required: true, options: [], placeholder: "", ...extra });

const ok = (values: Record<string, string>) => ({ ok: true, values });

describe("parseAccountMessage — two fields (ID + Zone)", () => {
  it("accepts whitespace, comma, colon and mixed separator runs", () => {
    for (const text of ["123456789 1234", "123456789,1234", "123456789:1234", "123456789 , 1234", "  123456789   1234  ", "123456789\n1234", "123456789\t1234", "123456789\u00a01234", "123456789: 1234"]) {
      expect(parseAccountMessage(idZone, text)).toEqual(ok({ user_id: "123456789", zone_id: "1234" }));
    }
  });
  it("tolerates a single balanced A(B) / A (B) form", () => {
    expect(parseAccountMessage(idZone, "123456789(1234)")).toEqual(ok({ user_id: "123456789", zone_id: "1234" }));
    expect(parseAccountMessage(idZone, "123456789 (1234)")).toEqual(ok({ user_id: "123456789", zone_id: "1234" }));
  });
  it("rejects stray or malformed parentheses as unbalanced", () => {
    for (const text of ["123456789(1234", "123456789)1234(", "123456789(1234))", "(1234)", "123456789()", "123456789((1234))", "123456789(1234)5", "123456789,(1234)", "123456789( 1234 )", "123 456(7)"]) {
      expect(parseAccountMessage(idZone, text)).toMatchObject({ ok: false, reason: "unbalanced" });
    }
  });
  it("keeps IDs as typed: leading zeros and 25-digit IDs stay intact strings", () => {
    expect(parseAccountMessage(idZone, "0012345 0007")).toEqual(ok({ user_id: "0012345", zone_id: "0007" }));
    const long = "1234567890123456789012345";
    const result = parseAccountMessage([wideId, zoneId], `${long} 0001`);
    expect(result).toEqual(ok({ user_id: long, zone_id: "0001" }));
    if (result.ok) for (const v of Object.values(result.values)) expect(typeof v).toBe("string");
  });
  it("rejects an extra token as too_many", () => {
    expect(parseAccountMessage(idZone, "123456789 1234 5")).toMatchObject({ ok: false, reason: "too_many" });
    expect(parseAccountMessage(idZone, "123456789,,1234,5")).toMatchObject({ ok: false, reason: "too_many" });
  });
  it("reports a missing zone as missing_field with the field key when the token cannot hide it", () => {
    // "1234" is 4 digits: user_id needs >= 4, zone >= 1, so a zone cannot be hidden inside.
    expect(parseAccountMessage(idZone, "1234")).toEqual({ ok: false, reason: "missing_field", field: "zone_id" });
    expect(parseAccountMessage([textField("name"), textField("server")], "Bob")).toEqual({ ok: false, reason: "missing_field", field: "server" });
  });
  it("rejects contiguous digits with no fixed zone length as ambiguous (never guesses a split)", () => {
    expect(parseAccountMessage(idZone, "1234567891234")).toEqual({ ok: false, reason: "ambiguous", field: "zone_id" });
    expect(parseAccountMessage(idZone, "123456789")).toEqual({ ok: false, reason: "ambiguous", field: "zone_id" });
    // Ambiguous needs room for both: user_id min 4 + zone min 1 = 5 digits.
    expect(parseAccountMessage(idZone, "12345")).toEqual({ ok: false, reason: "ambiguous", field: "zone_id" });
    // A fixed-length zone that is not digit-shaped (text without a digit pattern) is never
    // split; digits cannot be said to hide it, so the buyer is told the zone is missing.
    expect(parseAccountMessage([userId, textField("zone", { minLength: 4, maxLength: 4 })], "1234567891234")).toEqual({ ok: false, reason: "missing_field", field: "zone" });
  });
  it("splits contiguous digits only when the zone has a fixed digit length", () => {
    expect(parseAccountMessage([userId, fixedZone(4)], "1234567891234")).toEqual(ok({ user_id: "123456789", zone_id: "1234" }));
    expect(parseAccountMessage([userId, fixedZone(5)], "12345678912345")).toEqual(ok({ user_id: "123456789", zone_id: "12345" }));
    const patternZone = textField("zone", { minLength: 4, maxLength: 4, pattern: "^[0-9]+$" });
    expect(parseAccountMessage([userId, patternZone], "00120007")).toEqual(ok({ user_id: "0012", zone: "0007" }));
    // The split ID is still validated: 1 digit is below user_id's minLength.
    expect(parseAccountMessage([userId, fixedZone(4)], "12345")).toMatchObject({ ok: false, reason: "invalid_value", field: "user_id", errorKey: "error.field_invalid_length" });
  });
  it("never splits a token no longer than the fixed zone into an empty ID", () => {
    for (const text of ["1234", "123", "0"]) {
      const result = parseAccountMessage([userId, fixedZone(4)], text);
      expect(result.ok).toBe(false);
      expect(["missing_field", "ambiguous"]).toContain(result.ok ? "" : result.reason);
    }
    expect(parseAccountMessage([userId, fixedZone(4)], "1234")).toEqual({ ok: false, reason: "missing_field", field: "zone_id" });
  });
  it("does not split contiguous text containing non-digits even with a fixed zone", () => {
    expect(parseAccountMessage([userId, fixedZone(4)], "12345a1234")).toEqual({ ok: false, reason: "missing_field", field: "zone_id" });
    expect(parseAccountMessage([userId, fixedZone(4)], "１２３４５６７８")).toMatchObject({ ok: false });
  });
  it("maps non-digit letters to invalid_value with the validateFieldAnswer error key", () => {
    expect(parseAccountMessage(idZone, "12345abc 1234")).toEqual({ ok: false, reason: "invalid_value", field: "user_id", errorKey: "error.field_invalid_number", errorArgs: { key: "user_id" } });
    expect(parseAccountMessage(idZone, "123456789 12a")).toMatchObject({ ok: false, reason: "invalid_value", field: "zone_id", errorKey: "error.field_invalid_number" });
    expect(parseAccountMessage(idZone, "123 1234")).toMatchObject({ ok: false, reason: "invalid_value", field: "user_id", errorKey: "error.field_invalid_length", errorArgs: { key: "user_id", min: 4, max: 20 } });
  });
  it("rejects Unicode lookalike digits where ASCII digits are required", () => {
    for (const text of ["１２３４５６７８９ 1234", "١٢٣٤٥٦٧٨٩ 1234", "123456789 ۱۲۳۴", "123456789 𝟏𝟐𝟑𝟒"]) {
      expect(parseAccountMessage(idZone, text)).toMatchObject({ ok: false, reason: "invalid_value" });
    }
    const patternField = textField("uid", { pattern: "^[0-9]+$" });
    expect(parseAccountMessage([patternField], "１２３４")).toMatchObject({ ok: false, reason: "invalid_value", errorKey: "error.field_invalid_pattern" });
  });
  it("rejects zero-width, bidi and control characters inside a token, even in free-text fields", () => {
    const free = [textField("name"), textField("server")];
    for (const ch of ["\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u2028", "\u2029", "\u0000", "\u0007", "\u001b", "\u007f", "\u0085", "\u202e", "\u2066", "\u2060", "\ufeff", "\u00ad", "\u000b", "\u000c"]) {
      expect(parseAccountMessage(idZone, `1234${ch}56789 1234`)).toMatchObject({ ok: false, reason: "invalid_value", field: "user_id" });
      expect(parseAccountMessage(free, `Bob 12${ch}34`)).toMatchObject({ ok: false, reason: "invalid_value", field: "server" });
      expect(parseAccountMessage([textField("name")], `${ch}Bob`)).toMatchObject({ ok: false, reason: "invalid_value", field: "name" });
      expect(parseAccountMessage([textField("name")], `Bob${ch}`)).toMatchObject({ ok: false, reason: "invalid_value", field: "name" });
    }
  });
  it("returns empty for empty or whitespace-only text", () => {
    for (const text of ["", "   ", "\n\t ", "\u00a0\u3000"]) {
      expect(parseAccountMessage(idZone, text)).toEqual({ ok: false, reason: "empty" });
      expect(parseAccountMessage([userId], text)).toEqual({ ok: false, reason: "empty" });
    }
  });
  it("treats a separator-only message as missing the first field, never as values", () => {
    expect(parseAccountMessage(idZone, ", :")).toEqual({ ok: false, reason: "missing_field", field: "user_id" });
  });
});

describe("parseAccountMessage — one field", () => {
  it("accepts one token and validates it", () => {
    expect(parseAccountMessage([userId], "  0012345  ")).toEqual(ok({ user_id: "0012345" }));
    expect(parseAccountMessage([userId], "12a45")).toMatchObject({ ok: false, reason: "invalid_value", field: "user_id", errorKey: "error.field_invalid_number" });
  });
  it("rejects whitespace, comma or colon inside the value as too_many", () => {
    for (const text of ["123456 789", "123456,789", "123456:789", "Bob Smith"]) {
      expect(parseAccountMessage([userId], text)).toMatchObject({ ok: false, reason: "too_many" });
    }
  });
  it("returns HTML-looking text verbatim (the caller escapes it)", () => {
    expect(parseAccountMessage([textField("name")], "<b>Bob</b>")).toEqual(ok({ name: "<b>Bob</b>" }));
    expect(parseAccountMessage([textField("name"), userId], "<b>Bob</b> 1234")).toEqual(ok({ name: "<b>Bob</b>", user_id: "1234" }));
    expect(parseAccountMessage([userId], "<b>1234</b>")).toMatchObject({ ok: false, reason: "invalid_value", field: "user_id" });
  });
  it("does not treat parentheses as separators for a single field", () => {
    expect(parseAccountMessage([textField("name")], "Bob(EU)")).toEqual(ok({ name: "Bob(EU)" }));
    expect(parseAccountMessage([userId], "1234(5)")).toMatchObject({ ok: false, reason: "invalid_value" });
  });
});

describe("parseAccountMessage — three fields", () => {
  const three = [userId, zoneId, textField("server")];
  it("maps three tokens in field order", () => {
    expect(parseAccountMessage(three, "123456789 1234 asia")).toEqual(ok({ user_id: "123456789", zone_id: "1234", server: "asia" }));
    expect(parseAccountMessage(three, "123456789,1234:asia")).toEqual(ok({ user_id: "123456789", zone_id: "1234", server: "asia" }));
  });
  it("rejects the parenthesis form as unbalanced (only tolerated for exactly two fields)", () => {
    expect(parseAccountMessage(three, "123456789(1234) asia")).toMatchObject({ ok: false, reason: "unbalanced" });
    expect(parseAccountMessage(three, "123456789 1234 (asia)")).toMatchObject({ ok: false, reason: "unbalanced" });
  });
  it("never splits contiguous digits for three fields", () => {
    expect(parseAccountMessage([userId, fixedZone(4), fixedZone(4)], "123456789 12341234")).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(parseAccountMessage(three, "123456789 1234")).toEqual({ ok: false, reason: "missing_field", field: "server" });
  });
  it("requires every field, including optional ones, to have a token", () => {
    expect(parseAccountMessage([userId, { ...textField("note"), required: false }], "1234")).toEqual({ ok: false, reason: "missing_field", field: "note" });
  });
});

describe("parseAccountMessage — totality", () => {
  it("returns too_many when no field is expected and empty for empty text", () => {
    expect(parseAccountMessage([], "1234")).toMatchObject({ ok: false, reason: "too_many" });
    expect(parseAccountMessage([], "")).toEqual({ ok: false, reason: "empty" });
  });
  it("never throws on non-string input", () => {
    expect(parseAccountMessage(idZone, undefined as unknown as string)).toEqual({ ok: false, reason: "empty" });
    expect(parseAccountMessage(idZone, 1234 as unknown as string)).toEqual({ ok: false, reason: "empty" });
  });
  it("round-trips 100 random digit pairs and separators without throwing", () => {
    let seed = 20261023;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const digits = (len: number) => Array.from({ length: len }, () => String(rand(10))).join("");
    const seps = [" ", ",", ":", " , ", "  ", "\t", "\n", ": ", ",,", " :\u00a0"];
    for (let i = 0; i < 100; i++) {
      const id = digits(4 + rand(17));
      const zone = digits(1 + rand(6));
      const sep = seps[rand(seps.length)]!;
      const result = parseAccountMessage(idZone, `${id}${sep}${zone}`);
      expect(result).toEqual(ok({ user_id: id, zone_id: zone }));
      if (result.ok) expect(`${result.values.user_id} ${result.values.zone_id}`).toBe(`${id} ${zone}`);
      const junk = Array.from({ length: rand(12) }, () => String.fromCharCode(rand(0x3100))).join("");
      expect(() => parseAccountMessage(idZone, junk)).not.toThrow();
      expect(() => parseAccountMessage([userId, fixedZone(1 + rand(5))], junk + id)).not.toThrow();
    }
  });
});
