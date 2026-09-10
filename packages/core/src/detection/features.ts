/**
 * Feature extraction for the Detection Engine.
 *
 * Consumes an already-`normalize()`-d product name plus the Knowledge layer
 * (`KnowledgeBase`) and produces a classified breakdown: which tokens are
 * "core" (the product's base name), which are defining/distribution
 * attribute tokens, and what (if anything) the trailing parenthetical
 * annotation contributes.
 *
 * INV-1 (determinism): no Date.now()/Math.random(), no Set/Map iteration
 * order dependence, no localeCompare. Array order below is always the
 * knowledge base's declared array order or the input's token order — never
 * derived from Set/Map iteration.
 * INV-3 (total function): this module operates on already-normalized/
 * tokenized input (string, string[]) — not `unknown`. The `unknown`-accepting
 * boundary is `normalize()` (Task 2).
 * INV-5 (engine purity): no @prisma/client, @app/db, or I/O.
 */

import type { KnowledgeBase, KnowledgeToken, TokenCategory } from "./types";
import { tokenize, despace } from "./tokenize";

export interface ExtractedFeatures {
  /** Non-category tokens, in original (post-alias-expansion) order. */
  coreTokens: string[];
  definingTokens: { category: TokenCategory; canonical: string }[];
  distributionTokens: { category: TokenCategory; canonical: string }[];
  /** Raw suffix e.g. "Indonesia" — null if absent or denylisted noise. */
  parentheticalSuffix: string | null;
}

// Matches a trailing "(...)" group, mirroring parseProductRegion's regex
// intent (packages/core/src/suppliers/digiflazz.ts:170-190), reimplemented
// here as pure knowledge-driven logic rather than importing that file.
const TRAILING_PARENTHETICAL = /\s*\(([^)]+)\)\s*$/;

// Duration-range shape (e.g. "1-3 menit", "2-5 jam", "1-2 hari"). This is
// the one structural pattern allowed to live in code rather than in the
// Knowledge layer's data, since it's a shape (N-N unit) rather than a fixed
// vocabulary word — enumerating it as data tokens isn't practical.
const DURATION_RANGE_PATTERN = /^\d+-\d+\s*(menit|jam|hari)$/;

/**
 * Looks up an enabled knowledge token by its exact (already-normalized)
 * token string, regardless of category. Array order (not Set/Map order) is
 * what makes this deterministic; if two enabled tokens ever share the same
 * `token` string across categories, the first one in `knowledge.tokens`
 * array order wins.
 */
function findKnowledgeToken(
  knowledge: KnowledgeBase,
  token: string,
): KnowledgeToken | undefined {
  return knowledge.tokens.find((entry) => entry.enabled && entry.token === token);
}

/**
 * Classifies a single already-tokenized word against the knowledge base and
 * routes it into `coreTokens` / `definingTokens` / `distributionTokens`,
 * mutating the three arrays passed in. A `noise` match is dropped from all
 * three (accounted for by classification, not silently lost — INV-2 is
 * satisfied at the ExtractedFeatures level: every token ends up in exactly
 * one of core/defining/distribution/noise).
 */
function classifyToken(
  token: string,
  knowledge: KnowledgeBase,
  coreTokens: string[],
  definingTokens: { category: TokenCategory; canonical: string }[],
  distributionTokens: { category: TokenCategory; canonical: string }[],
): void {
  const match = findKnowledgeToken(knowledge, token);
  if (!match) {
    coreTokens.push(token);
    return;
  }
  if (match.category === "noise") {
    return;
  }
  if (match.isProductDefining) {
    definingTokens.push({ category: match.category, canonical: match.canonical });
  } else {
    distributionTokens.push({ category: match.category, canonical: match.canonical });
  }
}

/**
 * Expands a full alias match before tokenizing, per the brief: "if the FULL
 * normalized name (or the despaced form) matches an alias, expand it before
 * tokenizing". `KnowledgeAlias` has no `enabled` field (unlike
 * `KnowledgeToken`), so every alias present in `knowledge.aliases` is live.
 *
 * Judgment call (flagged for reviewer sign-off): matched against `name`
 * with the trailing parenthetical already stripped, not the raw
 * `normalizedName` input. The brief separately establishes that the
 * parenthetical is detected against the pre-alias-expansion string and is
 * "tokenized away" before general tokenization; matching aliases against a
 * name that still has "(...)" attached would make every alias fail to
 * match on any input that carries a parenthetical annotation (an alias
 * "abc" would never match the full string "abc (indonesia)"), which would
 * defeat the point of the mechanism. Matching against the paren-stripped
 * name is the interpretation that keeps alias expansion useful across such
 * inputs.
 */
function expandAlias(name: string, knowledge: KnowledgeBase): string {
  const despacedName = despace(name);
  for (const alias of knowledge.aliases) {
    if (alias.alias === name || alias.alias === despacedName) {
      return alias.expandsTo;
    }
  }
  return name;
}

export function extractFeatures(
  normalizedName: string,
  knowledge: KnowledgeBase,
): ExtractedFeatures {
  // Step 5 (documented ahead of 1-4 because it reads from the ORIGINAL,
  // pre-alias-expansion string): detect + strip the trailing parenthetical
  // before anything else runs, so downstream tokenization never sees a
  // literal "(" / ")" attached to a word.
  const parenMatch = normalizedName.match(TRAILING_PARENTHETICAL);
  const capturedRaw = parenMatch ? parenMatch[1]!.trim() : null;
  const nameSansParenthetical = parenMatch
    ? normalizedName.slice(0, parenMatch.index!).trim()
    : normalizedName;

  const coreTokens: string[] = [];
  const definingTokens: { category: TokenCategory; canonical: string }[] = [];
  const distributionTokens: { category: TokenCategory; canonical: string }[] = [];

  let parentheticalSuffix: string | null = null;
  if (capturedRaw !== null) {
    const isDenylistedNoise = knowledge.tokens.some(
      (entry) => entry.enabled && entry.category === "noise" && entry.token === capturedRaw,
    );
    const isDurationRange = DURATION_RANGE_PATTERN.test(capturedRaw);

    if (!isDenylistedNoise && !isDurationRange) {
      parentheticalSuffix = capturedRaw;
      // Also classify the parenthetical's own tokens (e.g. a region or
      // edition word living inside the parens) into defining/distribution —
      // but never into coreTokens: the parenthetical is an annotation on
      // the core name, not part of it. Any word here that matches nothing
      // is still accounted for (not silently dropped) because the raw text
      // survives verbatim in `parentheticalSuffix`.
      for (const token of tokenize(capturedRaw)) {
        const match = findKnowledgeToken(knowledge, token);
        if (!match || match.category === "noise") continue;
        if (match.isProductDefining) {
          definingTokens.push({ category: match.category, canonical: match.canonical });
        } else {
          distributionTokens.push({ category: match.category, canonical: match.canonical });
        }
      }
    }
    // Denylisted (noise or duration-range): the parenthetical is dropped
    // entirely, parentheticalSuffix stays null, and none of its words enter
    // coreTokens/definingTokens/distributionTokens either.
  }

  // Steps 1-4: alias-expand the paren-stripped name, tokenize it, then
  // classify each token.
  const expandedName = expandAlias(nameSansParenthetical, knowledge);
  for (const token of tokenize(expandedName)) {
    classifyToken(token, knowledge, coreTokens, definingTokens, distributionTokens);
  }

  return { coreTokens, definingTokens, distributionTokens, parentheticalSuffix };
}
