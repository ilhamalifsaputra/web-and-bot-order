/**
 * Foundational types for the Detection Engine.
 * This file contains ZERO product-specific names — it is pure structure.
 * Product knowledge lives in ./knowledge/defaultVocabulary.ts
 */

export interface Evidence {
  signal: string;
  value: string;
  weight: number;
}

export interface Conflict {
  losingSignal: string;
  winningSignal: string;
  winningLevel: number;
  reason: string;
}

export interface Candidate {
  baseProductKey: string;
  productKey: string;
  score: number;
  evidence: Evidence[];
}

export interface DetectionAttributes {
  platform: string | null;
  edition: string | null;
  distribution: string | null;
  region: string | null;
  publisher: string | null;
}

export type DetectionResult =
  | {
      status: "resolved";
      baseProductKey: string;
      productKey: string;
      skuKey: string | null;
      attributes: DetectionAttributes;
      confidence: number;
      score: number;
      evidence: Evidence[];
      conflicts: Conflict[];
      detectorVersion: string;
    }
  | {
      status: "ambiguous";
      candidates: Candidate[];
      reason: string;
      evidence: Evidence[];
      detectorVersion: string;
    }
  | {
      status: "unknown";
      reason: string;
      evidence: Evidence[];
      detectorVersion: string;
    };

/**
 * Raw input to detect() — deliberately loose.
 * detect() must coerce, never throw.
 */
export interface DetectionInput {
  productName?: string | null;
  externalId?: string | null;
  category?: string | null;
  type?: string | null;
  country?: string | null;
  variant?: string | null;
  publisher?: string | null;
}

export type TokenCategory =
  | "platform"
  | "distribution"
  | "region"
  | "edition"
  | "denomination"
  | "noise";

export interface KnowledgeToken {
  category: TokenCategory;
  token: string; // already normalized
  canonical: string;
  isProductDefining: boolean;
  enabled: boolean;
}

export interface KnowledgeAlias {
  alias: string; // normalized
  expandsTo: string; // normalized
  reason: string | null;
}

export interface KnowledgeOverride {
  matchKind: "normalized_name" | "external_id";
  matchValue: string;
  baseProductKey: string;
  productKey: string;
  reason: string;
}

export interface KnowledgeBase {
  tokens: readonly KnowledgeToken[];
  aliases: readonly KnowledgeAlias[];
  overrides: readonly KnowledgeOverride[];
  /** External-id stability flag per supplier — level-2 signal only applies when true. */
  externalIdStableBySupplier: Readonly<Record<string, boolean>>;
  revision: string;
}

export interface CatalogEntry {
  externalId: string | null;
  productName: string;
  category: string | null;
  type: string | null;
  /** Opaque id the caller uses to map a result back to its own record. */
  refId: string;
}
