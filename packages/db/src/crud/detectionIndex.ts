/**
 * DB-backed catalog index for the Detection Engine (packages/core/src/detection).
 * Sources `CatalogEntry[]` from the live catalog and hands it to the pure
 * engine's `buildCatalogIndex` (packages/core/src/detection/indexBuild.ts) —
 * this module does the I/O, the engine stays pure per its own INV-5.
 *
 * Catalog source (this task): every `Product` with a non-null `digiflazzBrand`,
 * mapped to a minimal `CatalogEntry` keyed by the Product's own id
 * (`refId`). Not exhaustive by design — a later task refines what counts as
 * a catalog row (denomination-level entries, external ids, category/type).
 *
 * Cache: same WeakMap + 30s-TTL + revision-counter pattern as
 * crud/detectionKnowledge.ts, keyed off the `detection_catalog_revision`
 * Settings value. `bumpCatalogRevision` is the primitive any future
 * catalog-mutating crud function calls to invalidate this cache; wiring
 * those call sites happens in a later task.
 */
import type { Db } from "./_types";
import { getSetting, setSetting } from "./settings";
import { KNOWLEDGE_REVISION_KEY, loadKnowledgeBase } from "./detectionKnowledge";
import { buildCatalogIndex, buildDetectorStamp, type CatalogEntry, type CatalogIndex } from "@app/core/detection";

const CATALOG_TTL_MS = 30_000;
const CATALOG_REVISION_KEY = "detection_catalog_revision";

interface CatalogCacheEntry {
  value: CatalogIndex;
  expiresAt: number;
  /** `${detection_catalog_revision}|${detection_knowledge_revision}` as read
   * when this entry was built (each half is the literal string `null` when
   * that Settings key is unset). The index bakes in BOTH a snapshot of the
   * catalog rows AND a snapshot of the knowledge base (via
   * `buildCatalogIndex(entries, knowledge, stamp)`), so a knowledge-token
   * edit — which bumps `detection_knowledge_revision`, not the catalog
   * revision — must invalidate this cache too, not just wait out the TTL. */
  revisionKey: string;
}
const catalogCaches = new WeakMap<object, CatalogCacheEntry>();

/** Combined cache key over both revision counters — cache is fresh only when
 * BOTH still match what was stored at build time. */
function revisionKey(catalogRevision: string | null, knowledgeRevision: string | null): string {
  return `${catalogRevision}|${knowledgeRevision}`;
}

export async function getCatalogIndex(db: Db): Promise<CatalogIndex> {
  const now = Date.now();
  const cached = catalogCaches.get(db as object);
  if (cached && cached.expiresAt > now) {
    const [catalogRevision, knowledgeRevision] = await Promise.all([
      getSetting(db, CATALOG_REVISION_KEY),
      getSetting(db, KNOWLEDGE_REVISION_KEY),
    ]);
    if (revisionKey(catalogRevision, knowledgeRevision) === cached.revisionKey) {
      return cached.value;
    }
  }

  const [products, catalogRevision, knowledgeRevision, knowledge] = await Promise.all([
    db.product.findMany({
      where: { digiflazzBrand: { not: null } },
      select: { id: true, name: true },
    }),
    getSetting(db, CATALOG_REVISION_KEY),
    getSetting(db, KNOWLEDGE_REVISION_KEY),
    loadKnowledgeBase(db),
  ]);

  const entries: CatalogEntry[] = products.map((product) => ({
    externalId: null,
    productName: product.name,
    category: null,
    type: null,
    refId: String(product.id),
  }));

  const stamp = buildDetectorStamp(knowledge.revision);
  const index = buildCatalogIndex(entries, knowledge, stamp);

  catalogCaches.set(db as object, {
    value: index,
    expiresAt: now + CATALOG_TTL_MS,
    revisionKey: revisionKey(catalogRevision, knowledgeRevision),
  });
  return index;
}

/** Bump the catalog revision counter, invalidating every `Db` handle's
 * cached `CatalogIndex` (their next `getCatalogIndex` call sees a
 * mismatched revision and rebuilds) — call this from any crud function that
 * mutates a Product/Denomination row `getCatalogIndex` sources from. */
export async function bumpCatalogRevision(db: Db): Promise<void> {
  const current = await getSetting(db, CATALOG_REVISION_KEY);
  const currentNumber = current === null ? 0 : Number(current);
  const next = String((Number.isFinite(currentNumber) ? currentNumber : 0) + 1);
  await setSetting(db, CATALOG_REVISION_KEY, next);
}

/** Test-only escape hatch: drops `db`'s cached CatalogIndex entry — same
 * rationale as detectionKnowledge.ts's __clearDetectionKnowledgeCacheForTests. */
export function __clearDetectionIndexCacheForTests(db: Db): void {
  catalogCaches.delete(db as object);
}
