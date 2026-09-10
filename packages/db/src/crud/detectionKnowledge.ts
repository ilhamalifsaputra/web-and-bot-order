/**
 * DB-backed Knowledge Base for the Detection Engine
 * (packages/core/src/detection) — loads/merges the `detection_tokens` /
 * `detection_aliases` / `detection_overrides` tables into the pure engine's
 * `KnowledgeBase` shape, and provides admin-facing upsert mutators.
 *
 * Cache: same WeakMap + 30s-TTL pattern as crud/settings.ts's `getSetting`
 * (scoped per `Db` instance so distinct test fixtures / `$transaction` tx
 * clients never share a cache), PLUS a revision check on every read — every
 * mutator bumps the `detection_knowledge_revision` Settings key, so a write
 * through one `Db` handle is visible to reads through that SAME handle
 * immediately (the revision lookup itself rides `getSetting`'s own TTL
 * cache, so this costs a cheap Map lookup in the common case, not an extra
 * DB round trip) even before the outer 30s TTL would otherwise have expired.
 *
 * Fallback rule: DEFAULT_KNOWLEDGE_BASE is returned as-is ONLY when all three
 * tables are completely empty (fresh install, before
 * scripts/seed-detection-knowledge.ts has ever run). The moment any table
 * has a row, DB rows are the WHOLE picture for tokens/aliases/overrides —
 * they are never silently blended with the defaults — except that the
 * default vocabulary's `noise`-category tokens are always unioned in as a
 * safety net (seeding is expected to have copied them into the DB already;
 * this union just means a hand-edited DB that skipped seeding never loses
 * noise-token filtering).
 *
 * Never silently drops a bad row: the merged result is validated against
 * `knowledgeBaseSchema` and any failure throws with the specific field path
 * that failed, naming the offending row.
 */
import type { Db } from "./_types";
import { logAdminAction } from "./audit";
import { getSetting, setSetting } from "./settings";
import {
  knowledgeBaseSchema,
  type KnowledgeAlias,
  type KnowledgeBase,
  type KnowledgeOverride,
  type KnowledgeToken,
  type TokenCategory,
} from "@app/core/detection";
import { DEFAULT_KNOWLEDGE_BASE } from "@app/core/detection/knowledge";

const KNOWLEDGE_TTL_MS = 30_000;
const KNOWLEDGE_REVISION_KEY = "detection_knowledge_revision";

interface KnowledgeCacheEntry {
  value: KnowledgeBase;
  expiresAt: number;
  /** The `detection_knowledge_revision` Settings value this entry was built
   * under (null when unset, e.g. before any mutator has ever run). */
  revision: string | null;
}
const knowledgeCaches = new WeakMap<object, KnowledgeCacheEntry>();

async function bumpDetectionKnowledgeRevision(db: Db): Promise<void> {
  const current = await getSetting(db, KNOWLEDGE_REVISION_KEY);
  const currentNumber = current === null ? 0 : Number(current);
  const next = String((Number.isFinite(currentNumber) ? currentNumber : 0) + 1);
  await setSetting(db, KNOWLEDGE_REVISION_KEY, next);
}

export async function loadKnowledgeBase(db: Db): Promise<KnowledgeBase> {
  const now = Date.now();
  const cached = knowledgeCaches.get(db as object);
  if (cached && cached.expiresAt > now) {
    const currentRevision = await getSetting(db, KNOWLEDGE_REVISION_KEY);
    if (currentRevision === cached.revision) {
      return cached.value;
    }
  }

  const [tokenRows, aliasRows, overrideRows, revision] = await Promise.all([
    db.detectionToken.findMany(),
    db.detectionAlias.findMany(),
    db.detectionOverride.findMany(),
    getSetting(db, KNOWLEDGE_REVISION_KEY),
  ]);

  if (tokenRows.length === 0 && aliasRows.length === 0 && overrideRows.length === 0) {
    knowledgeCaches.set(db as object, {
      value: DEFAULT_KNOWLEDGE_BASE,
      expiresAt: now + KNOWLEDGE_TTL_MS,
      revision,
    });
    return DEFAULT_KNOWLEDGE_BASE;
  }

  const dbTokens: KnowledgeToken[] = tokenRows.map((row) => ({
    category: row.category as TokenCategory,
    token: row.token,
    canonical: row.canonical,
    isProductDefining: row.isProductDefining,
    enabled: row.enabled,
  }));
  const dbTokenKeys = new Set(dbTokens.map((t) => `${t.category}:${t.token}`));
  const noiseDefaults = DEFAULT_KNOWLEDGE_BASE.tokens.filter(
    (t) => t.category === "noise" && !dbTokenKeys.has(`${t.category}:${t.token}`),
  );

  const aliases: KnowledgeAlias[] = aliasRows.map((row) => ({
    alias: row.alias,
    expandsTo: row.expandsTo,
    reason: row.reason,
  }));

  const overrides: KnowledgeOverride[] = overrideRows.map((row) => ({
    matchKind: row.matchKind as KnowledgeOverride["matchKind"],
    matchValue: row.matchValue,
    baseProductKey: row.baseProductKey,
    productKey: row.productKey,
    reason: row.reason,
  }));

  const candidate: KnowledgeBase = {
    tokens: [...dbTokens, ...noiseDefaults],
    aliases,
    overrides,
    externalIdStableBySupplier: DEFAULT_KNOWLEDGE_BASE.externalIdStableBySupplier,
    revision: revision ?? "0",
  };

  const parsed = knowledgeBaseSchema.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `loadKnowledgeBase: detection knowledge base data loaded from the database failed validation — ${detail}`,
    );
  }

  knowledgeCaches.set(db as object, { value: parsed.data, expiresAt: now + KNOWLEDGE_TTL_MS, revision });
  return parsed.data;
}

export async function upsertDetectionToken(
  db: Db,
  args: {
    category: TokenCategory;
    token: string;
    canonical: string;
    isProductDefining: boolean;
    enabled?: boolean;
  },
  adminId: number | null,
): Promise<void> {
  const enabled = args.enabled ?? true;
  const row = await db.detectionToken.upsert({
    where: { category_token: { category: args.category, token: args.token } },
    create: {
      category: args.category,
      token: args.token,
      canonical: args.canonical,
      isProductDefining: args.isProductDefining,
      enabled,
    },
    update: {
      canonical: args.canonical,
      isProductDefining: args.isProductDefining,
      enabled,
    },
  });

  await logAdminAction(db, {
    adminId,
    action: "detection_token_upsert",
    targetType: "detection_token",
    targetId: row.id,
    details: `Set the "${args.category}" detection token "${args.token}" (canonical "${args.canonical}")${args.isProductDefining ? ", product-defining" : ""}${enabled ? "" : ", disabled"}.`,
  });

  await bumpDetectionKnowledgeRevision(db);
}

export async function upsertDetectionAlias(
  db: Db,
  args: { alias: string; expandsTo: string; reason?: string | null },
  adminId: number | null,
): Promise<void> {
  const reason = args.reason ?? null;
  const row = await db.detectionAlias.upsert({
    where: { alias: args.alias },
    create: { alias: args.alias, expandsTo: args.expandsTo, reason },
    update: { expandsTo: args.expandsTo, reason },
  });

  await logAdminAction(db, {
    adminId,
    action: "detection_alias_upsert",
    targetType: "detection_alias",
    targetId: row.id,
    details: `Set the detection alias "${args.alias}" to expand to "${args.expandsTo}".`,
  });

  await bumpDetectionKnowledgeRevision(db);
}

export async function upsertDetectionOverride(
  db: Db,
  args: {
    matchKind: "normalized_name" | "external_id";
    matchValue: string;
    productKey: string;
    baseProductKey: string;
    reason: string;
  },
  adminId: number | null,
): Promise<void> {
  const row = await db.detectionOverride.upsert({
    where: { matchKind_matchValue: { matchKind: args.matchKind, matchValue: args.matchValue } },
    create: {
      matchKind: args.matchKind,
      matchValue: args.matchValue,
      productKey: args.productKey,
      baseProductKey: args.baseProductKey,
      reason: args.reason,
    },
    update: {
      productKey: args.productKey,
      baseProductKey: args.baseProductKey,
      reason: args.reason,
    },
  });

  await logAdminAction(db, {
    adminId,
    action: "detection_override_upsert",
    targetType: "detection_override",
    targetId: row.id,
    details: `Set a detection override matching ${args.matchKind === "external_id" ? "external id" : "normalized name"} "${args.matchValue}" to resolve to product "${args.productKey}". Reason: ${args.reason}`,
  });

  await bumpDetectionKnowledgeRevision(db);
}

/** Test-only escape hatch: drops `db`'s cached KnowledgeBase entry. Test
 * suites wipe the detection_* tables directly, which would otherwise leave
 * this cache serving a stale value for tables that are actually empty (same
 * rationale as settings.ts's __clearSettingsCacheForTests). */
export function __clearDetectionKnowledgeCacheForTests(db: Db): void {
  knowledgeCaches.delete(db as object);
}
