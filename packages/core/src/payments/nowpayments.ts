/**
 * NOWPayments gateway client (HTTP + signature) — shared by the storefront pay
 * page, its webhook route, and the bot's USDT checkout. Pure: no @app/db
 * dependency (credential resolution lives in @app/db `getNowpaymentsCreds`).
 * See DOCS.md §15.5.
 *
 * NOWPayments' public API docs (https://documenter.getpostman.com/view/7907941/...)
 * are comparatively well documented, so the IPN signature scheme below — HMAC-SHA512
 * over the JSON-stringified request body with keys sorted **recursively, alphabetically**
 * (not a TokoPay/PayDisini-style field-concatenation hash), delivered via the
 * `x-nowpayments-sig` header — is solid and not a guess.
 *
 * ⚠ ASSUMPTION (flagged, narrower than the PayDisini client): the exact
 *   `pay_currency` slug format (e.g. `"usdttrc20"` vs `"usdt"`) and the precise
 *   status-check endpoint path (`GET /v1/invoice/{id}` vs a dedicated
 *   `/v1/payment/{id}` endpoint) are NOT verified against a live merchant
 *   dashboard. Verify both against the live NOWPayments docs/dashboard before
 *   go-live.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Decimal } from "../money";
import { logger } from "../logger";

export const NOWPAYMENTS_API_KEY_KEY = "nowpayments_api_key";
export const NOWPAYMENTS_IPN_SECRET_KEY = "nowpayments_ipn_secret";
export const NOWPAYMENTS_ENABLED_KEY = "nowpayments_enabled";
export const NOWPAYMENTS_PAY_CURRENCY_KEY = "nowpayments_pay_currency";

const API_BASE = process.env.NOWPAYMENTS_API_BASE ?? "https://api.nowpayments.io";

export interface NowpaymentsCreds {
  apiKey: string;
  ipnSecret: string;
  payCurrency: string;
}

export interface NowpaymentsInvoice {
  invoiceId: string;
  invoiceUrl: string;
}

/** Create a hosted invoice for an order. Never log the request body or the api-key header. */
export async function createInvoice(
  creds: NowpaymentsCreds,
  args: {
    orderId: string;
    amountUsd: Decimal.Value;
    ipnCallbackUrl: string;
    successUrl?: string;
    cancelUrl?: string;
  },
): Promise<NowpaymentsInvoice> {
  const res = await fetch(`${API_BASE}/v1/invoice`, {
    method: "POST",
    headers: {
      "x-api-key": creds.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      price_amount: new Decimal(args.amountUsd).toFixed(2),
      price_currency: "usd",
      pay_currency: creds.payCurrency,
      order_id: args.orderId,
      ipn_callback_url: args.ipnCallbackUrl,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    }),
  });
  if (!res.ok) {
    throw new Error(`NOWPayments invoice HTTP ${res.status}`); // never log the body — header carries the api key
  }
  const body = (await res.json()) as { id?: unknown; invoice_url?: unknown };
  if (typeof body.id !== "string" && typeof body.id !== "number") {
    throw new Error("NOWPayments invoice response missing id");
  }
  if (typeof body.invoice_url !== "string" || !body.invoice_url) {
    throw new Error("NOWPayments invoice response missing invoice_url");
  }
  return { invoiceId: String(body.id), invoiceUrl: body.invoice_url };
}

export interface NowpaymentsStatus {
  paid: boolean;
  amount: Decimal;
  trxId: string | null;
  status: string;
}

/**
 * Poll the gateway for an invoice's current payment status (reconcile path —
 * used by the bot's NOWPayments poller when the IPN webhook hasn't arrived).
 *
 * ⚠ ASSUMPTION (flagged): the exact status-check endpoint path
 *   (`GET /v1/invoice/{invoiceId}`) is not verified against the live
 *   dashboard — NOWPayments may expose a dedicated `/v1/payment/{id}` status
 *   endpoint instead. Verify before go-live.
 */
export async function getPaymentStatus(
  creds: NowpaymentsCreds,
  args: { invoiceId: string },
): Promise<NowpaymentsStatus> {
  const res = await fetch(`${API_BASE}/v1/invoice/${encodeURIComponent(args.invoiceId)}`, {
    headers: { "x-api-key": creds.apiKey },
  });
  if (!res.ok) {
    throw new Error(`NOWPayments status HTTP ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const statusStr = String(body.payment_status ?? "").toLowerCase();
  const amountRaw = body.actually_paid ?? body.pay_amount ?? 0;
  let amount: Decimal;
  try {
    amount = new Decimal(String(amountRaw));
  } catch {
    amount = new Decimal(0);
  }
  const trxId =
    (typeof body.payment_id === "string" && body.payment_id) ||
    (typeof body.payment_id === "number" && String(body.payment_id)) ||
    null;
  return { paid: statusStr === "finished", amount, trxId, status: statusStr };
}

export interface NowpaymentsIpn {
  orderId: string;
  trxId: string;
  amount: Decimal;
  paid: boolean;
  status: string;
}

/**
 * Verify an IPN webhook's `x-nowpayments-sig` header + normalize the body.
 * Returns null on a missing/invalid signature.
 *
 * Signature scheme (well documented publicly, not a guess): HMAC-SHA512 over
 * `JSON.stringify` of the body with its keys sorted **recursively, alphabetically**
 * (nested objects too — see `sortKeysDeep`), keyed with the merchant's IPN secret.
 */
export function verifyIpn(
  body: Record<string, unknown>,
  signatureHeader: string | undefined,
  creds: Pick<NowpaymentsCreds, "ipnSecret">,
): NowpaymentsIpn | null {
  if (!signatureHeader) return null;

  const sorted = JSON.stringify(sortKeysDeep(body));
  const expected = createHmac("sha512", creds.ipnSecret).update(sorted).digest("hex");
  if (!constantTimeEqual(expected, signatureHeader.toLowerCase())) {
    logger.warn("NOWPayments IPN signature mismatch");
    return null;
  }

  const orderId = typeof body.order_id === "string" ? body.order_id : String(body.order_id ?? "");
  const trxId =
    typeof body.payment_id === "string" || typeof body.payment_id === "number" ? String(body.payment_id) : "";
  const amountRaw = body.actually_paid ?? body.pay_amount ?? 0;
  let amount: Decimal;
  try {
    amount = new Decimal(String(amountRaw));
  } catch {
    amount = new Decimal(0);
  }
  const status = String(body.payment_status ?? "").toLowerCase();
  return {
    orderId,
    trxId,
    amount,
    paid: status === "finished",
    status,
  };
}

/**
 * Recursively sort an object's keys alphabetically (including nested objects),
 * preserving array element order while still sorting keys of any objects found
 * inside arrays. This MUST exactly match the key order NOWPayments uses on
 * their side when computing the IPN signature — a subtly wrong sort here will
 * silently break every webhook's signature verification.
 *
 * - Plain objects: keys sorted via `Object.keys(...).sort()` (default
 *   lexicographic/UTF-16 code-unit ordering), each value recursively sorted.
 * - Arrays: element order is preserved (arrays are NOT sorted by value), but
 *   each element is recursively processed so any objects nested inside arrays
 *   also get their keys sorted.
 * - Everything else (string, number, boolean, null, undefined) is returned
 *   unchanged.
 */
function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => sortKeysDeep(item));
  }
  if (obj !== null && typeof obj === "object") {
    const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return result;
  }
  return obj;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
