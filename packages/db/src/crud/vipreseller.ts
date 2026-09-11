/**
 * CRUD for the VIP-Reseller-backed region-check feature (Region-check Task A)
 * — a second, independent supplier used only to detect a buyer's account
 * region (via its `country` field on Mobile Legends lookups), catching a
 * buyer who picked the wrong region variant of a game. The HTTP side
 * (request shape, response parsing) lives in @app/core/suppliers/
 * vipreseller; this module only resolves the credentials from Settings.
 * Mirrors crud/kokinpay.ts's getKokinpayCreds, except VIP-Reseller needs TWO
 * credential values (api_id + api_key), both required.
 */
import type { VipResellerCreds } from "@app/core/suppliers/vipreseller";
import type { Db } from "./_types";
import { getSetting, getDecryptedSetting } from "./settings";

/** Setting keys — wired to admin Settings (apps/web-admin/src/routes/api/
 * settings.ts EDITABLE/SECRET_KEYS), same as every other `getXCreds`
 * sibling's credential key(s). */
export const VIPRESELLER_API_ID_KEY = "vipreseller_api_id";
export const VIPRESELLER_API_KEY_KEY = "vipreseller_api_key";

/** Read VIP-Reseller credentials from Settings; null = the region-check
 * feature is off (either value missing) — no separate `_enabled` flag, same
 * "unset key(s) == disabled" convention as getKokinpayCreds. Every call site
 * (the storefront region-check endpoint (Task C), the Settings connection
 * test) is expected to treat null as "degrade silently, don't error." */
export async function getVipResellerCreds(db: Db): Promise<VipResellerCreds | null> {
  const apiId = await getSetting(db, VIPRESELLER_API_ID_KEY);
  const apiKey = await getDecryptedSetting(db, VIPRESELLER_API_KEY_KEY);
  if (!apiId || !apiKey) return null;
  return { apiId, apiKey };
}
