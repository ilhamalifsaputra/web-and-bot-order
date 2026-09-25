/**
 * Anti-regression guard: buyer-facing locale copy must never state things the
 * shop cannot prove — customer counts, round-the-clock support, fixed
 * response/delivery times, blanket warranty or "instant" promises.
 *
 * Scans every string in packages/core/locales/*.json (bot + storefront copy),
 * plus every string literal hardcoded directly in storefront TSX (buyer-facing
 * copy is expected to route through t("web.*") locale keys, but this catches
 * any marketing claim written straight into a component instead).
 *
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
const STOREFRONT_SRC_DIR = join(__dirname, "..", "apps", "storefront", "client", "src");

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

/** Matches single-, double-, and template-quoted string literals in raw TSX source. */
const STRING_LITERAL_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
/** Matches `/* ... *\/` block comments, including the `{/* ... *\/}` JSX comment form. */
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
/**
 * Matches `//` line comments, but not a `//` immediately after `:` (so
 * `https://...` inside a string literal survives). Comment prose in this
 * codebase is full of possessive apostrophes ("ProductPage's own fetch"),
 * which the string-literal regex below would otherwise misread as an
 * opening `'` and run off matching to the next apostrophe several lines
 * later — stripping comments first avoids that.
 */
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;

function loadStorefrontTsxFiles(): Array<{ file: string; literals: string[] }> {
  return (readdirSync(STOREFRONT_SRC_DIR, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .filter((f) => !f.split(/[\\/]/).includes("dev"))
    .map((f) => {
      const relFile = `apps/storefront/client/src/${f.split("\\").join("/")}`;
      const raw = readFileSync(join(STOREFRONT_SRC_DIR, f), "utf8");
      // Strip comments first — a quoted/apostrophe'd phrase inside a comment
      // explaining rendered copy isn't itself rendered copy, and would
      // otherwise false-positive (or corrupt subsequent matches) against
      // FORBIDDEN.
      const withoutComments = raw.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");
      const literals = withoutComments.match(STRING_LITERAL_RE) ?? [];
      return { file: relFile, literals: literals.map((l) => l.slice(1, -1)) };
    });
}

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

describe("no unsupported claims hardcoded directly in storefront TSX", () => {
  // Buyer-facing storefront copy is expected to route through t("web.*") locale
  // keys (covered above), not literal strings in components. This scan catches
  // marketing claims written straight into a .tsx file instead of a locale key.
  // web-admin is excluded: it's operator-facing, not buyer-facing, and has no
  // i18n layer at all, so scanning it would flood false positives against
  // ordinary admin UI copy. pages/dev/** is excluded: it's a DEV-only gallery
  // gated by import.meta.env.DEV and never ships in the production bundle.
  const files = loadStorefrontTsxFiles();

  it("scans a non-trivial number of storefront TSX files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("contains no forbidden claim in any hardcoded TSX string literal", () => {
    const hits: string[] = [];
    for (const { file, literals } of files) {
      for (const literal of literals) {
        for (const { why, pattern } of FORBIDDEN) {
          const m = pattern.exec(literal);
          if (m) hits.push(`${file} › "${literal}" — ${why}`);
        }
      }
    }
    expect(
      hits,
      `Unsupported claims found hardcoded in storefront TSX (route through a t("web.*") locale key and reword as an always-true statement):\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});
