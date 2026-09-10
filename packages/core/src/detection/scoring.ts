/**
 * Scoring constants and confidence computation for the Detection Engine.
 * All weights are integers applied cumulatively across evidence bands.
 */

import type { Evidence } from "./types.js";

// === Weight Constants ===

export const W_OVERRIDE = 100; // short-circuit: beats the sum of every other band combined
export const W_EXTERNAL_ID = 60; // level 2 — only applied when knowledge.externalIdStableBySupplier[supplier] is true
export const W_NAME_CORE = 40; // level 3 — equals ACCEPT_THRESHOLD: a full core-name match is sufficient alone
export const W_NAME_CORE_DESPACED = 25; // level 3 (weak) — below ACCEPT_THRESHOLD by construction, see AC-05
export const W_DEFINING_TOKEN = 10; // level 3, per matched product-defining token
export const DEFINING_TOKEN_CAP = 30; // at most 3 defining tokens counted, so a long name can't win on length alone
export const W_STRUCTURED_META = 15; // level 4 — category/type metadata, coarse
export const W_DISTRIBUTION = 5; // level 5, per distribution signal (publisher/country/admin-set variant)
export const DISTRIBUTION_CAP = 10; // level 5 total cap — tie-breaker only
export const ACCEPT_THRESHOLD = 40; // == W_NAME_CORE: name match alone must be enough
export const MARGIN = 15; // > DISTRIBUTION_CAP: two candidates can never split on distribution evidence alone

// === Scored Result Type ===

export interface ScoredCandidate {
  baseProductKey: string;
  productKey: string;
  score: number;
  maxAttainableScore: number;
  evidence: Evidence[];
}

// === Confidence Computation ===

/**
 * Compute confidence as a percentage (0 to 1, rounded to 2 decimals).
 * Formula: Math.round((score / maxAttainableScore) * 100) / 100
 * Guard: maxAttainableScore === 0 returns 0 (not NaN/Infinity)
 */
export function computeConfidence(
  score: number,
  maxAttainableScore: number,
): number {
  if (maxAttainableScore === 0) {
    return 0;
  }
  return Math.round((score / maxAttainableScore) * 100) / 100;
}
