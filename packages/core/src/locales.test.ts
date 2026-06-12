/**
 * Locale integrity guard (WEB.md / feedback §8.8). The bot UI is the customer's
 * whole experience — a key present in one language but not the other means a
 * raw key or a fallback leaks to the user. This test fails the moment en/id
 * drift apart, in keys OR in their `{placeholder}` sets.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "locales");
const load = (lang: string): Record<string, string> =>
  JSON.parse(readFileSync(join(LOCALES_DIR, `${lang}.json`), "utf8"));

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe("locale parity (en ↔ id)", () => {
  const en = load("en");
  const id = load("id");

  it("both languages define exactly the same keys", () => {
    const enKeys = Object.keys(en).sort();
    const idKeys = Object.keys(id).sort();
    const missingInId = enKeys.filter((k) => !(k in id));
    const missingInEn = idKeys.filter((k) => !(k in en));
    expect({ missingInId, missingInEn }).toEqual({ missingInId: [], missingInEn: [] });
  });

  it("each key has the same {placeholder} set in both languages", () => {
    const mismatches: Record<string, { en: string[]; id: string[] }> = {};
    for (const key of Object.keys(en)) {
      if (!(key in id)) continue;
      const a = placeholders(en[key]!);
      const b = placeholders(id[key]!);
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatches[key] = { en: a, id: b };
    }
    expect(mismatches).toEqual({});
  });
});
