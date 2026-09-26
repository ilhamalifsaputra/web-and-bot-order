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

/**
 * Single global regex tokenizing raw TSX source into comment tokens and
 * string/template-literal tokens. Each alternative's leading character is
 * mutually exclusive with the others (`/` can only start a comment, `"`/`'`/
 * `` ` `` can only start a string), and each alternative consumes its ENTIRE
 * token in one match — a full line comment to end-of-line, a full block
 * comment to its closing `*​/`, a full string to its own closing quote
 * respecting `\`-escapes. That means the scan's `lastIndex` always jumps
 * past a whole token before continuing, so content inside a matched comment
 * is never re-examined for a string start, and content inside a matched
 * string is never re-examined for a comment start.
 */
const TOKEN_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/**
 * Extracts string/template literals from raw TSX source, correctly excluding
 * any literal that lives inside a comment — in BOTH directions at once.
 *
 * This must be a single left-to-right pass, not two independent regex
 * passes in either order, because comment syntax and string syntax are
 * mutually context-dependent: whether a `/` starts a comment depends on
 * whether you're already inside a string, and whether a `"`/`'` starts a
 * string depends on whether you're already inside a comment. Two prior
 * attempts at this guard each got exactly one of those directions wrong:
 *
 *   - Stripping comments first (pass 1) is unsound because comment
 *     detection on raw source can be fooled by a `//` that appears *inside*
 *     a real string literal. Confirmed case: `apps/storefront/client/src/
 *     pages/LoginPage.tsx` and `RegisterPage.tsx` both contain
 *     `!raw.startsWith("//")` — a real `"//"` literal. Stripping `//`
 *     comments first misreads that literal's `//` as a line-comment start,
 *     corrupting the rest of the file's literal boundaries.
 *   - Extracting literals from raw text first, then blanking them before
 *     detecting comments (pass 2, the previous fix), reintroduces the same
 *     class of bug in the OPPOSITE direction: an unescaped apostrophe
 *     inside comment prose (e.g. `// ProductPage's own fetch`) looks
 *     exactly like a string-literal start to the raw-text literal scan,
 *     before anything knows it's inside a comment — corrupting 21 files
 *     including `InstantBuyPage.tsx`.
 *
 * A single pass with mutually-exclusive, whole-token-consuming
 * alternatives sidesteps this: whichever kind of token starts first at the
 * current scan position is the one that matches, and it swallows its own
 * content wholesale (including any character that would otherwise look
 * like the start of the other kind) before the scan moves on.
 *
 * Known, accepted limitations (matching the original brief's "crude regex,
 * not full parse" scope): a `/` that's actually division (not a comment)
 * could theoretically confuse this, but TSX source essentially never has
 * bare division adjacent to a lone `/` in a way that looks like `//` or
 * `/*`; nested `${...}` interpolation inside a template literal isn't
 * specially handled (a backtick-delimited match is greedy to the next
 * backtick). Regex literals and JSX-specific tokenization are out of scope.
 */
function extractLiterals(text: string): string[] {
  const literals: string[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text))) {
    const tok = m[0];
    const first = tok[0];
    if (first === '"' || first === "'" || first === "`") {
      literals.push(tok.slice(1, -1));
    }
    // else: a comment token — deliberately skip, contributing nothing to
    // `literals`. Its content is never re-scanned for a string start
    // because lastIndex has already moved past it in this single pass.
  }
  return literals;
}

/**
 * Same tokenization as `extractLiterals`, but also reports each literal's
 * opening delimiter. Used only by the corpus-wide newline invariant below:
 * a raw newline inside a `"`/`'`-delimited literal is invalid JS/TSX syntax
 * (the file wouldn't compile), so seeing one can only mean the extraction
 * itself is corrupted — that's the exact shape both prior regressions took.
 * A backtick-delimited template literal is different: it can legitimately
 * span multiple lines when it wraps a multi-line `${...}` expression, which
 * is a real, common pattern in this codebase (multi-line conditional
 * Tailwind `className` strings — see e.g. `Footer.tsx`, `TicketRow.tsx`,
 * `Stepper.tsx`). Lumping template literals into the same newline check
 * would flag that legitimate style as if it were corruption.
 */
function extractLiteralsWithDelimiter(text: string): Array<{ value: string; quote: '"' | "'" | "`" }> {
  const out: Array<{ value: string; quote: '"' | "'" | "`" }> = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text))) {
    const tok = m[0];
    const first = tok[0];
    if (first === '"' || first === "'" || first === "`") {
      out.push({ value: tok.slice(1, -1), quote: first });
    }
  }
  return out;
}

function loadStorefrontTsxFiles(): Array<{ file: string; literals: string[]; quotedLiterals: string[] }> {
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
      const detailed = extractLiteralsWithDelimiter(raw);
      return {
        file: relFile,
        literals: detailed.map((d) => d.value),
        quotedLiterals: detailed.filter((d) => d.quote !== "`").map((d) => d.value),
      };
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

describe("extractLiterals: single-pass tokenizer handles both directions", () => {
  it("keeps a real \"//\"-shaped literal intact (direction 1: string containing comment-like text)", () => {
    // Mirrors the confirmed bug shape from LoginPage.tsx/RegisterPage.tsx: a
    // real `"//"` string literal. A two-pass "strip comments first" approach
    // misreads this literal's `//` as a line-comment start and corrupts
    // everything after it on the line (and beyond, once quote parity shifts).
    const fixture = [
      'function check(raw: string) {',
      '  if (!raw.startsWith("//")) return "safe";',
      '}',
    ].join("\n");

    const literals = extractLiterals(fixture);

    expect(literals).toContain("//");
    expect(literals).toContain("safe");
    for (const literal of literals) expect(literal).not.toContain("\n");
  });

  it("excludes quoted phrases inside comments, including an apostrophe in comment prose (direction 2: comment containing string-like text)", () => {
    // Mirrors the confirmed bug shape from ProductCard.tsx/InstantBuyPage.tsx:
    // comments containing quoted phrases and possessive apostrophes. A
    // two-pass "extract literals from raw text first" approach misreads the
    // apostrophe (`ProductPage's`) as opening a string literal and runs the
    // match forward to the next unrelated apostrophe/quote later in the
    // file, merging unrelated code into one corrupted "literal".
    const fixture = [
      "// a real line comment mentioning \"instant\" delivery in passing",
      "// ProductPage's own fetch, not this component's own useQuery",
      "/* a block comment with an example literal \"instant delivery\" inside */",
      'const claim = "instant delivery";',
      'const other = "unrelated code that must not be swallowed";',
    ].join("\n");

    const literals = extractLiterals(fixture);

    // The genuine code literal is kept, exactly once...
    expect(literals.filter((l) => l === "instant delivery")).toHaveLength(1);
    // ...but the comment-only quoted phrase and the code after the
    // apostrophe-containing comments must not be merged or lost.
    expect(literals).not.toContain("instant");
    expect(literals).toContain("unrelated code that must not be swallowed");
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

  it("extracts no quote-delimited literal containing a newline, across every scanned file (corpus-wide extraction-correctness check)", () => {
    // This is the check that would have caught BOTH prior regressions: a
    // `"`/`'`-delimited literal can NEVER legitimately contain a raw newline
    // in valid JS/TSX (that's a hard syntax rule, not a style convention —
    // the file wouldn't compile otherwise), so a newline inside one of these
    // is exactly the signature of the two-pass corruption bug, in either
    // direction (comment text merged into a string across a line break, or
    // code merged into a corrupted multi-line blob). Checking only the 2-4
    // files named in the brief is exactly how the previous two fix passes
    // each missed a regression elsewhere in the corpus — this asserts the
    // invariant across all 118 scanned files, not a hand-picked few.
    //
    // Deliberately scoped to `quotedLiterals` (excludes backtick template
    // literals): unlike `"`/`'` strings, a backtick template literal CAN
    // legitimately span multiple lines when it wraps a multi-line `${...}`
    // expression, which is a real, common pattern in this codebase (e.g.
    // multi-line conditional Tailwind `className` strings in `Footer.tsx`,
    // `TicketRow.tsx`, `Stepper.tsx`, `CategoryPage.tsx`, and others —
    // confirmed by direct inspection, not assumed). Including those would
    // turn a legitimate style choice into a false positive; it would not
    // catch any additional corruption, since both confirmed prior
    // regressions manifested in `"`/`'`-delimited literals, not backticks.
    //
    // Known gap (accepted, not a defect to fix here — per this guard's own
    // brief, nested `${...}` interpolation inside a template literal isn't
    // specially handled): this check has NO correctness coverage for
    // backtick-literal mis-tokenization. A real example exists in this repo
    // today — apps/storefront/client/src/pages/ProductPage.tsx's WhatsApp
    // share link nests a template literal inside `encodeURIComponent(...)`,
    // which the tokenizer splits into two garbage single-line backtick
    // fragments. Confirmed (final review pass) that this garbage stays
    // single-line and self-contained — it does not corrupt any subsequent
    // literal in the file — so it's invisible to this newline check by
    // construction, not just by scope. FORBIDDEN-pattern detection is
    // unaffected either way (substring search still finds a real violation
    // even inside a garbage span).
    const offenders: string[] = [];
    for (const { file, quotedLiterals } of files) {
      for (const literal of quotedLiterals) {
        if (literal.includes("\n")) {
          offenders.push(`${file} › ${JSON.stringify(literal.slice(0, 80))}${literal.length > 80 ? "…" : ""}`);
        }
      }
    }
    expect(
      offenders,
      `Extracted a "/'-delimited literal spanning multiple lines — a sign of comment/string extraction corruption:\n${offenders.join("\n")}`,
    ).toEqual([]);
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
