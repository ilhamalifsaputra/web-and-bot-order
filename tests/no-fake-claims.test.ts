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
/** Matches `//` line comments. */
const LINE_COMMENT_RE = /\/\/.*$/gm;

interface ExtractedLiteral {
  value: string;
  start: number;
  end: number;
}

/**
 * Extracts string/template literals from raw TSX source, correctly excluding
 * any literal that actually lives inside a comment.
 *
 * Order matters here: literals are found in the RAW text FIRST and their
 * contents (including the surrounding quotes) are blanked out — replaced
 * with same-length whitespace — BEFORE comment detection ever runs. An
 * earlier version of this scan stripped comments first, which is unsound:
 * comment-detection on raw source can be fooled by a `//` or `/* *\/` that
 * appears *inside* a real string literal. Confirmed case in this codebase —
 * `apps/storefront/client/src/pages/LoginPage.tsx` and `RegisterPage.tsx`
 * both contain `!raw.startsWith("//")`, a real `"//"` literal. Stripping
 * `//` comments first misreads that literal's `//` as a line-comment start,
 * deleting the closing quote and everything after it on that line, which
 * then leaves the opening quote dangling — the literal-extraction regex
 * then runs it forward to the next unrelated `"` later in the file,
 * merging unrelated statements into one corrupted "literal" (and can
 * silently swallow a genuine literal that falls inside that span). Blanking
 * literals first means comment detection never sees a `//`/`/* *\/` that
 * lives inside a string, so it can only ever match a real comment.
 */
function extractLiterals(text: string): string[] {
  const literals: ExtractedLiteral[] = [];
  let m: RegExpExecArray | null;
  STRING_LITERAL_RE.lastIndex = 0;
  while ((m = STRING_LITERAL_RE.exec(text))) {
    literals.push({ value: m[0].slice(1, -1), start: m.index, end: m.index + m[0].length });
  }

  let blanked = text;
  for (const lit of literals) {
    blanked = blanked.slice(0, lit.start) + " ".repeat(lit.end - lit.start) + blanked.slice(lit.end);
  }

  const commentRanges: Array<[number, number]> = [];
  BLOCK_COMMENT_RE.lastIndex = 0;
  while ((m = BLOCK_COMMENT_RE.exec(blanked))) commentRanges.push([m.index, m.index + m[0].length]);
  LINE_COMMENT_RE.lastIndex = 0;
  while ((m = LINE_COMMENT_RE.exec(blanked))) commentRanges.push([m.index, m.index + m[0].length]);

  return literals
    .filter((lit) => !commentRanges.some(([s, e]) => lit.start >= s && lit.start < e))
    .map((lit) => lit.value);
}

function loadStorefrontTsxFiles(): Array<{ file: string; literals: string[] }> {
  return (readdirSync(STOREFRONT_SRC_DIR, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    // Excludes any path with a directory segment literally named `dev`, which is
    // intentionally broader than just `pages/dev/**` — harmless today because
    // `pages/dev` is the only `dev`-named directory under storefront src, but
    // worth knowing this isn't a typo'd/narrower match.
    .filter((f) => !f.split(/[\\/]/).includes("dev"))
    .map((f) => {
      const relFile = `apps/storefront/client/src/${f.split("\\").join("/")}`;
      const raw = readFileSync(join(STOREFRONT_SRC_DIR, f), "utf8");
      return { file: relFile, literals: extractLiterals(raw) };
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

describe("extractLiterals: comment/literal extraction order", () => {
  it("keeps a real \"//\"-shaped literal intact and still excludes literals inside comments", () => {
    // Mirrors the confirmed bug shape from LoginPage.tsx/RegisterPage.tsx: a
    // real `"//"` string literal, plus comments (line and block) that happen
    // to contain quoted phrases of their own — the exact combination that
    // corrupted extraction when comments were stripped before literals were
    // extracted.
    const fixture = [
      'function check(raw: string) {',
      '  if (!raw.startsWith("//")) return "safe";',
      '}',
      '// a real line comment mentioning "instant" delivery in passing',
      '/* a block comment with an example literal "instant delivery" inside */',
      'const claim = "instant delivery";',
    ].join("\n");

    const literals = extractLiterals(fixture);

    // The "//" literal must survive intact, not be merged with everything
    // that follows it in the file.
    expect(literals).toContain("//");
    expect(literals).toContain("safe");
    // The genuine code literal is kept...
    expect(literals).toContain("instant delivery");
    // ...but it must appear exactly once: the quoted phrases inside the line
    // comment ("instant") and the block comment ("instant delivery") must be
    // excluded, not counted as hardcoded literals.
    expect(literals.filter((l) => l === "instant delivery")).toHaveLength(1);
    expect(literals).not.toContain("instant");
    // Nothing should have merged into one corrupted multi-line blob.
    for (const literal of literals) expect(literal).not.toContain("\n");
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
