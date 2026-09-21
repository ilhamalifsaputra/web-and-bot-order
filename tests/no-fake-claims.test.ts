/**
 * Anti-regression guard: buyer-facing locale copy must never state things the
 * shop cannot prove — customer counts, round-the-clock support, fixed
 * response/delivery times, blanket warranty promises.
 *
 * Scans every string in packages/core/locales/*.json (bot + storefront copy).
 * If this fails you probably added marketing copy that reads as a fact. Reword
 * it as an always-true statement ("delivered automatically after payment is
 * confirmed", "warranty as listed on each plan") rather than adding an
 * exception — the shop's rule is that nothing shown to a buyer may be
 * unsupported or misleading.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LOCALES_DIR = join(__dirname, "..", "packages", "core", "locales");

interface Forbidden {
  why: string;
  pattern: RegExp;
}

const FORBIDDEN: Forbidden[] = [
  {
    why: "customer-count claim (nothing verifies who or how many bought)",
    pattern: /\d{1,3}(?:[.,]\d{3})+\s*\+|\b\d+\s*\+\s*(?:customers|pelanggan|users|pengguna)\b/i,
  },
  {
    why: "social-proof claim about crowds of customers",
    pattern: /trusted by (?:thousands|millions|\d)|dipercaya\s+(?:ribuan|jutaan|\d)/i,
  },
  {
    why: "round-the-clock availability claim",
    pattern:
      /24\s*\/\s*7|24\s*x\s*7|24\s+hours\s+a\s+day|around\s+the\s+clock|24\s+jam|setiap\s+saat/i,
  },
  {
    why: "fixed reply-time claim",
    pattern:
      /(?:under|within|less than)\s+(?:an?\s+|\d+\s+)hours?\b|di\s+bawah\s+\d+\s+jam|dalam\s+\d+\s+jam|replies under/i,
  },
  {
    why: "fixed delivery-time promise in minutes",
    pattern:
      /\b\d+\s*[–-]\s*\d+\s*(?:minutes|menit)\b|(?:under|within|less than)\s+\d+\s+minutes|di\s+bawah\s+\d+\s+menit|\bin minutes\b|within minutes|hitungan\s+menit/i,
  },
  {
    why: "blanket warranty promise (warranty is per plan and can be 0 days)",
    pattern:
      /every\s+(?:product|order|unit|account)\b[^.]*\b(?:covered|warrant)|warranty on every order|garansi\s+di\s+setiap\s+pesanan|\d+-day\s+(?:replacement\s+)?warranty|garansi\s+replacement\s+\d+\s+hari|produk\s+bergaransi|warranty\s+included|garansi\s+termasuk/i,
  },
  {
    why: "teaser for a service line that does not exist",
    pattern: /coming soon|segera hadir/i,
  },
];

/**
 * Keys allowed to name a duration. These quote how long the BLOCKCHAIN takes to
 * confirm a USDT transfer (hedged with "usually", and outside the shop's
 * control) — not a promise about the shop's own delivery or reply time.
 */
const ALLOWED_DURATION_KEYS = new Set([
  "checkout.bybit_bsc_instructions",
  "web.pay_bybit_bsc_sub",
  "web.pay_bybit_bsc_note",
  "web.pay_confirming_sub",
]);

function loadLocales(): Array<{ file: string; entries: Array<[string, string]> }> {
  return readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8")) as Record<string, unknown>;
      const entries = Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string");
      return { file, entries };
    });
}

describe("no unsupported claims in buyer-facing locale copy", () => {
  const locales = loadLocales();

  it("scans both the English and Indonesian locale files", () => {
    expect(locales.map((l) => l.file).sort()).toEqual(["en.json", "id.json"]);
    for (const l of locales) expect(l.entries.length).toBeGreaterThan(500);
  });

  it("contains no forbidden claim in any string", () => {
    const hits: string[] = [];
    for (const { file, entries } of locales) {
      for (const [key, value] of entries) {
        for (const { why, pattern } of FORBIDDEN) {
          if (ALLOWED_DURATION_KEYS.has(key) && why.includes("minutes")) continue;
          const m = pattern.exec(value);
          if (m) hits.push(`${file} › ${key}: "${m[0]}" — ${why}`);
        }
      }
    }
    expect(
      hits,
      `Unsupported claims found in locale copy (reword as an always-true statement):\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});
