/**
 * Anti-regression guard: buyer-facing locale copy must never state things the
 * shop cannot prove — customer counts, round-the-clock support, fixed
 * response/delivery times, blanket warranty or "instant" promises.
 *
 * Scans every string in packages/core/locales/*.json (bot + storefront copy).
 * If this fails you probably added marketing copy that reads as a fact. Reword
 * it as an always-true statement ("delivered automatically after payment is
 * confirmed, where available", "warranty as listed on each plan") rather than
 * adding an exception — the shop's rule is that nothing shown to a buyer may be
 * unsupported or misleading. An `allowKeys` entry is only for copy that is
 * genuinely conditional or about something other than the shop's own promise,
 * and must say why.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LOCALES_DIR = join(__dirname, "..", "packages", "core", "locales");

interface Forbidden {
  why: string;
  pattern: RegExp;
  /** Keys exempt from THIS pattern only (any language file). */
  allowKeys?: Record<string, string>;
}

/**
 * How long the BLOCKCHAIN takes to confirm a USDT transfer — hedged with
 * "usually" and outside the shop's control, not a promise about the shop's own
 * delivery or reply time.
 */
const BLOCKCHAIN_TIMING: Record<string, string> = {
  "checkout.bybit_bsc_instructions": "blockchain confirmation estimate",
  "web.pay_bybit_bsc_sub": "blockchain confirmation estimate",
  "web.pay_bybit_bsc_note": "blockchain confirmation estimate",
  "web.pay_confirming_sub": "blockchain confirmation estimate",
};

const FORBIDDEN: Forbidden[] = [
  {
    why: "customer-count claim (nothing verifies who or how many bought)",
    pattern:
      /\d{1,3}(?:[.,]\d{3})+\s*\+|\b\d+\s*\+\s*(?:customers|buyers|orders|users|pelanggan|pembeli|pesanan|pengguna)\b|(?:thousands|ribuan)\s+(?:of\s+)?(?:customers|buyers|orders|pelanggan|pembeli|pesanan)/i,
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
      /(?:under|within|less than)\s+(?:an?\s+|\d+\s+)hours?\b|di\s*bawah\s+\d+\s+jam|dalam\s+\d+\s+jam|kurang\s+dari\s+(?:satu|1|\d+)\s+jam|replies under/i,
  },
  {
    why: "fixed delivery/reply time in minutes",
    pattern:
      /\b\d+\s*[–-]\s*\d+\s*(?:minutes?|mins?|menit)\b|\b(?:under|within|less than|in|dalam|kurang\s+dari|di\s*bawah)\s+(?:about\s+|around\s+|sekitar\s+)?\d+\s*(?:minutes?|mins?|menit)\b|\bin minutes\b|within minutes|hitungan\s+menit/i,
    allowKeys: BLOCKCHAIN_TIMING,
  },
  {
    why: "blanket warranty promise (warranty is per plan and can be 0 days)",
    pattern:
      /every\s+(?:product|order|unit|account)\b[^.]*\b(?:covered|warrant)|warranty on every order|garansi\s+di\s+setiap\s+pesanan|\d+-day\s+(?:replacement\s+)?warranty|garansi\s+replacement\s+\d+\s+hari|produk\s+bergaransi|warranty\s+included|garansi\s+termasuk/i,
  },
  {
    why: "blanket 'instant' promise (manual, top-up and out-of-stock products are not instant)",
    pattern:
      /instant delivery|delivered instantly|\binstantly\b|pengiriman\s+instan|terkirim\s+instan|dikirim\s+instan|(?:confirmed|automatic|otomatis)\s*(?:and|&)\s*instan/i,
    allowKeys: {
      "web.badge_instant": "the product-card chip, which the client only renders for an auto product with stock",
      "web.pay_wallet_idr_sub": "paying from a wallet balance is immediate; not a delivery promise",
      "web.pay_wallet_usdt_sub": "paying from a wallet balance is immediate; not a delivery promise",
    },
  },
  {
    why: "teaser for a service line that does not exist",
    pattern: /coming soon|segera hadir/i,
  },
];

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
        for (const { why, pattern, allowKeys } of FORBIDDEN) {
          if (allowKeys && key in allowKeys) continue;
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

  it("only allowlists keys that exist, so a renamed key cannot leave a silent hole", () => {
    const keys = new Set(locales.flatMap((l) => l.entries.map(([k]) => k)));
    for (const { allowKeys } of FORBIDDEN) {
      for (const k of Object.keys(allowKeys ?? {})) expect(keys.has(k), `allowKeys names unknown key ${k}`).toBe(true);
    }
  });
});
