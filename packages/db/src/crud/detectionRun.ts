/**
 * Detection Engine — full-catalog run + run-status blob store (Task 9,
 * AC-16/AC-20).
 *
 * `runDetectionForCatalog` composes the real Task 8 DB layer with the pure
 * Task 5 engine: it loads the DB-backed KnowledgeBase
 * (`crud/detectionKnowledge.ts`) and the DB-backed CatalogIndex
 * (`crud/detectionIndex.ts`), then calls `detect()` (from
 * `@app/core/detection`) once per catalog record. Every record the engine
 * cannot confidently resolve ("ambiguous" / "unknown") is folded into a
 * `DetectionIssue` row keyed by a deterministic fingerprint of the
 * normalized input, so the same recurring unresolved input accumulates into
 * one review-queue row (`occurrences` / `lastSeenAt`) instead of a fresh
 * row every run.
 *
 * The run also computes a `DetectionRunSummary` and stores it as a JSON blob
 * under a single Settings key — same "one status blob, validate field by
 * field on read, corrupt blob degrades to null" pattern as
 * `crud/digiflazzSyncStatus.ts`.
 *
 * "Every catalog record" here is the same set `getCatalogIndex` builds its
 * index from: every `Product` with a non-null `digiflazzBrand` (see
 * `crud/detectionIndex.ts`'s own module comment — a later task refines what
 * counts as a catalog row). The query is intentionally duplicated rather
 * than exported from that module, so a future change to the catalog source
 * is a single, visible edit in both places.
 */
import { createHash } from "node:crypto";
import { detect, normalize, type DetectionInput, type DetectionResult } from "@app/core/detection";
import { logger } from "@app/core/logger";
import type { Db } from "./_types";
import { loadKnowledgeBase } from "./detectionKnowledge";
import { getCatalogIndex } from "./detectionIndex";
import { getSetting, setSetting } from "./settings";

/** Settings key holding the most recent full-catalog detection run's summary
 * blob (JSON). Only ever holds the latest run — no merge, no history. */
export const DETECTION_RUN_STATUS_KEY = "detection_run_status";

/** Fixed fingerprint for the single synthetic `DetectionIssue` raised when a
 * run's override rate crosses the 5%-of-catalog ceiling. Keyed by a
 * reserved sentinel string (not a real input hash) so repeated bad runs
 * bump `occurrences` on one row instead of spamming the review queue. */
export const OVERRIDE_RATE_SENTINEL_FINGERPRINT = "__override_rate_exceeded__";

/** Above this share of the catalog resolving via a manual override, a run
 * warns and raises the sentinel issue — a high override rate usually means
 * the engine's scoring needs a fix, not another override. */
const OVERRIDE_RATE_CEILING = 0.05;

export interface DetectionRunSummary {
  /** The detector stamp (engine version + knowledge revision) the run used. */
  detectorStamp: string;
  /** How many catalog records the run fed through `detect()`. */
  totalRecords: number;
  resolved: number;
  ambiguous: number;
  unknown: number;
  /** Count of resolved records per confidence band (keys are the fixed band
   * labels below; every band is always present, so the admin panel can
   * render a stable distribution). */
  confidenceBuckets: Record<string, number>;
  /** How many resolved records resolved via a manual `DetectionOverride`. */
  overrideHits: number;
  /** ISO 8601 timestamp the run finished. */
  finishedAt: string;
}

const CONFIDENCE_BANDS = ["0.90-1.00", "0.75-0.90", "0.50-0.75", "0.00-0.50"] as const;

function emptyConfidenceBuckets(): Record<string, number> {
  const buckets: Record<string, number> = {};
  for (const band of CONFIDENCE_BANDS) buckets[band] = 0;
  return buckets;
}

function confidenceBand(confidence: number): (typeof CONFIDENCE_BANDS)[number] {
  if (confidence >= 0.9) return "0.90-1.00";
  if (confidence >= 0.75) return "0.75-0.90";
  if (confidence >= 0.5) return "0.50-0.75";
  return "0.00-0.50";
}

/** A resolved result counts as an override hit when its evidence carries the
 * engine's `override` signal (level 1, short-circuit). */
function isOverrideHit(result: DetectionResult): boolean {
  return result.status === "resolved" && result.evidence.some((e) => e.signal === "override");
}

/**
 * Extracts the `DetectionOverride` compound key (`matchKind` + `matchValue`)
 * from a resolved result's `override` evidence entry. The engine
 * (`packages/core/src/detection/engine.ts`) encodes both into `value` as
 * `${matchKind}:${matchValue}` — split on the first ":" only, since
 * `matchKind` is a fixed colon-free enum but `matchValue` may itself contain
 * ":". Returns null when the result isn't an override hit or the evidence is
 * malformed (defensive — should not happen against the real engine).
 */
function overrideHitKey(result: DetectionResult): { matchKind: string; matchValue: string } | null {
  if (result.status !== "resolved") return null;
  const overrideEvidence = result.evidence.find((e) => e.signal === "override");
  if (!overrideEvidence) return null;
  const separatorIndex = overrideEvidence.value.indexOf(":");
  if (separatorIndex === -1) return null;
  const matchKind = overrideEvidence.value.slice(0, separatorIndex);
  const matchValue = overrideEvidence.value.slice(separatorIndex + 1);
  return { matchKind, matchValue };
}

/** Bump the matched `DetectionOverride` row's running usage counter. This is
 * an automated, system-driven increment (not an admin action), so it does
 * not go through `logAdminAction`. */
async function incrementOverrideHitCount(db: Db, key: { matchKind: string; matchValue: string }): Promise<void> {
  await db.detectionOverride.update({
    where: { matchKind_matchValue: { matchKind: key.matchKind, matchValue: key.matchValue } },
    data: { hitCount: { increment: 1 } },
  });
}

/**
 * Deterministic fingerprint of a detection input: sha256 over a
 * canonical-key-order JSON of the input with the product name normalized
 * the same way the engine normalizes it, truncated to 16 hex chars. Two
 * inputs that differ only in casing / separators / surrounding whitespace
 * of the product name therefore share one fingerprint (and one review-queue
 * row), matching `DetectionIssue.inputFingerprint`'s intent.
 */
export function fingerprintDetectionInput(input: DetectionInput): string {
  const canonical = JSON.stringify({
    productName: normalize(input.productName ?? ""),
    externalId: input.externalId ?? null,
    category: input.category ?? null,
    type: input.type ?? null,
    country: input.country ?? null,
    variant: input.variant ?? null,
    publisher: input.publisher ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Upsert one review-queue row for a non-resolved result: create it OPEN on
 * first sight, otherwise bump `occurrences` (and, via `@updatedAt`,
 * `lastSeenAt`) and refresh the mutable fields from this run. */
async function upsertDetectionIssue(
  db: Db,
  args: {
    fingerprint: string;
    status: string;
    rawInput: string;
    reason: string;
    candidates: string | null;
    detectorStamp: string;
  },
): Promise<void> {
  await db.detectionIssue.upsert({
    where: { inputFingerprint: args.fingerprint },
    create: {
      status: args.status,
      inputFingerprint: args.fingerprint,
      rawInput: args.rawInput,
      reason: args.reason,
      candidates: args.candidates,
      detectorStamp: args.detectorStamp,
    },
    update: {
      status: args.status,
      reason: args.reason,
      candidates: args.candidates,
      detectorStamp: args.detectorStamp,
      occurrences: { increment: 1 },
    },
  });
}

/**
 * Run the detector over the whole catalog, refresh the review queue, and
 * store (and return) the run summary.
 */
export async function runDetectionForCatalog(db: Db): Promise<DetectionRunSummary> {
  const [knowledge, index] = await Promise.all([loadKnowledgeBase(db), getCatalogIndex(db)]);
  const detectorStamp = index.stamp;

  // Same catalog source as `getCatalogIndex` (crud/detectionIndex.ts).
  const products = await db.product.findMany({
    where: { digiflazzBrand: { not: null } },
    select: { id: true, name: true },
  });

  const confidenceBuckets = emptyConfidenceBuckets();
  let resolved = 0;
  let ambiguous = 0;
  let unknown = 0;
  let overrideHits = 0;

  for (const product of products) {
    const input: DetectionInput = { productName: product.name };
    const result = detect(input, { knowledge, index });

    if (result.status === "resolved") {
      resolved += 1;
      const band = confidenceBand(result.confidence);
      confidenceBuckets[band] = (confidenceBuckets[band] ?? 0) + 1;
      if (isOverrideHit(result)) {
        overrideHits += 1;
        const key = overrideHitKey(result);
        // Every real override hit bumps the row's running usage counter,
        // independent of the >5% rate-ceiling warning below.
        if (key) await incrementOverrideHitCount(db, key);
      }
      continue;
    }

    if (result.status === "ambiguous") ambiguous += 1;
    else unknown += 1;

    await upsertDetectionIssue(db, {
      fingerprint: fingerprintDetectionInput(input),
      status: result.status,
      rawInput: JSON.stringify(input),
      reason: result.reason,
      candidates: result.status === "ambiguous" ? JSON.stringify(result.candidates) : null,
      detectorStamp,
    });
  }

  const totalRecords = products.length;
  const overrideRate = totalRecords === 0 ? 0 : overrideHits / totalRecords;

  if (totalRecords > 0 && overrideRate > OVERRIDE_RATE_CEILING) {
    logger.warn(
      { overrideRate, totalRecords, overrideHits },
      "Detection override rate exceeded 5% of the catalog — this usually means the engine's core logic needs a fix, not another override.",
    );
    const percent = (overrideRate * 100).toFixed(1);
    await upsertDetectionIssue(db, {
      fingerprint: OVERRIDE_RATE_SENTINEL_FINGERPRINT,
      status: "unknown",
      rawInput: JSON.stringify({ overrideHits, totalRecords, overrideRate }),
      reason: `Manual detection overrides resolved ${percent}% of the catalog (${overrideHits} of ${totalRecords}), above the 5% ceiling. A high override rate usually means the engine's scoring logic needs a fix rather than more manual overrides.`,
      candidates: null,
      detectorStamp,
    });
  }

  const summary: DetectionRunSummary = {
    detectorStamp,
    totalRecords,
    resolved,
    ambiguous,
    unknown,
    confidenceBuckets,
    overrideHits,
    finishedAt: new Date().toISOString(),
  };

  await setSetting(db, DETECTION_RUN_STATUS_KEY, JSON.stringify(summary));
  return summary;
}

/**
 * Read the most recent run summary back. Returns null when no run has ever
 * completed, the stored blob fails to parse, or any required field is
 * missing / the wrong type — a corrupt or partial blob degrades to "never
 * run" rather than throwing or inventing per-field defaults (same contract
 * as `getDigiflazzSyncStatus`).
 */
export async function getLatestDetectionRunStatus(db: Db): Promise<DetectionRunSummary | null> {
  const raw = await getSetting(db, DETECTION_RUN_STATUS_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<DetectionRunSummary>;
    if (typeof p.detectorStamp !== "string") return null;
    if (typeof p.totalRecords !== "number") return null;
    if (typeof p.resolved !== "number") return null;
    if (typeof p.ambiguous !== "number") return null;
    if (typeof p.unknown !== "number") return null;
    if (typeof p.overrideHits !== "number") return null;
    if (typeof p.finishedAt !== "string") return null;
    if (typeof p.confidenceBuckets !== "object" || p.confidenceBuckets === null) return null;
    const confidenceBuckets: Record<string, number> = {};
    for (const [band, count] of Object.entries(p.confidenceBuckets)) {
      if (typeof count !== "number") return null;
      confidenceBuckets[band] = count;
    }
    return {
      detectorStamp: p.detectorStamp,
      totalRecords: p.totalRecords,
      resolved: p.resolved,
      ambiguous: p.ambiguous,
      unknown: p.unknown,
      confidenceBuckets,
      overrideHits: p.overrideHits,
      finishedAt: p.finishedAt,
    };
  } catch {
    return null;
  }
}
