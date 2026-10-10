/**
 * Footer payment-logo display flags, derived from gateway settings WITHOUT
 * decrypting any secret. `GET /pages/context` runs on every storefront page,
 * so it must never throw because one credential row is corrupt or the
 * encryption key rotated (the `get*Creds` readers decrypt and can throw).
 * "Configured" mirrors those readers exactly — same keys non-empty, same
 * `*_enabled !== "false"` rule — just on the stored (possibly encrypted) value.
 */
import { TOKOPAY_MERCHANT_KEY, TOKOPAY_SECRET_KEY, TOKOPAY_ENABLED_KEY } from "@app/core/payments/tokopay";
import { PAYDISINI_USERKEY_KEY, PAYDISINI_APIKEY_KEY, PAYDISINI_ENABLED_KEY } from "@app/core/payments/paydisini";
import type { Db } from "./_types";
import { getSetting } from "./settings";

const isOff = (v: string | null): boolean => (v ?? "").trim().toLowerCase() === "false";

export async function getPayMethodDisplayFlags(db: Db): Promise<{ qris: boolean; card: boolean }> {
  const [tpMerchant, tpSecret, tpEnabled, pdUser, pdKey, pdEnabled] =
    await Promise.all([
      getSetting(db, TOKOPAY_MERCHANT_KEY),
      getSetting(db, TOKOPAY_SECRET_KEY),
      getSetting(db, TOKOPAY_ENABLED_KEY),
      getSetting(db, PAYDISINI_USERKEY_KEY),
      getSetting(db, PAYDISINI_APIKEY_KEY),
      getSetting(db, PAYDISINI_ENABLED_KEY),
    ]);
  const tokopay = Boolean(tpMerchant && tpSecret) && !isOff(tpEnabled);
  const paydisini = Boolean(pdUser && pdKey) && !isOff(pdEnabled);
  // Xendit is currently admin configuration/probing only: checkoutView has
  // no Xendit rail. Credentials/switches must not advertise card acceptance.
  return {
    qris: tokopay || paydisini,
    card: false,
  };
}
