/**
 * Runtime key/value settings — port of the "Settings" section of crud.py.
 */
import type { Db } from "./_types";
import { encryptCredentials, decryptCredentials, settingValueAad } from "@app/core/credentialCrypto";

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

/** Setting keys whose value is encrypted at rest (AES-256-GCM, the same
 * envelope/keyVersion scheme StockItem.credentials already uses). A SUBSET
 * of apps/web-admin/src/routes/api/settings.ts's SECRET_KEYS —
 * bot_token/notif_bot_token are deliberately excluded: they're read via 7+
 * raw getSetting call sites across 3 apps, too many to retrofit safely in
 * one bounded pass, and a missed site would silently hand Telegram an
 * encrypted blob instead of a real token. */
export const ENCRYPTED_SETTING_KEYS = new Set([
  "tokopay_secret", "paydisini_apikey",
  "bybit_api_key", "bybit_api_secret",
  "binance_api_key", "binance_api_secret",
  "nowpayments_api_key", "nowpayments_ipn_secret",
  "bscscan_api_key", "smtp_pass", "digiflazz_api_key",
  "kokinpay_api_key", "coingecko_api_key",
]);

/** Encrypt `plaintext` and store it under `key`. Throws
 * CredentialKeyConfigError (@app/core/credentialCrypto) if
 * CREDENTIAL_ENCRYPTION_KEY isn't configured. */
export async function setEncryptedSetting(db: Db, key: string, plaintext: string): Promise<void> {
  await setSetting(db, key, encryptCredentials(plaintext, settingValueAad(key)));
}

/** Read + decrypt `key`; null when unset, same contract as getSetting.
 * Safe on a legacy plaintext row — decryptCredentials returns those
 * unchanged. */
export async function getDecryptedSetting(db: Db, key: string): Promise<string | null> {
  const raw = await getSetting(db, key);
  return raw === null ? null : decryptCredentials(raw, settingValueAad(key));
}
