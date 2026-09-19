/**
 * Rendering a failed API call as a sentence for the buyer (whole-branch review
 * F4a).
 *
 * The problem this exists to solve: a refusal's wording and the figures it quotes
 * arrive separately. `api/client.ts` throws an Error whose `message` is the
 * server's i18n key and whose `errorArgs` are the `{placeholder}` values the copy
 * names — so a page that renders `t(err.message)` and nothing else shows the
 * buyer literal braces for every message that quotes a number, which is about
 * half of them ("below the minimum this payment method accepts ({min}
 * {currency})", "at most {max} characters", "up to {limit} items").
 *
 * Everything here therefore takes the ERROR, not a message string. A page that
 * only keeps `err.message` in state has already thrown the figures away, which is
 * why these helpers are the form to reach for.
 *
 * Both helpers are pure supersets of what the call sites did before: with no args
 * present they call `t()` exactly as the pages used to, so every message that
 * names no figure renders byte-identically.
 */
import { t } from "./i18n";

/** The shape `api/client.ts` throws — re-declared structurally so this module
 * stays usable for anything error-like (a react-query `error`, a caught
 * `unknown`) without importing the API layer. */
interface ErrorWithArgs {
  message?: unknown;
  errorArgs?: unknown;
}

/** The `{placeholder}` values a failure carries, or `{}` when it carries none.
 * Only string values survive: `t()` substitutes by stringifying, and an object
 * reaching a sentence as "[object Object]" is worse than an unfilled template. */
export function errorArgsOf(err: unknown): Record<string, string> {
  const raw = (err as ErrorWithArgs | null | undefined)?.errorArgs;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** The i18n key a failure carries, or null when it is not an Error with a
 * message (a thrown string, a rejected non-Error). */
function messageOf(err: unknown): string | null {
  const message = (err as ErrorWithArgs | null | undefined)?.message;
  return typeof message === "string" && message !== "" ? message : null;
}

/**
 * Translate a failure's key, filling the figures its copy names.
 *
 * Mirrors the `t(err.message)` the call sites used to do, INCLUDING its tolerance
 * for a message that is not a known key (`t` returns the key itself, which is how
 * these pages have always behaved). Use `humanError` instead where a raw
 * developer message must never reach the page.
 */
export function tError(err: unknown, fallbackKey = "error.generic"): string {
  const key = messageOf(err) ?? fallbackKey;
  return t(key, errorArgsOf(err));
}

/**
 * Translate a failure's key, or apologise generically when it carries no key of
 * ours.
 *
 * The `web.`/`error.` prefix test is the existing convention (it was duplicated
 * as a local `humanError` in CheckoutPage/InstantBuyPage/WalletTopupPage): the
 * server's own refusals arrive as i18n keys, and anything else — a transport
 * failure, a 500's "<path> responded 500" — is a developer string that must never
 * be shown to a buyer.
 */
export function humanError(err: unknown, genericKey = "web.error_message"): string {
  const key = messageOf(err);
  if (!key || !(key.startsWith("web.") || key.startsWith("error."))) return t(genericKey);
  return t(key, errorArgsOf(err));
}
