/**
 * Xendit gateway credentials, read from Settings. Admin configuration only for
 * now; the payment flow lands in a later branch.
 */
import {
  XENDIT_ENABLED_KEY,
  XENDIT_SECRET_KEY,
  XENDIT_CALLBACK_TOKEN_KEY,
  XENDIT_QRIS_ENABLED_KEY,
  XENDIT_CARD_ENABLED_KEY,
  type XenditCreds,
} from "@app/core/payments/xendit";
import type { Db } from "./_types";
import { getSetting, getDecryptedSetting } from "./settings";

const isTrue = (v: string | null): boolean => (v ?? "").trim().toLowerCase() === "true";

/** Read Xendit credentials; null = Xendit is off (missing key/token or switched off). */
export async function getXenditCreds(db: Db): Promise<XenditCreds | null> {
  const [secretKey, callbackToken, enabled, qris, card] = await Promise.all([
    getDecryptedSetting(db, XENDIT_SECRET_KEY),
    getDecryptedSetting(db, XENDIT_CALLBACK_TOKEN_KEY),
    getSetting(db, XENDIT_ENABLED_KEY),
    getSetting(db, XENDIT_QRIS_ENABLED_KEY),
    getSetting(db, XENDIT_CARD_ENABLED_KEY),
  ]);
  if (!secretKey || !callbackToken) return null;
  if ((enabled ?? "").trim().toLowerCase() === "false") return null;
  return { secretKey, callbackToken, qrisEnabled: isTrue(qris), cardEnabled: isTrue(card) };
}
