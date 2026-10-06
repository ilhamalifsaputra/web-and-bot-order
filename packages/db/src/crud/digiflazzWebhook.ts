/**
 * The Digiflazz webhook secret — the key Digiflazz uses to sign every webhook
 * delivery (`X-Hub-Signature: sha1=<HMAC-SHA1 of the raw body>`, see
 * `verifyWebhook` in @app/core/suppliers/digiflazz). It is set by the shop in
 * the Digiflazz dashboard next to the callback URL, and pasted into admin
 * Settings here; it is NOT the API key, which signs this shop's outbound
 * requests instead.
 *
 * Lives in its own module rather than on `getDigiflazzCreds`
 * (crud/digiflazz.ts) so the supplier credentials the dispatch poller and the
 * catalog sync read stay unchanged; the webhook route reads both.
 */
import type { Db } from "./_types";
import { getDecryptedSetting } from "./settings";

/** Setting key — encrypted at rest (crud/settings.ts ENCRYPTED_SETTING_KEYS)
 * and masked in admin Settings (apps/web-admin/src/routes/api/settings.ts
 * EDITABLE/SECRET_KEYS), exactly like `digiflazz_api_key`. */
export const DIGIFLAZZ_WEBHOOK_SECRET_KEY = "digiflazz_webhook_secret";

/** Read + decrypt the webhook secret; null when unset or blank, which the
 * webhook route treats as "webhooks disabled" (every delivery refused). */
export async function getDigiflazzWebhookSecret(db: Db): Promise<string | null> {
  const secret = await getDecryptedSetting(db, DIGIFLAZZ_WEBHOOK_SECRET_KEY);
  if (!secret || !secret.trim()) return null;
  return secret;
}
