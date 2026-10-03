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
import { fetchWithTimeoutSafe, HTTP_TIMEOUT_MS } from "../http";
import { isProviderPaid, StatusProvider } from "./paymentStatus";

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
 * Thrown instead of a plain `Error` when TokoPay answers HTTP 429 — lets the
 * bot's reconcile poller (apps/order-bot/src/payments/tokopayReconcile.ts)
 * tell a rate-limit apart from any other failure and back off
 * (`pollBackoff.ts`) instead of retrying at the flat poll interval. Same
 * message text as the generic non-OK branch, and still an `Error`, so every
 * other caller (checkout's `createTransaction`) sees no difference.
 */
export class RateLimitedError extends Error {}

/**
 * GET a TokoPay endpoint whose query string carries `merchant`/`secret`, and
 * return its parsed JSON body. TokoPay's API (per its public docs, flagged
 * ASSUMPTION above) only accepts these credentials via query string — there's
 * no header/POST-body alternative to switch to. Given that, every failure
 * mode of the raw `fetch()` call is caught HERE, inside this single choke
 * point, via `fetchWithTimeoutSafe` (`@app/core/http`): it rethrows a new
 * `Error` built from a static, credential-free string, whether `fetch()`
 * itself rejected (DNS failure, connection refused, aborted, TLS error, …:
 * Node's `fetch` some­times attaches the failed request to `err.cause`, which
 * a naive `logger.error({ err })` downstream — or an *unhandled rejection* if
 * a caller forgets to `.catch()` — would serialize whole, echoing the secret
 * straight back into logs) or the deadline (`timeoutMs` /
 * `HTTP_TIMEOUT_MS`) elapsed first, distinguished only by "timed out" vs.
 * "network error" in the message so a stuck gateway is diagnosable without
 * ever touching the query string. `res.json()` gets the same static-message
 * treatment below on a malformed body. The existing `!res.ok` branch keeps
 * its own static-message throw (no change in behavior). Both
 * `createTransaction` and `checkTransaction` share this one guarantee.
 */
async function fetchTokopayJson(url: string, errorPrefix: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeoutSafe(url, { timeoutMs }, errorPrefix); // never log the query — it carries the secret
  if (res.status === 429) {
    throw new RateLimitedError(`${errorPrefix} HTTP ${res.status}`); // never log the query — it carries the secret
  }
  if (!res.ok) {
    throw new Error(`${errorPrefix} HTTP ${res.status}`); // never log the query — it carries the secret
  }
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    // AbortSignal.timeout stays attached to the response body in undici, so a
    // peer that sends headers and then stalls the body makes res.json()
    // reject with this same TimeoutError shape (http.ts) — distinguish that
    // from a genuinely malformed body so the caller isn't told the gateway
    // sent garbage when it actually just hung.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`${errorPrefix} response body read timed out`); // never log the query — it carries the secret
    }
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
  const body = (await fetchTokopayJson(
    `${API_BASE}/v1/order?${params.toString()}`,
    "TokoPay order",
    HTTP_TIMEOUT_MS.gatewayWrite, // a human is waiting at checkout for this to resolve
  )) as {
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

// Which status strings count as "paid/settled" is decided by
// `isProviderPaid(StatusProvider.TOKOPAY, …)` (./paymentStatus.ts, Task E7),
// not by a list in this file. BOTH ways a TokoPay payment can reach us go
// through it — the reconcile poller's `checkTransaction` below and the
// storefront webhook's `verifyCallback` further down. `verifyCallback` used
// to carry its own shorter inline copy without `lunas`/`berhasil`, so a
// transaction TokoPay reported in Indonesian was honoured by the poller and
// rejected by the webhook: the same payment settled or not depending purely
// on which path saw it first. Do not re-inline either copy.

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
  const body = (await fetchTokopayJson(
    `${API_BASE}/v1/order?${params.toString()}`,
    "TokoPay status",
    HTTP_TIMEOUT_MS.gatewayRead, // reconcile poller — the next tick retries if this is slow
  )) as {
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
  const trxId = (typeof d.trx_id === "string" && d.trx_id) || (typeof d.reference === "string" && d.reference) || null;
  const paid = isProviderPaid(StatusProvider.TOKOPAY, statusStr);
  // Task B3c (backend audit): the amount must come from TokoPay, and the
  // fee-inclusive `total_bayar` (what the buyer actually paid) is read first.
  // This used to fall back to `args.amountIdr` — the bare order total we asked
  // about, which is BELOW the fee-inclusive charge callers compare against —
  // so a genuine payment was flagged short-paid and parked as unmatched. A
  // paid status without a usable amount is reported as NOT paid instead:
  // nothing is delivered on it and the reconcile poller asks again.
  const amountRaw = d.total_bayar ?? d.nominal ?? d.amount;
  let amount: Decimal | null = null;
  if (amountRaw !== undefined && amountRaw !== null && amountRaw !== "") {
    try {
      const parsed = new Decimal(String(amountRaw));
      if (parsed.isFinite()) amount = parsed;
    } catch {
      amount = null;
    }
  }
  if (amount === null) {
    if (paid) {
      logger.warn(
        `TokoPay reported order ${args.refId} as paid but its status response carried no usable amount, so the payment is treated as unverified and nothing is delivered on it — the reconcile poller will ask again, and if this persists an admin should check the transaction in the TokoPay dashboard`,
      );
    }
    return { paid: false, amount: new Decimal(0), trxId };
  }
  return { paid, amount, trxId };
}

export interface TokopayCallback {
  refId: string;
  trxId: string;
  amount: Decimal;
  paid: boolean;
}

/**
 * Verify a callback's signature + normalize. Returns null on bad/missing
 * signature. `paid` is decided by `isProviderPaid` (./paymentStatus.ts) — the
 * same list `checkTransaction` uses — so the webhook and the reconcile poller
 * can never disagree about whether a given gateway status string means the
 * money arrived.
 *
 * No replay-window check here (Task 2b): TokoPay's callback body carries no
 * timestamp field at all — the signature itself is `md5(merchantId:secret:
 * refId)` (see the ⚠ ASSUMPTION at the top of this file), a fixed function of
 * three values that never change for a given transaction, and neither
 * TokoPay's public docs nor the fields this client already reads off the
 * body (`ref_id`/`reff_id`/`reference`, `nominal`/`amount`/`total_bayar`,
 * `status`, `trx_id`) include a send-time or event-time value to check
 * `now` against. Inventing one from data TokoPay never sent (e.g. the
 * request's own arrival time at OUR server) would not be a replay defense —
 * it would just restate when the request happened, which a replayed request
 * trivially "passes" too. The real replay defense for this rail is
 * `ProcessedTokopayTx` (UNIQUE `trxId`, populated via `gatewayLedgerTrxId` in
 * apps/storefront/src/routes/checkout.ts): a replayed callback for an
 * already-delivered order hits that UNIQUE constraint and is turned away
 * before any second delivery, regardless of how stale the replayed body is.
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
    // The reference is NOT logged (Task B3e): with the signature failed it is
    // attacker-controlled bytes — newlines could forge log lines.
    logger.warn(
      `Rejected a TokoPay callback whose signature did not match its ${refId.length}-character reference — the reference is not logged because it is unverified input`,
    );
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
    paid: isProviderPaid(StatusProvider.TOKOPAY, status),
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
