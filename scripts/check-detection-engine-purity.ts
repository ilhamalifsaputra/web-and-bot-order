/**
 * Enforces AC-01 (Product/Variant Detection Engine spec): the engine's pure
 * logic files under packages/core/src/detection/ may not contain
 * product/brand names — those belong only in knowledge/** (the vocabulary
 * that seeds the Knowledge Base) and __fixtures__/** (synthetic test data).
 * It also enforces INV-1 (determinism) and INV-5 (engine purity) by banning
 * a handful of non-deterministic/impure constructs from the same file set.
 *
 * Two families of checks, both scanning every non-excluded `.ts` file under
 * packages/core/src/detection/ (excluding knowledge/**, __fixtures__/**, and
 * any *.test.ts):
 *
 *  1. Code-hazard patterns — `localeCompare`, `Date.now(`, zero-arg
 *     `new Date()`, `Math.random(`, and imports from `@prisma/client` or
 *     `@app/db`. These are banned per engine.ts's own INV-1/INV-5 doc
 *     comments (search this repo for those exact invariant names).
 *  2. A product-name denylist. Per the plan, this list must be DERIVED from
 *     fixture data, never hardcoded in this script — otherwise adding a new
 *     synthetic fixture wouldn't automatically extend what gets checked.
 *     The derivation: read every `__fixtures__/*.ts` file's `productName`/
 *     `canonical`/`alias`/`token` string literals, split each one on
 *     whitespace, and drop any word that's already a generic vocabulary
 *     word in knowledge/defaultVocabulary.ts's `token`/`canonical` fields
 *     (platform/edition/distribution/region/noise — "mobile", "pc", "max",
 *     "garena", "global", ...). Whatever's left is a product-specific proper
 *     noun. E.g. "Free Fire MAX" minus the generic "MAX" leaves "Free Fire";
 *     "Game A Mobile" minus generic "Mobile" leaves "Game A". This exactly
 *     reproduces the spec's own example denylist ("Game A", "Delta Force",
 *     "Free Fire", "PUBG") with zero names ever written into this file.
 *
 * Both checks scan comment-stripped content, not raw source. Without that,
 * this script would flag the engine's OWN invariant-documentation comments
 * (e.g. engine.ts: "INV-1 (determinism): no Date.now()/Math.random() ... no
 * localeCompare" and "INV-5 (engine purity): no @prisma/client, @app/db")
 * and tokenize.ts's doc comment illustrating despace() with the spec's own
 * "pubg mobile" example — both legitimate prose, not the impure/branded code
 * this checker exists to catch.
 *
 * Run standalone: `pnpm run check-detection-engine-purity`.
 * Also runs as part of `pretest`, after the other checks.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface Violation {
  line: number;
  rule: string;
  detail: string;
}

const CODE_HAZARD_PATTERNS: ReadonlyArray<{ rule: string; regex: RegExp }> = [
  { rule: "localeCompare", regex: /localeCompare/ },
  { rule: "Date.now()", regex: /Date\.now\s*\(/ },
  { rule: "new Date() with no arguments", regex: /new\s+Date\s*\(\s*\)/ },
  { rule: "Math.random()", regex: /Math\.random\s*\(/ },
];

// Same two-alternation shape as check-frontend-boundaries.ts's IMPORT_REGEX:
// `from "Y"` covers every `import`/`export ... from` form, `import "Y"` covers
// the bare side-effect import that has no `from` at all.
const IMPORT_REGEX = /from\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/;
const BANNED_IMPORT_PACKAGES = ["@prisma/client", "@app/db"];

// Fields whose string-literal values are examined when deriving vocabulary.
const VOCAB_FIELD_REGEX_SOURCE = String.raw`\b(?:token|canonical)\s*:\s*"([^"]*)"`;
const FIXTURE_FIELD_REGEX_SOURCE = String.raw`\b(?:productName|canonical|alias|token)\s*:\s*"([^"]*)"`;

/**
 * Blanks out `/* ... *\/` block comments (preserving newlines, so line
 * numbers stay aligned with the original file) and `//` line comments. Not
 * string-literal-aware (a `//` inside a string literal would get truncated
 * too) — a deliberate, documented simplification matching the rest of this
 * repo's text-based checker scripts (see check-frontend-boundaries.ts),
 * acceptable for a lint-style guard rather than a real parser.
 */
function stripComments(content: string): string {
  const withoutBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    const newlines = match.match(/\n/g);
    return newlines ? newlines.join("") : "";
  });
  return withoutBlockComments
    .split("\n")
    .map((line) => line.replace(/\/\/.*/, ""))
    .join("\n");
}

/**
 * Pure, unit-testable core: scans already-loaded file content for both
 * violation families and returns what it found. Takes no dependency on the
 * filesystem — `bannedTokens` is supplied by the caller (main(), or a test).
 */
export function checkFile(content: string, bannedTokens: string[]): Violation[] {
  const violations: Violation[] = [];
  const strippedLines = stripComments(content).split("\n");

  strippedLines.forEach((line, idx) => {
    const lineNumber = idx + 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    for (const { rule, regex } of CODE_HAZARD_PATTERNS) {
      if (regex.test(line)) {
        violations.push({ line: lineNumber, rule, detail: trimmed });
      }
    }

    const importMatch = IMPORT_REGEX.exec(line);
    if (importMatch) {
      const importPath = importMatch[1] ?? importMatch[2] ?? "";
      for (const pkg of BANNED_IMPORT_PACKAGES) {
        if (importPath === pkg || importPath.startsWith(`${pkg}/`)) {
          violations.push({
            line: lineNumber,
            rule: `forbidden import ("${pkg}")`,
            detail: trimmed,
          });
          break;
        }
      }
    }

    const lowerLine = line.toLowerCase();
    for (const token of bannedTokens) {
      if (token.trim().length === 0) continue;
      if (lowerLine.includes(token.toLowerCase())) {
        violations.push({
          line: lineNumber,
          rule: `product-specific name ("${token}")`,
          detail: trimmed,
        });
      }
    }
  });

  return violations;
}

function walkTsFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(fullPath));
    } else if (entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/** Derives the generic vocabulary set from defaultVocabulary.ts's own text. */
function deriveGenericVocabulary(vocabularySource: string): Set<string> {
  const generic = new Set<string>();
  const regex = new RegExp(VOCAB_FIELD_REGEX_SOURCE, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(vocabularySource)) !== null) {
    const value = match[1];
    if (value) generic.add(value.toLowerCase());
  }
  return generic;
}

/**
 * Derives the product-name denylist from fixture source text: pulls every
 * productName/canonical/alias/token string literal, strips generic
 * vocabulary words, and keeps whatever proper-noun remainder is left.
 * Returned sorted (plain `<`, matching this codebase's own no-localeCompare
 * convention) purely so output is stable across runs, not because ordering
 * is semantically meaningful here.
 */
function deriveDenylist(fixtureSources: string[], genericVocabulary: Set<string>): string[] {
  const denylist = new Map<string, string>();
  for (const source of fixtureSources) {
    const regex = new RegExp(FIXTURE_FIELD_REGEX_SOURCE, "g");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      const words = raw.split(/\s+/).filter((word) => word.length > 0);
      const remainingWords = words.filter((word) => !genericVocabulary.has(word.toLowerCase()));
      const candidate = remainingWords.join(" ").trim();
      if (candidate.length === 0) continue;
      const key = candidate.toLowerCase();
      if (!denylist.has(key)) denylist.set(key, candidate);
    }
  }
  return Array.from(denylist.values()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function main() {
  const detectionDir = join(process.cwd(), "packages/core/src/detection");
  const knowledgeDir = join(detectionDir, "knowledge");
  const fixturesDir = join(detectionDir, "__fixtures__");

  const vocabularySource = readFileSync(
    join(knowledgeDir, "defaultVocabulary.ts"),
    "utf-8",
  );
  const genericVocabulary = deriveGenericVocabulary(vocabularySource);

  const fixtureFiles = walkTsFiles(fixturesDir).filter((file) => !file.endsWith(".test.ts"));
  const fixtureSources = fixtureFiles.map((file) => readFileSync(file, "utf-8"));
  const bannedTokens = deriveDenylist(fixtureSources, genericVocabulary);

  if (bannedTokens.length === 0) {
    console.error(
      "check-detection-engine-purity: derived an empty product-name denylist " +
        "from __fixtures__/*.ts — that almost certainly means the derivation " +
        "regex stopped matching the fixture files' shape. Refusing to run a " +
        "check that would silently pass everything.",
    );
    process.exit(1);
  }

  const allTsFiles = walkTsFiles(detectionDir);
  const targetFiles = allTsFiles.filter((file) => {
    const relPath = toPosixRelative(detectionDir, file);
    if (relPath.startsWith("knowledge/")) return false;
    if (relPath.startsWith("__fixtures__/")) return false;
    if (relPath.endsWith(".test.ts")) return false;
    return true;
  });

  const allViolations: Array<Violation & { file: string }> = [];
  for (const file of targetFiles) {
    const content = readFileSync(file, "utf-8");
    const violations = checkFile(content, bannedTokens);
    for (const violation of violations) {
      allViolations.push({ ...violation, file: toPosixRelative(process.cwd(), file) });
    }
  }

  if (allViolations.length > 0) {
    console.error(
      "Detection engine purity check failed (AC-01/INV-1/INV-5). " +
        "The following violations were found in pure engine files:\n",
    );
    for (const violation of allViolations) {
      console.error(`  ${violation.file}:${violation.line}: ${violation.rule} — ${violation.detail}`);
    }
    console.error(
      "\nProduct/brand names belong only in knowledge/** and __fixtures__/**. " +
        "Non-deterministic constructs (localeCompare, Date.now(), new Date(), " +
        "Math.random()) and DB imports (@prisma/client, @app/db) are never " +
        "allowed in the engine's pure logic files.",
    );
    process.exit(1);
  }

  console.log(
    `Detection engine purity check passed: ${targetFiles.length} file(s) scanned, ` +
      `${bannedTokens.length} product-name token(s) derived from fixtures, no violations.`,
  );
  process.exit(0);
}

// Guarded so `main()` only runs when this file is executed directly (`tsx
// scripts/check-detection-engine-purity.ts`), not when
// check-detection-engine-purity.test.ts imports `checkFile` from it — an
// unguarded call here would run the full filesystem scan (and process.exit)
// as a side effect of the test file's import.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
