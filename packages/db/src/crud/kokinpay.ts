/**
 * CRUD for the KokinPay-backed nickname-check feature (Task 7, the final task
 * of the Digiflazz top-up pilot) — a storefront UX convenience (live "does
 * this account exist?" lookup on the buyer's account field), not a
 * fulfilment path. The HTTP side (request shape, response parsing) lives in
 * @app/core/suppliers/kokinpay; this module only resolves the credentials
 * from Settings. Mirrors crud/digiflazz.ts's getDigiflazzCreds exactly.
 */
import type { KokinpayCreds } from "@app/core/suppliers/kokinpay";
import type { Db } from "./_types";
import { getDecryptedSetting } from "./settings";

/** Setting key — wired to admin Settings (apps/web-admin/src/routes/api/
 * settings.ts EDITABLE/SECRET_KEYS), same as every other `getXCreds`
 * sibling's credential key(s). */
export const KOKINPAY_API_KEY_KEY = "kokinpay_api_key";

/** Read KokinPay credentials from Settings; null = the live nickname-check
 * feature is off (no key configured) — no separate `_enabled` flag, an unset
 * key is equivalent to disabled. Mirrors getDigiflazzCreds's null-on-missing
 * shape, which every call site (the storefront check-account endpoint, the
 * Settings connection test) already treats as "degrade silently, don't
 * error." */
export async function getKokinpayCreds(db: Db): Promise<KokinpayCreds | null> {
  const apiKey = await getDecryptedSetting(db, KOKINPAY_API_KEY_KEY);
  if (!apiKey) return null;
  return { apiKey };
}
