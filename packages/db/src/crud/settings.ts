/**
 * Runtime key/value settings — port of the "Settings" section of crud.py.
 */
import type { Db } from "./_types";

// Settings are read constantly on hot paths (bot menu banner, FX rate for
// pricing) but change only when an admin edits them, so a short TTL cache
// cuts near-every-update DB round trips to almost none while still picking
// up admin edits within a second.
//
// Scoped per `db` instance (WeakMap) rather than a single global Map: the
// production process only ever passes the one PrismaClient singleton, so
// this behaves like one shared cache there, but it also means two distinct
// `Db` objects (e.g. different test fixtures, or a `$transaction` tx client)
// never see each other's cached values.
const TTL_MS = 30_000;
type SettingsCache = Map<string, { value: string | null; expiresAt: number }>;
const caches = new WeakMap<object, SettingsCache>();

function cacheFor(db: Db): SettingsCache {
  let c = caches.get(db as object);
  if (!c) {
    c = new Map();
    caches.set(db as object, c);
  }
  return c;
}

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const cache = cacheFor(db);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const s = await db.setting.findUnique({ where: { key } });
  const value = s ? s.value : null;
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export async function setSetting(db: Db, key: string, value: string) {
  await db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  cacheFor(db).set(key, { value, expiresAt: Date.now() + TTL_MS });
}

export function listAllSettings(db: Db) {
  return db.setting.findMany({ orderBy: { key: "asc" } });
}

/** Remove a setting if present (no-op if it doesn't exist). */
export async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.setting.deleteMany({ where: { key } });
  cacheFor(db).delete(key);
}

/**
 * Test-only escape hatch: drops `db`'s cached entries. Production never
 * bypasses `setSetting`/`deleteSetting`, so it never needs this — but test
 * suites wipe the `Setting` table directly (`tests/helpers/sampleData.ts`'s
 * `resetDb`), which would otherwise leave this cache serving stale values for
 * a table that's actually empty.
 */
export function __clearSettingsCacheForTests(db: Db): void {
  caches.delete(db as object);
}
