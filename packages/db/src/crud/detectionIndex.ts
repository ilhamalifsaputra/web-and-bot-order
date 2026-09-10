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
import { loadKnowledgeBase } from "./detectionKnowledge";
import { buildCatalogIndex, buildDetectorStamp, type CatalogEntry, type CatalogIndex } from "@app/core/detection";

const CATALOG_TTL_MS = 30_000;
const CATALOG_REVISION_KEY = "detection_catalog_revision";

interface CatalogCacheEntry {
  value: CatalogIndex;
  expiresAt: number;
  /** The `detection_catalog_revision` Settings value this entry was built
   * under (null when unset, e.g. before bumpCatalogRevision has ever run). */
  revision: string | null;
}
const catalogCaches = new WeakMap<object, CatalogCacheEntry>();

export async function getCatalogIndex(db: Db): Promise<CatalogIndex> {
  const now = Date.now();
  const cached = catalogCaches.get(db as object);
  if (cached && cached.expiresAt > now) {
    const currentRevision = await getSetting(db, CATALOG_REVISION_KEY);
    if (currentRevision === cached.revision) {
      return cached.value;
    }
  }

  const [products, revision, knowledge] = await Promise.all([
    db.product.findMany({
      where: { digiflazzBrand: { not: null } },
      select: { id: true, name: true },
    }),
    getSetting(db, CATALOG_REVISION_KEY),
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

  catalogCaches.set(db as object, { value: index, expiresAt: now + CATALOG_TTL_MS, revision });
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
