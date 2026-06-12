/**
 * TokoPay integration (plan.md §15.5) — the Rupiah payment gateway (QRIS by
 * default). Pattern mirrors the Binance Internal module: this file owns the
 * HTTP/crypto specifics so they can be swapped without touching delivery
 * logic (which lives in @app/db crud/tokopay.ts, webhook-driven).
 *
 * Credentials come from web-admin Settings (NOT env): `tokopay_merchant_id`,
 * `tokopay_secret`, gated by `tokopay_enabled` (§15.9). Empty/disabled means
 * the IDR path is off — checkout shows "Rupiah payment not available yet"
 * while the USDT/Binance path keeps working.
 *
 * ⚠ ASSUMPTION (flagged per plan.md §15.5, like the Binance endpoint note):
 * the endpoint shape below follows TokoPay's public docs as of writing —
 *   GET https://api.tokopay.id/v1/order?merchant=..&secret=..&ref_id=..
 *       &nominal=..&metode=QRIS
 *   → { status: "Success", data: { pay_url, qr_link, qr_string, total_bayar, trx_id } }
 * and the callback signature is md5("merchantId:secret:refId"). VERIFY both
 * against the live TokoPay dashboard/docs before go-live.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import { getSetting, type Db } from "@app/db";

export const TOKOPAY_MERCHANT_KEY = "tokopay_merchant_id";
export const TOKOPAY_SECRET_KEY = "tokopay_secret";
export const TOKOPAY_ENABLED_KEY = "tokopay_enabled";
export const TOKOPAY_CHANNEL_KEY = "tokopay_default_channel";

const API_BASE = process.env.TOKOPAY_API_BASE ?? "https://api.tokopay.id";

export interface TokopayCreds {
  merchantId: string;
  secret: string;
  channel: string;
}

/** Read the gateway credentials from Settings; null = the IDR path is off. */
export async function getTokopayCreds(db: Db): Promise<TokopayCreds | null> {
  const [merchantId, secret, enabled, channel] = await Promise.all([
    getSetting(db, TOKOPAY_MERCHANT_KEY),
    getSetting(db, TOKOPAY_SECRET_KEY),
    getSetting(db, TOKOPAY_ENABLED_KEY),
    getSetting(db, TOKOPAY_CHANNEL_KEY),
  ]);
  if (!merchantId || !secret) return null;
  if ((enabled ?? "").trim().toLowerCase() === "false") return null;
  return { merchantId, secret, channel: (channel ?? "QRIS").trim() || "QRIS" };
}

export interface TokopayOrderInfo {
  trxId: string;
  payUrl: string | null;
  qrLink: string | null;
  qrString: string | null;
  totalBayar: string | null;
}

/**
 * Create (or fetch — TokoPay treats ref_id as idempotent) the gateway
 * transaction for an order. `refId` = our orderCode; `nominal` = the exact
 * central-IDR total (whole Rupiah).
 */
export async function createTransaction(
  creds: TokopayCreds,
  args: { refId: string; amountIdr: Decimal.Value },
): Promise<TokopayOrderInfo> {
  const params = new URLSearchParams({
    merchant: creds.merchantId,
    secret: creds.secret,
    ref_id: args.refId,
    nominal: new Decimal(args.amountIdr).toFixed(0),
    metode: creds.channel,
  });
  const res = await fetch(`${API_BASE}/v1/order?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`TokoPay order HTTP ${res.status}`); // never log the query — it carries the secret
  }
  const body = (await res.json()) as {
    status?: unknown;
    data?: Record<string, unknown>;
    error_msg?: unknown;
  };
  const ok = String(body.status ?? "").toLowerCase() === "success" || body.status === 200;
  if (!ok || !body.data) {
    throw new Error(`TokoPay order rejected: ${String(body.error_msg ?? body.status ?? "unknown")}`);
  }
  const d = body.data;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const trxId = str(d.trx_id) ?? str(d.reference) ?? args.refId;
  return {
    trxId,
    payUrl: str(d.pay_url) ?? str(d.checkout_url),
    qrLink: str(d.qr_link),
    qrString: str(d.qr_string),
    totalBayar: d.total_bayar != null ? String(d.total_bayar) : null,
  };
}

/** Fields we read from a TokoPay callback POST (unknown-shape tolerant). */
export interface TokopayCallback {
  refId: string;
  trxId: string;
  amount: Decimal;
  paid: boolean;
}

/**
 * Verify a callback's signature and normalize its payload. Returns null when
 * the signature is wrong/missing — the webhook MUST drop those (§15.5:
 * verify before anything else).
 */
export function verifyCallback(
  body: Record<string, unknown>,
  creds: Pick<TokopayCreds, "merchantId" | "secret">,
): TokopayCallback | null {
  const refId = firstString(body.ref_id, body.reff_id, body.reference);
  const signature = firstString(body.signature, body.sign);
  if (!refId || !signature) return null;

  const expected = createHash("md5")
    .update(`${creds.merchantId}:${creds.secret}:${refId}`)
    .digest("hex");
  if (!constantTimeEqual(expected, signature.toLowerCase())) {
    logger.warn(`TokoPay callback signature mismatch for ref ${refId}`);
    return null;
  }

  const amountRaw = firstString(body.nominal, body.amount, body.total_bayar) ?? "0";
  let amount: Decimal;
  try {
    amount = new Decimal(amountRaw);
  } catch {
    amount = new Decimal(0);
  }
  const status = (firstString(body.status) ?? "").toLowerCase();
  return {
    refId,
    trxId: firstString(body.trx_id, body.reference) ?? refId,
    amount,
    paid: ["success", "completed", "paid", "settlement"].includes(status),
  };
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
