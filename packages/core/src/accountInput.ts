/**
 * Single-message account input for Game Top-up (e.g. "123456789 1234" = ID + Zone).
 *
 * A wrong parse tops up the WRONG game account, so this parser refuses whenever
 * the message does not map onto the fields unambiguously; it never guesses.
 * Values are returned as the strings the buyer typed (trimmed): never Number(),
 * so leading zeros and 20+ digit IDs stay intact. Per-field rules come only from
 * the SKU's field spec via validateFieldAnswer; this module adds no new ones.
 *
 * Pure: no DB, no logger, never throws.
 */
import { ValidationError } from "./errors";
import { AdditionalFieldType, validateFieldAnswer, type AdditionalField } from "./deliveryFields";

export type ParseAccountFailure =
  | "empty"
  | "missing_field"
  | "too_many"
  | "ambiguous"
  | "unbalanced"
  | "invalid_value";

export type ParseAccountResult =
  | { ok: true; values: Record<string, string> }
  | {
      ok: false;
      reason: ParseAccountFailure;
      field?: string;
      errorKey?: string;
      errorArgs?: Record<string, unknown>;
    };

// Whitespace a buyer (or a copy-paste) can legitimately put between values.
// \v, \f, U+2028/2029 and U+FEFF are deliberately NOT here: they are rejected
// as invisible characters instead of being silently used as separators.
const WS = "\\t\\n\\r \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000";
const TRIM_RE = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
const SEPARATOR_RE = new RegExp(`[${WS},:]+`);
const HAS_SEPARATOR_RE = new RegExp(`[${WS},:]`);
// The tolerated (never advertised) two-field form: A(B) or A (B), nothing else.
const PAREN_FORM_RE = new RegExp(`^([^()${WS},:]+)[${WS}]*\\(([^()${WS},:]+)\\)$`);
// Control, zero-width, bidi and other invisible characters. A value containing
// one is refused: it can make two different accounts look identical on screen.
// Also: combining grapheme joiner, Hangul and halfwidth fillers, braille blank,
// variation selectors, interlinear annotation marks and tag characters.
const FORBIDDEN_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}]/u;
// Telegram's message cap; longer input is refused before any regex work so a
// huge whitespace run cannot make the trim/split patterns slow.
const MAX_TEXT_LENGTH = 4096;
const ASCII_DIGITS_RE = /^[0-9]+$/;

/** True when `value` holds a control, zero-width, bidi or other invisible
 *  character this parser refuses in an account value. Exported so a caller
 *  that reads a value without the parser applies the same rule. */
export function hasForbiddenAccountCharacter(value: string): boolean {
  return FORBIDDEN_RE.test(value);
}

/** A field whose value can only be ASCII digits (NUMBER type or a digit pattern). */
function isDigitField(field: AdditionalField): boolean {
  return field.type === AdditionalFieldType.NUMBER || field.pattern === "^[0-9]+$";
}

/** The fixed digit length of a field (minLength === maxLength), else undefined. */
function fixedDigitLength(field: AdditionalField): number | undefined {
  if (!isDigitField(field)) return undefined;
  if (field.minLength === undefined || field.minLength !== field.maxLength) return undefined;
  return field.minLength;
}

/** Validate each value against its field in order; the first failure wins. */
function validateAll(fields: AdditionalField[], tokens: string[]): ParseAccountResult {
  const entries: Array<[string, string]> = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const token = tokens[i]!;
    let value: string;
    try {
      value = validateFieldAnswer(field, token);
    } catch (err) {
      if (err instanceof ValidationError) {
        return { ok: false, reason: "invalid_value", field: field.key, errorKey: err.key, errorArgs: err.formatArgs };
      }
      return { ok: false, reason: "invalid_value", field: field.key };
    }
    // validateFieldAnswer's trim() strips U+FEFF/U+2028 at the edges, so check
    // the raw token, not the returned value.
    if (hasForbiddenAccountCharacter(token)) {
      return { ok: false, reason: "invalid_value", field: field.key, errorKey: "error.field_invalid_pattern", errorArgs: { key: field.key } };
    }
    entries.push([field.key, value]);
  }
  // fromEntries defines own properties, so no key can reach the prototype.
  return { ok: true, values: Object.fromEntries(entries) };
}

/**
 * Parse one buyer message into values for `fields` (the ordered TEXT/NUMBER
 * fields this message must fill; the caller leaves out select/skipped ones).
 *
 * - 1 field: the whole trimmed text is one value; whitespace, comma or colon
 *   inside it → too_many.
 * - 2+ fields: values are separated by runs of whitespace, comma or colon and
 *   mapped in field order. Every field needs its own value, optional ones too.
 * - Exactly 2 fields also tolerate A(B) / A (B); any other parenthesis → unbalanced.
 * - Too few values: a single all-digit value for 2 fields is split only when the
 *   last field has a fixed digit length; otherwise ambiguous (the digits could
 *   hide the missing value) or missing_field.
 *
 * Caller notes: free-text fields with 2+ fields split on spaces, so multi-word
 * text fields must go through the per-field flow instead; optional fields must
 * be left out of `fields` by the caller if they are to be skipped. `fields = []`
 * and non-string text are handled without throwing; text over 4096 characters
 * is refused as too_many.
 */
export function parseAccountMessage(fields: AdditionalField[], text: string): ParseAccountResult {
  if (typeof text === "string" && text.length > MAX_TEXT_LENGTH) return { ok: false, reason: "too_many" };
  const trimmed = typeof text === "string" ? text.replace(TRIM_RE, "") : "";
  if (!trimmed) return { ok: false, reason: "empty" };
  const n = fields.length;
  if (n === 0) return { ok: false, reason: "too_many" };

  if (n === 1) {
    if (HAS_SEPARATOR_RE.test(trimmed)) return { ok: false, reason: "too_many" };
    return validateAll(fields, [trimmed]);
  }

  if (trimmed.includes("(") || trimmed.includes(")")) {
    const paren = n === 2 ? PAREN_FORM_RE.exec(trimmed) : null;
    if (!paren) return { ok: false, reason: "unbalanced" };
    return validateAll(fields, [paren[1]!, paren[2]!]);
  }

  const tokens = trimmed.split(SEPARATOR_RE).filter((t) => t !== "");
  if (tokens.length > n) return { ok: false, reason: "too_many" };
  if (tokens.length === n) return validateAll(fields, tokens);

  const missing = fields[tokens.length]!;
  const last = tokens[tokens.length - 1];
  if (n === 2 && tokens.length === 1 && last !== undefined && ASCII_DIGITS_RE.test(last)) {
    const zoneLength = fixedDigitLength(fields[1]!);
    if (zoneLength !== undefined && zoneLength > 0 && last.length > zoneLength) {
      return validateAll(fields, [last.slice(0, -zoneLength), last.slice(-zoneLength)]);
    }
  }
  // Ambiguous: the last value is all digits, the missing field takes digits too,
  // and the value is long enough to contain both (each at its minimum length).
  if (last !== undefined && ASCII_DIGITS_RE.test(last) && isDigitField(missing)) {
    const lastField = fields[tokens.length - 1]!;
    const room = Math.max(lastField.minLength ?? 1, 1) + Math.max(missing.minLength ?? 1, 1);
    if (last.length >= room) return { ok: false, reason: "ambiguous", field: missing.key };
  }
  return { ok: false, reason: "missing_field", field: missing.key };
}
