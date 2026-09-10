/**
 * Barrel for the pure Detection Engine (Tasks 1-6). Re-exports every public
 * symbol from the engine's structural files — never anything from
 * knowledge/defaultVocabulary.ts (that has its own subpath export,
 * "./detection/knowledge", see packages/core/package.json) or
 * __fixtures__/** (test-only synthetic data, never a public API surface).
 *
 * knowledge/schema.ts IS re-exported here (not from the "./detection/knowledge"
 * subpath) — it's pure structure (a zod validator, no product-specific
 * literals), used by DB-backed callers (packages/db/src/crud/detectionKnowledge.ts)
 * to validate merged KnowledgeBase data before handing it to detect().
 */

export * from "./types";
export * from "./version";
export * from "./normalize";
export * from "./tokenize";
export * from "./features";
export * from "./keys";
export * from "./scoring";
export * from "./indexBuild";
export * from "./engine";
export * from "./knowledge/schema";
