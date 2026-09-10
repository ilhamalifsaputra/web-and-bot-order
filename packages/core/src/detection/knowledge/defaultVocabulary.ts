/**
 * Default/fallback/seed vocabulary for the Knowledge Base.
 *
 * This is the ONE place (besides __fixtures__/) where literal words are allowed.
 * Contains generic gaming/top-up terms grounded in real Digiflazz vocabulary —
 * no invented brand names.
 */

import type { KnowledgeBase } from "../types";

const defaultTokens = [
  // Platform tokens (isProductDefining: true)
  {
    category: "platform" as const,
    token: "mobile",
    canonical: "mobile",
    isProductDefining: true,
    enabled: true,
  },
  {
    category: "platform" as const,
    token: "pc",
    canonical: "pc",
    isProductDefining: true,
    enabled: true,
  },
  {
    category: "platform" as const,
    token: "console",
    canonical: "console",
    isProductDefining: true,
    enabled: true,
  },

  // Edition tokens (isProductDefining: true)
  {
    category: "edition" as const,
    token: "max",
    canonical: "max",
    isProductDefining: true,
    enabled: true,
  },
  {
    category: "edition" as const,
    token: "lite",
    canonical: "lite",
    isProductDefining: true,
    enabled: true,
  },
  {
    category: "edition" as const,
    token: "pro",
    canonical: "pro",
    isProductDefining: true,
    enabled: true,
  },
  {
    category: "edition" as const,
    token: "plus",
    canonical: "plus",
    isProductDefining: true,
    enabled: true,
  },

  // Distribution tokens (isProductDefining: true per plan)
  {
    category: "distribution" as const,
    token: "garena",
    canonical: "garena",
    isProductDefining: true,
    enabled: true,
  },
  {
    category: "distribution" as const,
    token: "global",
    canonical: "global",
    isProductDefining: true,
    enabled: true,
  },

  // Region tokens (isProductDefining: false — distribution-only per spec)
  {
    category: "region" as const,
    token: "id",
    canonical: "id",
    isProductDefining: false,
    enabled: true,
  },
  {
    category: "region" as const,
    token: "sg",
    canonical: "sg",
    isProductDefining: false,
    enabled: true,
  },
  {
    category: "region" as const,
    token: "my",
    canonical: "my",
    isProductDefining: false,
    enabled: true,
  },

  // Noise tokens (ported from packages/core/src/suppliers/digiflazz.ts:180-186)
  {
    category: "noise" as const,
    token: "instant",
    canonical: "instant",
    isProductDefining: false,
    enabled: true,
  },
  {
    category: "noise" as const,
    token: "proses cepat",
    canonical: "proses cepat",
    isProductDefining: false,
    enabled: true,
  },
] as const;

// Frozen at the definition site: `loadKnowledgeBase` returns this object BY
// REFERENCE on the empty-tables fallback path (no clone), and it is a shared
// module singleton imported directly by fixtures and the engine. Freezing the
// object AND its nested arrays/record here means a stray JS-level mutation
// throws in strict mode instead of silently corrupting the process-wide
// singleton — O(1), and it protects every consumer, not just the loader.
export const DEFAULT_KNOWLEDGE_BASE: KnowledgeBase = Object.freeze({
  tokens: Object.freeze(defaultTokens),
  aliases: Object.freeze([]),
  overrides: Object.freeze([]),
  externalIdStableBySupplier: Object.freeze({
    digiflazz: true,
  }),
  revision: "default",
});
