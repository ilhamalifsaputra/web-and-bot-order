/**
 * Tiny i18n layer — port of Python `bot/utils/i18n.py`.
 *
 * Locale files are flat JSON: {"start.welcome": "Welcome!", ...}. Lookup falls
 * back to English if a key is missing in the user's language, then to the raw
 * key itself. Supports {placeholder} substitution via str.format semantics:
 * a missing placeholder leaves the template unformatted rather than crashing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/ -> ../locales (package root). Overridable via env because the relative
// path breaks once bundled (import.meta.url moves to dist/). See
// DEPLOY-HOSTINGER.md §3.
const LOCALES_DIR = process.env.LOCALES_DIR ?? join(HERE, "..", "locales");
const SUPPORTED = ["en", "id"] as const;
type Lang = (typeof SUPPORTED)[number];

const cache = new Map<string, Record<string, string>>();

function load(lang: string): Record<string, string> {
  const cached = cache.get(lang);
  if (cached) return cached;
  let data: Record<string, string> = {};
  try {
    data = JSON.parse(readFileSync(join(LOCALES_DIR, `${lang}.json`), "utf-8"));
  } catch {
    data = {};
  }
  cache.set(lang, data);
  return data;
}

/** Replace {name} tokens. Leaves the template intact if a token is missing. */
function format(template: string, args: Record<string, unknown>): string {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      return String(args[name]);
    }
    missing = true;
    return _m;
  });
  return missing ? template : out;
}

/**
 * Look up `key` in `lang` with English fallback, then the key itself.
 * @param args optional {placeholder} substitutions
 */
export function t(
  key: string,
  lang = "en",
  args: Record<string, unknown> = {},
): string {
  let l = (lang || "en").toLowerCase();
  if (!SUPPORTED.includes(l as Lang)) l = "en";

  let template = load(l)[key];
  if (template === undefined && l !== "en") template = load("en")[key];
  if (template === undefined) return key;

  if (Object.keys(args).length === 0) return template;
  return format(template, args);
}
