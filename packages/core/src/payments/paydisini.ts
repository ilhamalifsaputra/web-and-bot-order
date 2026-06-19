/**
 * PayDisini gateway client (HTTP + signature) — shared by the storefront pay page,
 * its webhook route, and the bot's QRIS checkout. Pure: no @app/db dependency
 * (credential resolution lives in @app/db `getPaydisiniCreds`). See DOCS.md §15.5.
 *
 * ⚠ ASSUMPTION (flagged): endpoint shape + signature scheme below follow
 *   PayDisini's public docs as understood at plan-writing time, NOT verified
 *   against a live merchant dashboard. PayDisini's API uses a `user_key` +
 *   `api_key` pair (not TokoPay's `merchant`+`secret`). Verify every field name
 *   below against the live dashboard before go-live.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Decimal } from "../money";
import { logger } from "../logger";

export const PAYDISINI_USERKEY_KEY = "paydisini_userkey";
export const PAYDISINI_APIKEY_KEY = "paydisini_apikey";
export const PAYDISINI_ENABLED_KEY = "paydisini_enabled";
export const PAYDISINI_CHANNEL_KEY = "paydisini_default_channel";

// ⚠ ASSUMPTION (flagged): placeholder base URL, not verified against the live
//   merchant dashboard.
const API_BASE = process.env.PAYDISINI_API_BASE ?? "https://api.paydisini.co.id";

export interface PaydisiniCreds {
  userKey: string;
  apiKey: string;
  channel: string;
}

export interface PaydisiniOrderInfo {
  trxId: string;
  qrString: string | null;
  qrUrl: string | null;
  checkoutUrl: string | null;
  totalBayar: string | null;
}

/** Create (or fetch — ref_id is idempotent) the gateway transaction for an order. */
export async function createTransaction(
  creds: PaydisiniCreds,
  args: { refId: string; amountIdr: Decimal.Value },
): Promise<PaydisiniOrderInfo> {
  const params = new URLSearchParams({
    user_key: creds.userKey,
    api_key: creds.apiKey,
    ref_id: args.refId,
    amount: new Decimal(args.amountIdr).toFixed(0),
    service: creds.channel,
  });
  const res = await fetch(`${API_BASE}/v1/transaction?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`PayDisini order HTTP ${res.status}`); // never log the query — it carries the api key
  }
  const body = (await res.json()) as {
    success?: unknown;
    status?: unknown;
    data?: Record<string, unknown>;
    msg?: unknown;
  };
  const ok = body.success === true || String(body.status ?? "").toLowerCase() === "success" || body.status === 200;
  if (!ok || !body.data) {
    throw new Error(`PayDisini order rejected: ${String(body.msg ?? body.status ?? "unknown")}`);
  }
  const d = body.data;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const trxId = str(d.unique_code) ?? str(d.trx_id) ?? args.refId;
  return {
    trxId,
    qrString: str(d.qr_string) ?? str(d.qr_content),
    qrUrl: str(d.qr_url) ?? str(d.qr_link),
    checkoutUrl: str(d.checkout_url) ?? str(d.payment_url),
    totalBayar: d.amount != null ? String(d.amount) : null,
  };
}

export interface PaydisiniStatus {
  paid: boolean;
  amount: Decimal;
  trxId: string | null;
}

/** Gateway payment-status strings we treat as "paid/settled". */
const PAID_STATES = ["paid", "success", "completed", "settlement", "lunas", "berhasil"];

/**
 * Poll the gateway for an order's current payment status (reconcile path — used
 * by the bot's PayDisini poller when the webhook hasn't arrived). Re-hits the
 * idempotent `/v1/transaction` endpoint with the same `ref_id`; a repeat call
 * returns the existing transaction's status rather than creating a new one.
 *
 * ⚠ ASSUMPTION (flagged, same as the rest of this client): the status field on
 *   the `/v1/transaction` response (`data.status`) follows PayDisini's public
 *   docs. Verify against the live dashboard before go-live.
 */
export async function checkTransaction(
  creds: PaydisiniCreds,
  args: { refId: string; amountIdr: Decimal.Value },
): Promise<PaydisiniStatus> {
  const params = new URLSearchParams({
    user_key: creds.userKey,
    api_key: creds.apiKey,
    ref_id: args.refId,
    amount: new Decimal(args.amountIdr).toFixed(0),
    service: creds.channel,
  });
  const res = await fetch(`${API_BASE}/v1/transaction?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`PayDisini status HTTP ${res.status}`); // never log the query — it carries the api key
  }
  const body = (await res.json()) as {
    success?: unknown;
    status?: unknown;
    data?: Record<string, unknown>;
    msg?: unknown;
  };
  const ok = body.success === true || String(body.status ?? "").toLowerCase() === "success" || body.status === 200;
  if (!ok || !body.data) {
    throw new Error(`PayDisini status rejected: ${String(body.msg ?? body.status ?? "unknown")}`);
  }
  const d = body.data;
  const statusStr = String(d.status ?? "").toLowerCase();
  const amountRaw = d.amount ?? d.nominal ?? args.amountIdr;
  let amount: Decimal;
  try {
    amount = new Decimal(String(amountRaw));
  } catch {
    amount = new Decimal(args.amountIdr);
  }
  const trxId = (typeof d.unique_code === "string" && d.unique_code) || (typeof d.trx_id === "string" && d.trx_id) || null;
  return { paid: PAID_STATES.includes(statusStr), amount, trxId };
}

export interface PaydisiniCallback {
  refId: string;
  trxId: string;
  amount: Decimal;
  paid: boolean;
}

/**
 * Verify a callback's signature + normalize. Returns null on bad/missing signature.
 *
 * ⚠ ASSUMPTION (flagged): the exact signature scheme — which fields are
 *   concatenated and in what order, and whether PayDisini uses md5 or sha256 —
 *   is NOT verified against a live merchant dashboard. This implementation
 *   guesses `md5(merchantApiKey:userKey:refId:amount)` by analogy with
 *   TokoPay's `md5(merchant:secret:ref_id)`. Verify against the live dashboard
 *   before go-live.
 */
export function verifyCallback(
  body: Record<string, unknown>,
  creds: Pick<PaydisiniCreds, "userKey" | "apiKey">,
): PaydisiniCallback | null {
  const refId = firstString(body.ref_id, body.unique_code, body.reference);
  const signature = firstString(body.signature, body.sign);
  if (!refId || !signature) return null;

  const amountRaw = firstString(body.amount, body.nominal) ?? "0";

  const expected = createHash("md5")
    .update(`${creds.apiKey}:${creds.userKey}:${refId}:${amountRaw}`)
    .digest("hex");
  if (!constantTimeEqual(expected, signature.toLowerCase())) {
    logger.warn(`PayDisini callback signature mismatch for ref ${refId}`);
    return null;
  }

  let amount: Decimal;
  try {
    amount = new Decimal(amountRaw);
  } catch {
    amount = new Decimal(0);
  }
  const status = (firstString(body.status) ?? "").toLowerCase();
  return {
    refId,
    trxId: firstString(body.unique_code, body.trx_id) ?? refId,
    amount,
    paid: PAID_STATES.includes(status),
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
