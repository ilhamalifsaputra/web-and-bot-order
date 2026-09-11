/**
 * Catalog index construction for the Detection Engine.
 *
 * `buildCatalogIndex` turns a flat list of `CatalogEntry` rows into a
 * `CatalogIndex`: a handful of `Map`s keyed by the different lookup
 * strategies `engine.ts` needs (exact productKey/baseKey match, literal
 * normalized-name match, despaced-name match, external id match). This is
 * a one-time (or revision-triggered) build step — `detect()` never scans
 * `entries` itself, only does O(1) `Map.get` calls against the index built
 * here (AC-13).
 *
 * INV-1 (determinism): every bucket array is sorted lexicographically by
 * `productKey` (plain `<`/`>` comparator, never `localeCompare`) before
 * being frozen into the exposed `ReadonlyMap`, so no downstream consumer
 * ever depends on Map insertion order or entries[] array order for ties —
 * `Array.prototype.sort` is a stable sort (ES2019+), so entries that tie on
 * productKey keep their original `entries` array relative order, which is
 * itself just the caller-supplied array order, not any Map/Set iteration.
 * INV-5 (engine purity): no @prisma/client, @app/db, or I/O — `entries` is
 * handed in by the caller (a later, DB-backed task), not fetched here.
 */

import type { CatalogEntry, KnowledgeBase } from "./types";
import { normalize } from "./normalize";
import { despace } from "./tokenize";
import { extractFeatures } from "./features";
import { buildBaseProductKey, buildProductKey } from "./keys";

export interface CatalogIndex {
  readonly byProductKey: ReadonlyMap<string, readonly CatalogEntry[]>;
  readonly byBaseKey: ReadonlyMap<string, readonly CatalogEntry[]>;
  readonly byNormalizedName: ReadonlyMap<string, readonly CatalogEntry[]>;
  readonly byDespacedName: ReadonlyMap<string, readonly CatalogEntry[]>;
  readonly byExternalId: ReadonlyMap<string, readonly CatalogEntry[]>;
  readonly stamp: string;
  readonly entryCount: number;
}

interface IndexedEntry {
  readonly entry: CatalogEntry;
  readonly productKey: string;
}

function pushInto(bucketMap: Map<string, IndexedEntry[]>, key: string, indexed: IndexedEntry): void {
  const existing = bucketMap.get(key);
  if (existing) {
    existing.push(indexed);
  } else {
    bucketMap.set(key, [indexed]);
  }
}

/** Sorts each bucket by productKey (stable, plain comparator) and freezes it into a ReadonlyMap of bare CatalogEntry[]. */
function finalizeBuckets(bucketMap: Map<string, IndexedEntry[]>): ReadonlyMap<string, readonly CatalogEntry[]> {
  const result = new Map<string, readonly CatalogEntry[]>();
  for (const [key, bucket] of bucketMap) {
    const sorted = [...bucket].sort((a, b) => {
      if (a.productKey < b.productKey) return -1;
      if (a.productKey > b.productKey) return 1;
      return 0;
    });
    result.set(key, Object.freeze(sorted.map((indexed) => indexed.entry)));
  }
  return result;
}

export function buildCatalogIndex(
  entries: readonly CatalogEntry[],
  knowledge: KnowledgeBase,
  stamp: string,
): CatalogIndex {
  const byProductKeyRaw = new Map<string, IndexedEntry[]>();
  const byBaseKeyRaw = new Map<string, IndexedEntry[]>();
  const byNormalizedNameRaw = new Map<string, IndexedEntry[]>();
  const byDespacedNameRaw = new Map<string, IndexedEntry[]>();
  const byExternalIdRaw = new Map<string, IndexedEntry[]>();

  for (const entry of entries) {
    const normalizedName = normalize(entry.productName);
    const features = extractFeatures(normalizedName, knowledge);
    const baseProductKey = buildBaseProductKey(features.coreTokens);
    const productKey = buildProductKey(baseProductKey, features.definingTokens);
    const indexed: IndexedEntry = { entry, productKey };

    pushInto(byProductKeyRaw, productKey, indexed);
    pushInto(byBaseKeyRaw, baseProductKey, indexed);
    pushInto(byNormalizedNameRaw, normalizedName, indexed);
    pushInto(byDespacedNameRaw, despace(normalizedName), indexed);
    if (entry.externalId !== null && entry.externalId.length > 0) {
      pushInto(byExternalIdRaw, entry.externalId, indexed);
    }
  }

  return {
    byProductKey: finalizeBuckets(byProductKeyRaw),
    byBaseKey: finalizeBuckets(byBaseKeyRaw),
    byNormalizedName: finalizeBuckets(byNormalizedNameRaw),
    byDespacedName: finalizeBuckets(byDespacedNameRaw),
    byExternalId: finalizeBuckets(byExternalIdRaw),
    stamp,
    entryCount: entries.length,
  };
}
