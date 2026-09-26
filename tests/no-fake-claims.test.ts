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
import * as ts from "typescript";

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
 * Extracts string/template literals AND JSX text content from raw TSX
 * source, via a real TypeScript-compiler-API parse — not a hand-rolled
 * regex tokenizer. `typescript` is already a root devDependency.
 *
 * This replaces three prior rounds of patching a regex-based tokenizer
 * (each of which fixed one corruption direction while leaving another):
 *   - stripping comments first got fooled by a real `"//"` string literal
 *     (`LoginPage.tsx`/`RegisterPage.tsx`);
 *   - extracting literals from raw text first got fooled by an apostrophe
 *     inside comment prose (`InstantBuyPage.tsx` and 20 other files);
 *   - even the final single-pass, mutually-exclusive-token regex still had
 *     a fourth latent bug: an apostrophe inside JSX text (`<p>Don't
 *     worry</p>`) or a quote inside a regex literal (`v.replace(/'/g, "")`)
 *     both still fooled a flat character scan into opening a fake `'`-string
 *     that swallows real code until the next stray `'`.
 *
 * Real parsing sidesteps the whole bug class instead of patching around it
 * again: the compiler's scanner/parser knows the actual language grammar, so
 * a regex literal is tokenized as a regex (full stop, never confusable with
 * a string), and JSX text is its own node kind distinct from code.
 *
 * `ts.createSourceFile` needs a filename argument, but it's never resolved
 * against the real filesystem here — it's only used for the parser's own
 * bookkeeping (e.g. what it would put in a diagnostic message), so a fixed
 * placeholder is fine for ad-hoc fixtures in the tests below; the corpus
 * scan (`loadStorefrontTsxFiles`) passes the real relative path.
 *
 * `ScriptKind.TSX` is required (not the default `.ts`) so JSX syntax parses
 * instead of erroring or being misread as generic-type syntax.
 *
 * String/no-substitution-template literals use the literal's RAW source
 * text (quotes stripped), not the AST's "cooked" `.text` — deliberately:
 * `.text` decodes escape sequences, so a perfectly ordinary `"line1\nline2"`
 * would decode to a value containing an actual newline character, which
 * would spuriously trip the corpus-wide newline-invariant check below (that
 * check exists to catch corruption, not to flag normal `\n` escapes as if
 * they were raw newlines). Using the raw slice keeps this extraction
 * semantically identical to what the old regex tokenizer captured, just
 * with correct boundaries. Template-literal pieces (spans of a substitution
 * template) DO use the cooked `.text` for the head/tail: stripping the
 * `` ` ``/`${`/`}` delimiters from raw text by hand is more error-prone than
 * reading the already-parsed piece, and template pieces are excluded from
 * the newline-invariant check anyway (they can legitimately span lines).
 */
function extractLiteralsWithDelimiter(
  fileName: string,
  text: string,
): Array<{ value: string; quote: '"' | "'" | "`" }> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TSX);
  const out: Array<{ value: string; quote: '"' | "'" | "`" }> = [];

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node)) {
      const raw = node.getText(source);
      const quote = raw[0] === "'" ? "'" : '"';
      out.push({ value: raw.slice(1, -1), quote });
    } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
      const raw = node.getText(source);
      out.push({ value: raw.slice(1, -1), quote: "`" });
    } else if (ts.isTemplateExpression(node)) {
      out.push({ value: node.head.text, quote: "`" });
      for (const span of node.templateSpans) out.push({ value: span.literal.text, quote: "`" });
    } else if (ts.isJsxText(node)) {
      // JSX text is never quote-delimited (and can legitimately span
      // multiple lines, e.g. a wrapped paragraph), so it's marked "`" to
      // exclude it from the quote-delimited-literal newline check below,
      // same as a template literal.
      //
      // Collapse internal whitespace (including newlines/indentation from
      // source-formatting a wrapped paragraph) to single spaces, matching
      // how React actually renders JSX text — otherwise a real multi-line
      // marketing paragraph like `<p>\n  Instant\n  delivery\n</p>` would
      // extract as "Instant\n  delivery", which none of the FORBIDDEN
      // patterns match (they all require a literal single space), silently
      // defeating the whole point of scanning JSX text at all.
      const t = node.getText(source).replace(/\s+/g, " ").trim();
      if (t) out.push({ value: t, quote: "`" });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return out;
}

/** Flat literal values only (for the FORBIDDEN-pattern scans, which don't
 *  care about delimiter kind). */
function extractLiterals(text: string): string[] {
  return extractLiteralsWithDelimiter("fixture.tsx", text).map((d) => d.value);
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
      const detailed = extractLiteralsWithDelimiter(relFile, raw);
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

describe("extractLiterals: AST parsing handles every regex-tokenizer regression trivially", () => {
  // These four fixtures each reproduce a real corruption shape a prior
  // regex-based tokenizer got wrong (three fixed across earlier rounds, one
  // found by the final whole-branch review and fixed by replacing the
  // tokenizer with a real TypeScript-compiler-API parse). None of them can
  // fool an AST parse: the compiler's scanner/parser knows the actual
  // language grammar (strings, comments, JSX text, and regex literals are
  // all distinct node/token kinds), so there's no flat-character-scan state
  // to trick.
  it('keeps a real "//"-shaped literal intact (a string containing comment-like text)', () => {
    // Mirrors the confirmed bug shape from LoginPage.tsx/RegisterPage.tsx: a
    // real `"//"` string literal, which a naive "strip comments first" scan
    // misreads as a line-comment start.
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

  it("excludes quoted phrases inside comments, including an apostrophe in comment prose (a comment containing string-like text)", () => {
    // Mirrors the confirmed bug shape from ProductCard.tsx/InstantBuyPage.tsx:
    // comments containing quoted phrases and possessive apostrophes, which a
    // naive "extract literals from raw text first" scan misreads as opening
    // a string literal, merging unrelated code into one corrupted "literal".
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

  it("extracts JSX text content, including an apostrophe, without corrupting subsequent code", () => {
    // The fourth tokenizer edge case the final review found: a regex
    // tokenizer has no notion of JSX at all, so an apostrophe inside
    // ordinary JSX text (e.g. "Don't") looks exactly like a string-literal
    // open to a flat character scan, swallowing everything after it up to
    // the next stray quote. A JsxText node is unambiguous to a real parse —
    // this fixture failed against the old TOKEN_RE-based extractLiterals
    // (confirmed RED before this rewrite) and passes now.
    const fixture = [
      "function Comp() {",
      "  return <p>Don't worry, we handle it automatically</p>;",
      "}",
      'const other = "unrelated code that must not be swallowed";',
    ].join("\n");

    const literals = extractLiterals(fixture);

    expect(literals).toContain("Don't worry, we handle it automatically");
    expect(literals).toContain("unrelated code that must not be swallowed");
  });

  it("collapses whitespace in wrapped, multi-line JSX text so a FORBIDDEN pattern still matches", () => {
    // A final-review pass found this gap: source-formatting wraps a long
    // JSX paragraph across lines with indentation, e.g.
    //   <p>
    //     Instant
    //     delivery for every order
    //   </p>
    // React collapses that to "Instant delivery for every order" on screen,
    // but a raw `.getText().trim()` (pre-fix) keeps the internal newlines/
    // indentation verbatim — "Instant\n    delivery for every order" — which
    // no FORBIDDEN pattern matches, since they all require a literal single
    // space. That would have silently defeated the entire point of scanning
    // JSX text (FINDINGS item 7). Confirmed RED before collapsing internal
    // whitespace to single spaces; GREEN after.
    const fixture = [
      "function Comp() {",
      "  return (",
      "    <p>",
      "      Instant",
      "      delivery for every order",
      "    </p>",
      "  );",
      "}",
    ].join("\n");

    const literals = extractLiterals(fixture);

    expect(literals).toContain("Instant delivery for every order");
    expect(literals.some((l) => l.includes("\n"))).toBe(false);
  });

  it("ignores a quote character inside a regex literal, without corrupting subsequent code", () => {
    // Same edge-case class as above, other direction: a regex tokenizer
    // doesn't know about RegExp literals either, so the `'` inside `/'/g`
    // looks like a string-literal open to a flat scan — and this fixture
    // gives it a LATER stray `'` to falsely "close" on (the real
    // `'trailing literal'` string two lines down), which is exactly what
    // turns this into genuine corruption rather than a harmless unmatched
    // scan: everything between the two apostrophes would merge into one
    // fake multi-line "literal", and the real string's own opening quote
    // would get consumed as somebody else's closing delimiter. A real parse
    // tokenizes `/'/g` as a single RegularExpressionLiteral in this
    // (post-`(`) position, never confusing it with a string — confirmed RED
    // against the old TOKEN_RE-based extractLiterals before this rewrite.
    const fixture = [
      "function clean(v: string) {",
      "  const cleaned = v.replace(/'/g, \"\");",
      "  const other = 'trailing literal';",
      '  return "safe after regex literal";',
      "}",
    ].join("\n");

    const literals = extractLiterals(fixture);

    expect(literals).toContain("trailing literal");
    expect(literals).toContain("safe after regex literal");
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

  it("extracts no quote-delimited literal containing a newline, across every scanned file (secondary safety net for the AST-based extraction)", () => {
    // Under the old regex tokenizer this was THE check that would have
    // caught both historical regressions: a `"`/`'`-delimited literal can
    // never legitimately contain a raw newline in valid JS/TSX, so a
    // newline inside one was exactly the signature of that tokenizer's
    // corruption bugs. Under the AST-based extraction above, a
    // StringLiteral/NoSubstitutionTemplateLiteral node genuinely cannot span
    // a raw newline per the language grammar (TSX would fail to parse a bare
    // newline inside `"..."` at all), so this check can no longer catch a
    // real bug the way it used to — it's kept as a cheap, free sanity net
    // across all 118 scanned files, not because it's expected to ever fire.
    //
    // Deliberately scoped to `quotedLiterals` (excludes backtick template
    // literals and JSX text): unlike `"`/`'` strings, a backtick template
    // literal and JSX text can BOTH legitimately span multiple lines (e.g.
    // multi-line conditional Tailwind `className` strings in `Footer.tsx`,
    // `TicketRow.tsx`, `Stepper.tsx`, `CategoryPage.tsx`, and a wrapped JSX
    // paragraph), so including them here would just be false positives on a
    // legitimate style choice, not a correctness signal.
    //
    // Nested `${...}` interpolation inside a template literal — a real
    // example in this repo, apps/storefront/client/src/pages/ProductPage.tsx's
    // WhatsApp share link, which nests a template literal inside
    // `encodeURIComponent(...)` — is no longer a gap: the AST visitor
    // recurses into every TemplateSpan's expression subtree the same as any
    // other node, so a nested literal is extracted correctly and separately,
    // not split into garbage fragments the way the old regex tokenizer did.
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
