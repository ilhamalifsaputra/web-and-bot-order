/**
 * The JSON body a route sends when it refuses a request with an i18n key
 * (whole-branch review F4a).
 *
 * ## The bug this closes
 *
 * Half this shop's refusal copy names a figure: `error.amount_below_rail_minimum`
 * reads "That total is below the minimum this payment method accepts ({min}
 * {currency})", `error.cart_too_large` names a `{limit}`, `error.text_too_long` a
 * `{max}`. Every one of those figures already travels with the error — an
 * `AppError` carries `formatArgs` for exactly this — and the bot fills the braces
 * from it. The storefront threw them away: each route sent `{ error: e.key }` and
 * the SPA's fetch layer turned that into `new Error(body.error)`, so by the time
 * `t()` ran there were no args, and `t()` leaves a template it cannot fill
 * INTACT. The buyer read the braces verbatim and was told nothing about how much
 * more they needed.
 *
 * The fix belongs here rather than in each message because the failure is
 * structural: any key with a placeholder breaks on this surface, including ones
 * added later. (D9 worked around it the only way it could at the time — by
 * writing the wallet-top-up refusals with no placeholders at all. Those keys stay
 * placeholder-free; `locales.test.ts` pins them, and this change simply means the
 * next such message no longer has to be.)
 *
 * ## Shape
 *
 * `{ error: "<key>" }`, plus `error_args` ONLY when the message's own copy names a
 * `{placeholder}` the error can fill. Two reasons for the omission rather than an
 * always-present object: a body that grows a constant `error_args: {}` is noise
 * every reader and every `toEqual` assertion in the test suite has to account for,
 * and "no args" is genuinely different from "args, all empty" for a client
 * deciding whether to format at all.
 *
 * ## Only what the sentence asks for
 *
 * `formatArgs` is a developer-facing bag — several errors carry fields their copy
 * never mentions (`error.field_required` names none at all, yet is thrown with the
 * offending field's key). Those are of no use to the page and have no business in
 * a buyer-facing response, so the args are intersected with the placeholders the
 * message actually names, read from the English template. English is the right
 * side to read: `locales.test.ts` pins both languages to the SAME placeholder set,
 * so either answers the question, and English is the fallback `t()` itself uses.
 * A key with no template at all (`t` returns the key, which has no braces)
 * contributes no placeholders and therefore no args — the page shows the bare key
 * in that case anyway, so nothing is lost.
 *
 * Values are stringified because this is JSON on its way into a `{placeholder}`
 * substitution: a Decimal must arrive as the digits an admin typed, not as
 * whatever `JSON.stringify` makes of the object. Non-primitive values are dropped
 * instead of being rendered as "[object Object]" — a figure that cannot be shown
 * is better missing (leaving `t()` to render the template it was given) than
 * shown as gibberish.
 */
import type { AppError } from "@app/core/errors";
import { t } from "@app/core/i18n";

/** The `{placeholder}` names `key`'s English copy contains. */
function placeholdersOf(key: string): Set<string> {
  // `t(key, "en")` with no args returns the template verbatim (and the key itself
  // when there is no such message, which has no braces to find).
  return new Set([...t(key, "en").matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
}

/** Anything worth substituting into a sentence: a string, a number, a boolean, or
 * a Decimal (any object with a real `toString`). */
function renderArg(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object" && value.toString !== Object.prototype.toString) {
    return String(value); // Decimal and friends
  }
  return null;
}

export interface ErrorBody {
  error: string;
  error_args?: Record<string, string>;
}

/**
 * Serialize an `AppError`/`ValidationError` for the SPA: its key, and the figures
 * its copy names. Use this everywhere a storefront route catches one, so a new
 * message with a placeholder in it works without touching the route.
 */
export function errorBody(e: AppError): ErrorBody {
  const wanted = placeholdersOf(e.key);
  const args: Record<string, string> = {};
  if (wanted.size > 0) {
    for (const [name, value] of Object.entries(e.formatArgs ?? {})) {
      if (!wanted.has(name)) continue;
      const rendered = renderArg(value);
      if (rendered !== null) args[name] = rendered;
    }
  }
  return Object.keys(args).length > 0 ? { error: e.key, error_args: args } : { error: e.key };
}
