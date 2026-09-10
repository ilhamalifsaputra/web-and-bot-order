/**
 * Detection Engine entry point.
 *
 * `detect()` is the single public entry point: it takes an `unknown` input
 * (defensively coerced — never destructured without guards) and a
 * `DetectionDeps` bag (knowledge + a pre-built `CatalogIndex`, both handed
 * in by the caller — this module performs zero I/O of its own) and returns
 * a `DetectionResult`.
 *
 * Pipeline: coerce input -> normalize productName -> check knowledge
 * overrides (level 1, short-circuit) -> extractFeatures -> look up
 * candidates via the index (O(k), at most 5 `Map.get` calls) -> score every
 * candidate against the signal ladder -> decide resolved/ambiguous/unknown.
 *
 * Signal ladder (strongest to weakest):
 *   1. override            (W_OVERRIDE, short-circuit before this file's
 *                            scoring loop even runs)
 *   2. external id          (W_EXTERNAL_ID, gated by
 *                            knowledge.externalIdStableBySupplier[supplier])
 *   3. name-core match      (W_NAME_CORE, or the weaker despaced fallback
 *                            W_NAME_CORE_DESPACED) plus per-token
 *                            defining-token accumulation (W_DEFINING_TOKEN,
 *                            capped at DEFINING_TOKEN_CAP)
 *   4. structured metadata  (W_STRUCTURED_META, coarse — category/type)
 *   5. distribution         (W_DISTRIBUTION per signal, capped at
 *                            DISTRIBUTION_CAP — country/variant/publisher
 *                            raw input fields fold in here ONLY, never
 *                            elevated to level 3/4)
 *
 * INV-1 (determinism): no Date.now()/Math.random(), no Set/Map iteration
 * order dependence, no localeCompare. Every place this file turns a Map (or
 * a dedupe-by-id pass) into an output array, it explicitly re-sorts with a
 * plain `<`/`>` comparator first — Map/Set iteration order is never allowed
 * to leak into an observable result.
 * INV-3 (total function): detect() must never throw for ANY input shape.
 * INV-5 (engine purity): no @prisma/client, @app/db, or I/O.
 */

import type {
  Candidate,
  Conflict,
  DetectionAttributes,
  DetectionResult,
  Evidence,
  KnowledgeBase,
  KnowledgeOverride,
  CatalogEntry,
  TokenCategory,
} from "./types";
import { buildDetectorStamp } from "./version";
import { normalize } from "./normalize";
import { tokenize, despace } from "./tokenize";
import { extractFeatures, type ExtractedFeatures } from "./features";
import { buildBaseProductKey, buildProductKey } from "./keys";
import {
  W_EXTERNAL_ID,
  W_NAME_CORE,
  W_NAME_CORE_DESPACED,
  W_DEFINING_TOKEN,
  DEFINING_TOKEN_CAP,
  W_STRUCTURED_META,
  W_DISTRIBUTION,
  DISTRIBUTION_CAP,
  ACCEPT_THRESHOLD,
  MARGIN,
  W_OVERRIDE,
  computeConfidence,
} from "./scoring";
import type { CatalogIndex } from "./indexBuild";

export interface DetectionDeps {
  readonly knowledge: KnowledgeBase;
  readonly index: CatalogIndex;
  /** Which supplier this input is from — selects externalIdStableBySupplier flag. Optional; absent = level-2 signal never applies. */
  readonly supplier?: string;
}

// Upper bound on how many scored candidates an "ambiguous" result lists —
// candidate sets coming out of lookupCandidates are already small (bounded
// by at most 5 exact-key bucket lookups against real catalog data), this is
// just a defensive cap so a pathological knowledge base can't blow up the
// result payload.
const MAX_AMBIGUOUS_CANDIDATES = 10;

const EMPTY_ATTRIBUTES: DetectionAttributes = {
  platform: null,
  edition: null,
  distribution: null,
  region: null,
  publisher: null,
};

// === Defensive input coercion (INV-3) ===

/**
 * A DetectionInput-shaped object whose fields are always exactly
 * `string | null` (never `undefined`) — deliberately stricter than
 * `DetectionInput` itself (whose fields are optional, so reading them back
 * through that type would widen to `string | null | undefined` everywhere
 * downstream, defeating the point of coercing defensively up front).
 */
interface CoercedInput {
  readonly productName: string | null;
  readonly externalId: string | null;
  readonly category: string | null;
  readonly type: string | null;
  readonly country: string | null;
  readonly variant: string | null;
  readonly publisher: string | null;
}

/** Returns `value` only if it is a non-empty string — every DetectionInput field access goes through this. */
function safeStringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Coerces arbitrary `unknown` into a DetectionInput-shaped object of safe (non-empty-string-or-null) fields. Never throws. */
function coerceInput(input: unknown): CoercedInput {
  if (typeof input !== "object" || input === null) {
    return {
      productName: null,
      externalId: null,
      category: null,
      type: null,
      country: null,
      variant: null,
      publisher: null,
    };
  }
  const record = input as Record<string, unknown>;
  return {
    productName: safeStringField(record.productName),
    externalId: safeStringField(record.externalId),
    category: safeStringField(record.category),
    type: safeStringField(record.type),
    country: safeStringField(record.country),
    variant: safeStringField(record.variant),
    publisher: safeStringField(record.publisher),
  };
}

// === Level 1: knowledge overrides ===

function findOverride(
  overrides: readonly KnowledgeOverride[],
  normalizedName: string,
  externalId: string | null,
): KnowledgeOverride | null {
  for (const override of overrides) {
    if (override.matchKind === "normalized_name" && override.matchValue === normalizedName) {
      return override;
    }
    if (override.matchKind === "external_id" && externalId !== null && override.matchValue === externalId) {
      return override;
    }
  }
  return null;
}

// === Candidate lookup (O(k), at most 5 Map.get calls) ===

interface LookupKeys {
  readonly productKey: string;
  readonly baseProductKey: string;
  readonly normalizedName: string;
  readonly despacedName: string;
  readonly externalId: string | null;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Unions the (at most 5) exact-key bucket lookups into a deduplicated,
 * deterministically-ordered candidate list. Deduplication uses a Map keyed
 * by `refId` purely as a membership check — the returned array order comes
 * from an explicit re-sort by `refId`, never from the Map's iteration
 * order (INV-1).
 */
function lookupCandidates(index: CatalogIndex, keys: LookupKeys): CatalogEntry[] {
  const seen = new Map<string, CatalogEntry>();
  const buckets: readonly (readonly CatalogEntry[] | undefined)[] = [
    keys.externalId !== null ? index.byExternalId.get(keys.externalId) : undefined,
    index.byProductKey.get(keys.productKey),
    index.byBaseKey.get(keys.baseProductKey),
    index.byNormalizedName.get(keys.normalizedName),
    index.byDespacedName.get(keys.despacedName),
  ];
  for (const bucket of buckets) {
    if (!bucket) continue;
    for (const entry of bucket) {
      if (!seen.has(entry.refId)) {
        seen.set(entry.refId, entry);
      }
    }
  }
  return [...seen.values()].sort((a, b) => compareStrings(a.refId, b.refId));
}

// === Scoring ===

type CategoryPair = { category: TokenCategory; canonical: string };

function pairKey(pair: CategoryPair): string {
  return `${pair.category}=${pair.canonical}`;
}

/** Overlap between two CategoryPair lists, order-preserved from `a`, deduplicated. Membership test only — never iterates Set/Map order into output. */
function overlappingPairKeys(a: readonly CategoryPair[], b: readonly CategoryPair[]): string[] {
  const bKeys = new Set(b.map(pairKey));
  const seenKeys = new Set<string>();
  const result: string[] = [];
  for (const pair of a) {
    const key = pairKey(pair);
    if (bKeys.has(key) && !seenKeys.has(key)) {
      seenKeys.add(key);
      result.push(key);
    }
  }
  return result;
}

/** Picks the canonical value for a category from defining tokens first, then distribution tokens (a category's isProductDefining classification is knowledge-data-driven, so it may land in either list). */
function pickAttribute(features: ExtractedFeatures, category: TokenCategory): string | null {
  for (const pair of features.definingTokens) {
    if (pair.category === category) return pair.canonical;
  }
  for (const pair of features.distributionTokens) {
    if (pair.category === category) return pair.canonical;
  }
  return null;
}

function buildAttributes(winnerFeatures: ExtractedFeatures, publisher: string | null): DetectionAttributes {
  return {
    platform: pickAttribute(winnerFeatures, "platform"),
    edition: pickAttribute(winnerFeatures, "edition"),
    distribution: pickAttribute(winnerFeatures, "distribution"),
    region: pickAttribute(winnerFeatures, "region"),
    publisher,
  };
}

interface ScoringContext {
  readonly knowledge: KnowledgeBase;
  readonly isExternalIdActive: boolean;
  readonly externalId: string | null;
  readonly inputBaseProductKey: string;
  readonly inputDespacedName: string;
  readonly inputFeatures: ExtractedFeatures;
  readonly inputCategory: string | null;
  readonly inputType: string | null;
  readonly inputCountry: string | null;
  readonly inputVariant: string | null;
  readonly inputPublisher: string | null;
  readonly maxAttainableScore: number;
}

/** A scored candidate, carrying the internal `refId` (used only for deterministic dedupe/tie-breaking — never exposed on the public DetectionResult shapes) alongside the recomputed features needed to build `attributes` if this candidate wins. */
interface InternalScored {
  readonly refId: string;
  readonly baseProductKey: string;
  readonly productKey: string;
  readonly features: ExtractedFeatures;
  readonly score: number;
  readonly maxAttainableScore: number;
  readonly evidence: Evidence[];
}

function scoreCandidate(entry: CatalogEntry, ctx: ScoringContext): InternalScored {
  const candidateNormalizedName = normalize(entry.productName);
  const candidateFeatures = extractFeatures(candidateNormalizedName, ctx.knowledge);
  const candidateBaseProductKey = buildBaseProductKey(candidateFeatures.coreTokens);
  const candidateProductKey = buildProductKey(candidateBaseProductKey, candidateFeatures.definingTokens);
  const candidateDespacedName = despace(candidateNormalizedName);
  const candidateNameTokens = tokenize(candidateNormalizedName);

  const evidence: Evidence[] = [];
  let score = 0;

  // Level 2: external id (only when the supplier's ids are declared stable).
  if (
    ctx.isExternalIdActive &&
    ctx.externalId !== null &&
    entry.externalId !== null &&
    entry.externalId === ctx.externalId
  ) {
    evidence.push({ signal: "external_id", value: ctx.externalId, weight: W_EXTERNAL_ID });
    score += W_EXTERNAL_ID;
  }

  // Level 3a: name-core match (strong), falling back to despaced (weak) —
  // mutually exclusive, the weak signal only fires when the strong one didn't.
  if (candidateBaseProductKey.length > 0 && candidateBaseProductKey === ctx.inputBaseProductKey) {
    evidence.push({ signal: "name_core", value: candidateBaseProductKey, weight: W_NAME_CORE });
    score += W_NAME_CORE;
  } else if (candidateDespacedName.length > 0 && candidateDespacedName === ctx.inputDespacedName) {
    evidence.push({ signal: "name_core_despaced", value: candidateDespacedName, weight: W_NAME_CORE_DESPACED });
    score += W_NAME_CORE_DESPACED;
  }

  // Level 3b: defining-token accumulation (independent of the name-core
  // match above — captures attribute overlap even on a weak/no name match).
  const definingOverlap = overlappingPairKeys(ctx.inputFeatures.definingTokens, candidateFeatures.definingTokens);
  if (definingOverlap.length > 0) {
    const cappedWeight = Math.min(definingOverlap.length * W_DEFINING_TOKEN, DEFINING_TOKEN_CAP);
    evidence.push({ signal: "defining_token", value: definingOverlap.join(","), weight: cappedWeight });
    score += cappedWeight;
  }

  // Level 4: structured metadata — coarse, one flat bonus if EITHER
  // category or type matches (not summed per-field).
  const categoryMatch =
    ctx.inputCategory !== null && entry.category !== null && normalize(ctx.inputCategory) === normalize(entry.category);
  const typeMatch =
    ctx.inputType !== null && entry.type !== null && normalize(ctx.inputType) === normalize(entry.type);
  if (categoryMatch || typeMatch) {
    const matchedFields = [
      ...(categoryMatch ? ["category"] : []),
      ...(typeMatch ? ["type"] : []),
    ];
    evidence.push({ signal: "structured_meta", value: matchedFields.join(","), weight: W_STRUCTURED_META });
    score += W_STRUCTURED_META;
  }

  // Level 5: distribution — token-classified overlap plus raw
  // country/variant/publisher fields checked against the candidate's own
  // name text. All folded into ONE evidence entry, capped at DISTRIBUTION_CAP.
  const distributionTokenOverlap = overlappingPairKeys(
    ctx.inputFeatures.distributionTokens,
    candidateFeatures.distributionTokens,
  );
  const rawFieldMatches: string[] = [];
  const rawFields: readonly (readonly [string, string | null])[] = [
    ["country", ctx.inputCountry],
    ["variant", ctx.inputVariant],
    ["publisher", ctx.inputPublisher],
  ];
  for (const [label, value] of rawFields) {
    if (value === null) continue;
    const valueTokens = tokenize(normalize(value));
    if (valueTokens.length > 0 && valueTokens.every((token) => candidateNameTokens.includes(token))) {
      rawFieldMatches.push(`${label}:${value}`);
    }
  }
  const distributionSignalCount = distributionTokenOverlap.length + rawFieldMatches.length;
  if (distributionSignalCount > 0) {
    const cappedWeight = Math.min(distributionSignalCount * W_DISTRIBUTION, DISTRIBUTION_CAP);
    const value = [...distributionTokenOverlap, ...rawFieldMatches].join(",");
    evidence.push({ signal: "distribution", value, weight: cappedWeight });
    score += cappedWeight;
  }

  return {
    refId: entry.refId,
    baseProductKey: candidateBaseProductKey,
    productKey: candidateProductKey,
    features: candidateFeatures,
    score,
    maxAttainableScore: ctx.maxAttainableScore,
    evidence,
  };
}

/** Dedupes scored candidates by productKey, keeping the higher-scoring representative per key (ties broken by refId, never by "first seen" / Map insertion order). */
function dedupeByProductKey(scored: readonly InternalScored[]): InternalScored[] {
  const byKey = new Map<string, InternalScored>();
  for (const candidate of scored) {
    const existing = byKey.get(candidate.productKey);
    if (
      !existing ||
      candidate.score > existing.score ||
      (candidate.score === existing.score && candidate.refId < existing.refId)
    ) {
      byKey.set(candidate.productKey, candidate);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return compareStrings(a.productKey, b.productKey);
  });
}

// Ladder level per signal name — 1 (strongest) to 5 (weakest). Used only to
// annotate conflicts[] with which level won; overrides never reach this
// code path (they short-circuit before scoring runs).
function ladderLevel(signal: string): number {
  switch (signal) {
    case "external_id":
      return 2;
    case "name_core":
    case "name_core_despaced":
    case "defining_token":
      return 3;
    case "structured_meta":
      return 4;
    case "distribution":
      return 5;
    default:
      return 6;
  }
}

/** The strongest (lowest ladder level) evidence entry on a candidate, or null if it has none. */
function strongestEvidence(evidence: readonly Evidence[]): Evidence | null {
  let best: Evidence | null = null;
  let bestLevel = Number.POSITIVE_INFINITY;
  for (const entry of evidence) {
    const level = ladderLevel(entry.signal);
    if (level < bestLevel) {
      bestLevel = level;
      best = entry;
    }
  }
  return best;
}

/** Records a conflict for every level-4/5 signal that favored a candidate other than the winner. */
function buildConflicts(scored: readonly InternalScored[], winner: InternalScored): Conflict[] {
  const winnerStrongest = strongestEvidence(winner.evidence);
  const winnerSignal = winnerStrongest?.signal ?? "none";
  const winningLevel = winnerStrongest ? ladderLevel(winnerStrongest.signal) : ladderLevel("none");

  const conflicts: Conflict[] = [];
  for (const candidate of scored) {
    if (candidate.productKey === winner.productKey) continue;
    for (const evidence of candidate.evidence) {
      const level = ladderLevel(evidence.signal);
      if (level === 4 || level === 5) {
        conflicts.push({
          losingSignal: evidence.signal,
          winningSignal: winnerSignal,
          winningLevel,
          reason: `Candidate "${candidate.productKey}" had ${evidence.signal} evidence (${evidence.value}) favoring it, but "${winner.productKey}" won on a stronger ${winnerSignal} signal (ladder level ${winningLevel}).`,
        });
      }
    }
  }
  return conflicts;
}

function toPublicCandidate(scored: InternalScored): Candidate {
  return {
    baseProductKey: scored.baseProductKey,
    productKey: scored.productKey,
    score: scored.score,
    evidence: scored.evidence,
  };
}

// === Public API ===

export function detect(input: unknown, deps: DetectionDeps): DetectionResult {
  const detectorVersion = buildDetectorStamp(deps.knowledge.revision);
  const coerced = coerceInput(input);
  const normalizedName = normalize(coerced.productName);

  if (normalizedName.length === 0) {
    return {
      status: "unknown",
      reason: "no usable product name",
      evidence: [],
      detectorVersion,
    };
  }

  // Level 1: overrides — exact match on normalized name or external id,
  // short-circuits the entire scoring pipeline.
  const overrideMatch = findOverride(deps.knowledge.overrides, normalizedName, coerced.externalId);
  if (overrideMatch) {
    return {
      status: "resolved",
      baseProductKey: overrideMatch.baseProductKey,
      productKey: overrideMatch.productKey,
      skuKey: null,
      attributes: EMPTY_ATTRIBUTES,
      confidence: 1,
      score: W_OVERRIDE,
      evidence: [{ signal: "override", value: overrideMatch.matchValue, weight: W_OVERRIDE }],
      conflicts: [],
      detectorVersion,
    };
  }

  const inputFeatures = extractFeatures(normalizedName, deps.knowledge);
  const inputBaseProductKey = buildBaseProductKey(inputFeatures.coreTokens);
  const inputProductKey = buildProductKey(inputBaseProductKey, inputFeatures.definingTokens);
  const inputDespacedName = despace(normalizedName);

  const candidateEntries = lookupCandidates(deps.index, {
    productKey: inputProductKey,
    baseProductKey: inputBaseProductKey,
    normalizedName,
    despacedName: inputDespacedName,
    externalId: coerced.externalId,
  });

  if (candidateEntries.length === 0) {
    return {
      status: "unknown",
      reason: "no catalog candidates matched this product name, external id, or attributes",
      evidence: [],
      detectorVersion,
    };
  }

  const isExternalIdActive =
    deps.supplier !== undefined &&
    deps.knowledge.externalIdStableBySupplier[deps.supplier] === true &&
    coerced.externalId !== null;

  const maxAttainableScore =
    (isExternalIdActive ? W_EXTERNAL_ID : 0) + W_NAME_CORE + DEFINING_TOKEN_CAP + W_STRUCTURED_META + DISTRIBUTION_CAP;

  const scoringContext: ScoringContext = {
    knowledge: deps.knowledge,
    isExternalIdActive,
    externalId: coerced.externalId,
    inputBaseProductKey,
    inputDespacedName,
    inputFeatures,
    inputCategory: coerced.category,
    inputType: coerced.type,
    inputCountry: coerced.country,
    inputVariant: coerced.variant,
    inputPublisher: coerced.publisher,
    maxAttainableScore,
  };

  const scoredRaw = candidateEntries.map((entry) => scoreCandidate(entry, scoringContext));
  const scored = dedupeByProductKey(scoredRaw);

  const winner = scored[0];
  if (!winner) {
    // Unreachable in practice (candidateEntries.length > 0 guarantees at
    // least one scored candidate after dedupe), kept as a defensive,
    // non-throwing fallback for INV-3.
    return {
      status: "unknown",
      reason: "no scoreable candidates after deduplication",
      evidence: [],
      detectorVersion,
    };
  }
  const runnerUp = scored[1];
  const margin = runnerUp ? winner.score - runnerUp.score : winner.score;

  if (winner.score < ACCEPT_THRESHOLD) {
    return {
      status: "unknown",
      reason: `best candidate "${winner.productKey}" scored ${winner.score}, below the accept threshold of ${ACCEPT_THRESHOLD}`,
      evidence: winner.evidence,
      detectorVersion,
    };
  }

  if (!runnerUp || margin > MARGIN) {
    const conflicts = buildConflicts(scored, winner);
    return {
      status: "resolved",
      baseProductKey: winner.baseProductKey,
      productKey: winner.productKey,
      skuKey: null,
      attributes: buildAttributes(winner.features, coerced.publisher),
      confidence: computeConfidence(winner.score, winner.maxAttainableScore),
      score: winner.score,
      evidence: winner.evidence,
      conflicts,
      detectorVersion,
    };
  }

  return {
    status: "ambiguous",
    candidates: scored.slice(0, MAX_AMBIGUOUS_CANDIDATES).map(toPublicCandidate),
    reason: `top candidates "${winner.productKey}" (${winner.score}) and "${runnerUp.productKey}" (${runnerUp.score}) are within margin ${MARGIN} of each other`,
    evidence: [],
    detectorVersion,
  };
}
