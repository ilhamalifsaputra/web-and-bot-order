/** Effective defaults mirror the runtime consumers; persistence remains legacy strings. */
const DEFAULT_ON = new Set(["usd_idr_rate_auto", "digiflazz_enabled", "tokopay_enabled", "xendit_enabled", "paydisini_enabled", "nowpayments_enabled", "bybit_enabled", "bybit_bsc_enabled", "binance_internal_enabled"]);
const DEFAULT_OFF = new Set(["owner_email_enabled", "owner_email_on_paid_order", "owner_email_on_manual_queue", "owner_email_on_new_ticket", "owner_email_on_ticket_reply", "owner_email_on_wallet_topup", "xendit_qris_enabled", "xendit_card_enabled", "bulk_purchase_broadcast_enabled"]);
export function resolveBooleanSetting(key: string, raw: string | null | undefined, options: {smtpSecure: boolean}): boolean | undefined {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (key === "smtp_secure") return normalized ? normalized === "true" : options.smtpSecure;
  if (DEFAULT_ON.has(key)) return normalized !== "false";
  if (DEFAULT_OFF.has(key)) return normalized === "true";
  return undefined;
}
