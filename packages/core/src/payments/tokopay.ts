/**
 * TokoPay gateway client (HTTP + signature) — shared by the storefront pay page,
 * its webhook route, and the bot's QRIS checkout. Pure: no @app/db dependency
 * (credential resolution lives in @app/db `getTokopayCreds`). See DOCS.md §15.5.
 *
 * ⚠ ASSUMPTION (flagged): the endpoint shape + callback signature
 *   md5("merchantId:secret:refId") follow TokoPay's public docs. Verify against
 *   the live dashboard before go-live.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Decimal } from "../money";
import { logger } from "../logger";

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

export interface TokopayOrderInfo {
  trxId: string;
  payUrl: string | null;
  qrLink: string | null;
  qrString: string | null;
  totalBayar: string | null;
}

/**
 * GET a TokoPay endpoint whose query string carries `merchant`/`secret`, and
 * return its parsed JSON body. TokoPay's API (per its public docs, flagged
 * ASSUMPTION above) only accepts these credentials via query string — there's
 * no header/POST-body alternative to switch to. Given that, every failure
 * mode of the raw `fetch()` call is caught HERE, inside this single choke
 * point, and rethrown as a new `Error` built from a static, credential-free
 * string:
 *   - `fetch()` itself can reject (DNS failure, connection refused, aborted,
 *     TLS error, …) before a `Response` even exists. Node's `fetch` some­times
 *     attaches the failed request to `err.cause`, which a naive `logger.error({
 *     err })` downstream (or an *unhandled rejection* if a caller forgets to
 *     `.catch()`) would serialize whole — echoing the secret straight back
 *     into logs. Catching it here and throwing a fresh, static-message Error
 *     means nothing downstream ever sees the original object.
 *   - `res.json()` can throw on a malformed body; same treatment.
 * The existing `!res.ok` branch keeps its own static-message throw (no
 * change in behavior), just relocated into this shared helper so both
 * `createTransaction` and `checkTransaction` get the same guarantee.
 */
async function fetchTokopayJson(url: string, errorPrefix: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(`${errorPrefix} network error`); // never log the query — it carries the secret
  }
  if (!res.ok) {
    throw new Error(`${errorPrefix} HTTP ${res.status}`); // never log the query — it carries the secret
  }
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`${errorPrefix} returned an unparseable response`); // never log the query — it carries the secret
  }
}

/** QRIS admin-fee constants — TokoPay only; PayDisini and every other gateway
 * stay fee-free. Charged ON TOP of the order total. */
export const QRIS_ADMIN_FEE_FLAT = new Decimal(100);
export const QRIS_ADMIN_FEE_PERCENT = new Decimal("0.007"); // 0.70%

/**
 * Rp100 + 0.70% of the amount TokoPay actually receives as `nominal`
 * (createTransaction/checkTransaction always pass `order.totalAmount` — net of
 * bulk discount / voucher / wallet credit — never the pre-discount subtotal),
 * rounded to the nearest whole Rupiah (IDR has no fractional currency in this
 * codebase). The ONE place this formula is computed — every caller (bot
 * checkout, storefront checkout/pay, webhook, reconcile poller, overpayment
 * check) must import this rather than re-deriving it inline.
 *
 * ⚠ Must be called with the SAME amount passed to createTransaction/
 *   checkTransaction as `nominal` (i.e. `order.totalAmount`) — TokoPay computes
 *   its own fee on top of that nominal, so basing this on any other figure
 *   (e.g. the pre-discount subtotal) desyncs the fee we expect from the fee
 *   TokoPay actually charges and makes every discounted order look short-paid
 *   (H-1, backend audit 2026-07-31).
 */
export function computeQrisAdminFee(amountIdr: Decimal.Value): Decimal {
  return QRIS_ADMIN_FEE_FLAT
    .plus(new Decimal(amountIdr).times(QRIS_ADMIN_FEE_PERCENT))
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/** totalAmount (already net of discounts/wallet) + the QRIS admin fee — the
 * fee-inclusive amount expected to be paid by the buyer and verified on confirm.
 * (Note: createTransaction/checkTransaction are passed the base totalAmount,
 * as TokoPay automatically computes and adds its admin fee on top of nominal). */
export function qrisChargeAmount(totalAmount: Decimal.Value): Decimal {
  return new Decimal(totalAmount).plus(computeQrisAdminFee(totalAmount));
}

/** Create (or fetch — ref_id is idempotent) the gateway transaction for an order. */
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
  const body = (await fetchTokopayJson(`${API_BASE}/v1/order?${params.toString()}`, "TokoPay order")) as {
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

export interface TokopayStatus {
  paid: boolean;
  amount: Decimal;
  trxId: string | null;
}

/** Gateway payment-status strings we treat as "paid/settled". */
const PAID_STATES = ["paid", "success", "completed", "settlement", "lunas", "berhasil"];

/**
 * Poll the gateway for an order's current payment status (reconcile path — used
 * by the bot's TokoPay poller when the webhook hasn't arrived). Re-hits the
 * idempotent `/v1/order` endpoint with the same `ref_id`; a repeat call returns
 * the existing transaction's status rather than creating a new one.
 *
 * ⚠ ASSUMPTION (flagged, same as the rest of this client): the status field on
 *   the `/v1/order` response (`data.status`) follows TokoPay's public docs.
 *   Verify against the live dashboard before go-live.
 */
export async function checkTransaction(
  creds: TokopayCreds,
  args: { refId: string; amountIdr: Decimal.Value },
): Promise<TokopayStatus> {
  const params = new URLSearchParams({
    merchant: creds.merchantId,
    secret: creds.secret,
    ref_id: args.refId,
    nominal: new Decimal(args.amountIdr).toFixed(0),
    metode: creds.channel,
  });
  const body = (await fetchTokopayJson(`${API_BASE}/v1/order?${params.toString()}`, "TokoPay status")) as {
    status?: unknown;
    data?: Record<string, unknown>;
    error_msg?: unknown;
  };
  const ok = String(body.status ?? "").toLowerCase() === "success" || body.status === 200;
  if (!ok || !body.data) {
    throw new Error(`TokoPay status rejected: ${String(body.error_msg ?? body.status ?? "unknown")}`);
  }
  const d = body.data;
  const statusStr = String(d.status ?? "").toLowerCase();
  const amountRaw = d.total_bayar ?? d.nominal ?? d.amount ?? args.amountIdr;
  let amount: Decimal;
  try {
    amount = new Decimal(String(amountRaw));
  } catch {
    amount = new Decimal(args.amountIdr);
  }
  const trxId = (typeof d.trx_id === "string" && d.trx_id) || (typeof d.reference === "string" && d.reference) || null;
  return { paid: PAID_STATES.includes(statusStr), amount, trxId };
}

export interface TokopayCallback {
  refId: string;
  trxId: string;
  amount: Decimal;
  paid: boolean;
}

/** Verify a callback's signature + normalize. Returns null on bad/missing signature. */
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
    logger.warn(`TokoPay callback signature mismatch for reference ${refId} — rejecting the callback as unverified`);
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
