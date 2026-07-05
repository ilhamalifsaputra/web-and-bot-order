/**
 * Client-side twin of packages/core/src/i18n.ts — same flat locale JSONs
 * (imported at build time, both languages ship in the bundle), same lookup
 * semantics: user language → English fallback → the raw key, and {placeholder}
 * substitution that leaves the template intact when a placeholder is missing.
 *
 * The page language comes from <html lang>, which the SPA shell
 * (apps/storefront/src/routes/spaShell.ts) substitutes per request from the
 * shop_lang cookie — the same requestLang() the Nunjucks pages used.
 */
import en from "../../../../../packages/core/locales/en.json";
import id from "../../../../../packages/core/locales/id.json";

const LOCALES: Record<string, Record<string, string>> = { en, id };

/** "en" | "id" from <html lang>; anything else (e.g. the raw __LANG__
 * placeholder under `vite dev`) falls back to "en". */
export function currentLang(): string {
  const lang = (document.documentElement.lang || "").toLowerCase();
  return lang in LOCALES ? lang : "en";
}

/** Replace {name} tokens. Leaves the template intact if a token is missing. */
function format(template: string, args: Record<string, unknown>): string {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (raw, name: string) => {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      return String(args[name]);
    }
    missing = true;
    return raw;
  });
  return missing ? template : out;
}

/**
 * Look up `key` in `lang` (default: the page language) with English fallback,
 * then the key itself.
 */
export function t(key: string, args: Record<string, unknown> = {}, lang = currentLang()): string {
  const normalized = lang in LOCALES ? lang : "en";
  let template = LOCALES[normalized]?.[key];
  if (template === undefined && normalized !== "en") template = LOCALES.en?.[key];
  if (template === undefined) return key;
  if (Object.keys(args).length === 0) return template;
  return format(template, args);
}
