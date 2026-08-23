/**
 * CRUD for the MeloStore-backed nickname-check feature — a storefront UX convenience
 * (live "does this account exist?" lookup on the buyer's account field), not a
 * fulfilment path. The HTTP side (request shape, response parsing) lives in
 * @app/core/suppliers/melostore; this module only resolves the credentials
 * from Settings. Mirrors crud/kokinpay.ts exactly.
 */
import type { Db } from "./_types";
import { getSetting } from "./settings";

/** Setting key — wired to admin Settings (apps/web-admin/src/routes/api/
 * settings.ts EDITABLE/SECRET_KEYS), same as every other `getXCreds`
 * sibling's credential key(s). */
export const MELOSTORE_API_KEY_KEY = "melostore_api_key";

/** Setting key for MeloStore secret. */
export const MELOSTORE_SECRET_KEY_KEY = "melostore_secret_key";

export interface MelostoreCreds {
  apiKey: string;
  secretKey: string;
}

/** Read MeloStore credentials from Settings; null = the live nickname-check
 * feature is off (no keys configured) — no separate `_enabled` flag, an unset
 * key is equivalent to disabled. Mirrors getKokinpayCreds's null-on-missing
 * shape, which every call site (the storefront check-account endpoint, the
 * Settings connection test) already treats as "degrade silently, don't
 * error." */
export async function getMelostoreCreds(db: Db): Promise<MelostoreCreds | null> {
  const apiKey = await getSetting(db, MELOSTORE_API_KEY_KEY);
  const secretKey = await getSetting(db, MELOSTORE_SECRET_KEY_KEY);
  if (!apiKey || !secretKey) return null;
  return { apiKey, secretKey };
}
