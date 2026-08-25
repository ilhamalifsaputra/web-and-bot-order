/**
 * NOWPayments gateway client (HTTP + signature) — shared by the storefront pay
 * page, its webhook route, and the bot's USDT checkout. Pure: no @app/db
 * dependency (credential resolution lives in @app/db `getNowpaymentsCreds`).
 * See DOCS.md §15.5.
 *
 * NOWPayments' public API docs (https://documenter.getpostman.com/view/7907941/...)
 * are comparatively well documented, so the IPN signature scheme — HMAC-SHA512
 * over the request body, delivered via the `x-nowpayments-sig` header (not a
 * TokoPay/PayDisini-style field-concatenation hash) — is solid and not a guess.
 *
 * `verifyIpn` HMACs the RAW request body bytes (Task 2a fix), not a
 * re-serialization of the parsed JSON. It used to compute
 * `JSON.stringify(sortKeysDeep(parsedBody))` instead — that only worked
 * because key-sorting happened to neutralize field-ordering differences, but
 * any other byte-level divergence between NOWPayments' original JSON and
 * Node's `JSON.stringify` (e.g. numeric formatting: `1.50` vs `1.5`,
 * trailing zeros, float-to-string conversion) would silently break every
 * IPN's signature. Hashing the exact bytes NOWPayments sent sidesteps that
 * class of bug entirely — see apps/storefront/src/routes/checkout.ts, whose
 * NOWPayments webhook route captures those bytes via a scoped
 * `addContentTypeParser` before Fastify's JSON parser runs.
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
import { fetchWithTimeoutSafe, HTTP_TIMEOUT_MS } from "../http";
import { isProviderPaid, StatusProvider } from "./paymentStatus";

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

/**
 * Create a hosted invoice for an order. Never log the request body or the
 * api-key header. `fetch()` goes through `fetchWithTimeoutSafe`
 * (`@app/core/http`), not a bare call, because Node's fetch sometimes
 * attaches the failed request — headers included, one of which carries the
 * api-key credential — to a rejected error's `.cause`. `fetchWithTimeoutSafe`
 * catches any rejection (a genuine network failure or the `timeoutMs`
 * deadline elapsing) and rethrows a fresh, static, credential-free Error
 * before the original can escape, so a naive `logger.error({ err })`
 * downstream never sees the header. It also bounds the call so a gateway
 * that accepts the connection and never answers (or stalls the body) can't
 * stall checkout.
 */
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
  const res = await fetchWithTimeoutSafe(
    `${API_BASE}/v1/invoice`,
    {
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
      timeoutMs: HTTP_TIMEOUT_MS.gatewayWrite, // a human is waiting at checkout for this to resolve
    },
    "NOWPayments invoice request", // never log err — it may carry the api-key header
  );
  if (!res.ok) {
    throw new Error(`NOWPayments invoice HTTP ${res.status}`); // never log the body — header carries the api key
  }
  let body: { id?: unknown; invoice_url?: unknown };
  try {
    body = (await res.json()) as { id?: unknown; invoice_url?: unknown };
  } catch (err) {
    // AbortSignal.timeout stays attached to the response body in undici, so a
    // peer that sends headers and then stalls the body makes res.json()
    // reject with this same TimeoutError shape (http.ts) — distinguish that
    // from a genuinely malformed body so the caller isn't told the gateway
    // sent garbage when it actually just hung.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("NOWPayments invoice response body read timed out"); // never log the body — header carries the api key
    }
    throw new Error("NOWPayments invoice response is unparseable"); // never log the body — header carries the api key
  }
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
  const res = await fetchWithTimeoutSafe(
    `${API_BASE}/v1/invoice/${encodeURIComponent(args.invoiceId)}`,
    {
      headers: { "x-api-key": creds.apiKey },
      timeoutMs: HTTP_TIMEOUT_MS.gatewayRead, // reconcile poller — the next tick retries if this is slow
    },
    "NOWPayments status request", // never log err — it may carry the api-key header
  );
  if (!res.ok) {
    throw new Error(`NOWPayments status HTTP ${res.status}`);
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    // AbortSignal.timeout stays attached to the response body in undici, so a
    // peer that sends headers and then stalls the body makes res.json()
    // reject with this same TimeoutError shape (http.ts) — distinguish that
    // from a genuinely malformed body so the caller isn't told the gateway
    // sent garbage when it actually just hung.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("NOWPayments status response body read timed out");
    }
    throw new Error("NOWPayments status response is unparseable");
  }
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
  return { paid: isProviderPaid(StatusProvider.NOWPAYMENTS, statusStr), amount, trxId, status: statusStr };
}

export interface NowpaymentsIpn {
  orderId: string;
  trxId: string;
  amount: Decimal;
  paid: boolean;
  status: string;
}

/**
 * Replay window (Task 2b): reject an IPN whose own `updated_at`/`created_at`
 * timestamp is older than this. NOWPayments' payment-status object — which
 * the IPN body mirrors ("the body of the IPN request is similar to a get
 * payment status response body", per NOWPayments' own help-center docs) —
 * carries both fields as ISO-8601 strings (e.g. `"2019-04-18T13:39:27.982Z"`);
 * corroborated independently by the `go-nowpayments` SDK's `Payment`/
 * `PaymentStatus` structs, which map `json:"created_at"` / `json:"updated_at"`
 * straight through with no transformation, and by a public NOWPayments IPN
 * mock payload carrying the same two fields. `updated_at` is preferred over
 * `created_at`: it advances on every status transition (waiting → confirming
 * → finished, …), so it reflects when THIS report was generated, not just
 * when the invoice was first opened — the same role `auth_date` plays in
 * `apps/storefront/src/auth.ts`'s Telegram-login replay guard
 * (`TG_AUTH_MAX_AGE_SECONDS`), which this window is modeled on.
 *
 * ⚠ ASSUMPTION (flagged, same posture as the rest of this file): the exact
 *   field presence is corroborated via a third-party SDK and a community
 *   mock payload, not NOWPayments' own dashboard/docs page (blocked from
 *   direct fetch at write time). If a genuine IPN body is ever missing both
 *   fields, `verifyIpn` does NOT reject on that alone (see below) — only a
 *   PRESENT-but-stale timestamp is treated as a replay.
 */
export const NOWPAYMENTS_IPN_MAX_AGE_MS = 5 * 60_000;

/**
 * Verify an IPN webhook's `x-nowpayments-sig` header + normalize the body.
 * Returns null on a missing/invalid signature, or on a signature-valid body
 * that's missing/malformed `payment_id` (M-12, backend audit 2026-07-31): a
 * blank `trxId` would otherwise become the UNIQUE key in the idempotency
 * ledger, and every subsequent broken IPN would then be silently answered
 * "already_processed" against that poisoned `""` row — a genuinely-paid
 * order would never be delivered or flagged. Rejecting here (same null
 * contract as a bad signature) means the callback is never processed and
 * never touches the ledger.
 *
 * The reconcile poller (apps/order-bot/src/payments/nowpaymentsReconcile.ts)
 * now applies this same rule to `getPaymentStatus`'s answer: it declines to
 * deliver a `finished` payment that carries no id instead of inventing one.
 * That keeps `ProcessedNowpaymentsTx.trxId` — this rail's UNIQUE idempotency
 * gate — always holding the gateway's own `payment_id`, whichever of the two
 * paths claimed it, so the poller and the webhook can never write two rows
 * for one payment.
 *
 * Signature scheme (well documented publicly, not a guess): HMAC-SHA512 over
 * the RAW request body bytes, keyed with the merchant's IPN secret — see the
 * Task 2a fix note in this file's top doc comment for why this is the raw
 * body and not a re-serialization of the parsed JSON.
 *
 * `rawBody` MUST be the exact bytes NOWPayments sent (captured before any
 * JSON parsing/re-serialization touches them) — the caller is responsible
 * for that capture (checkout.ts's scoped `addContentTypeParser`). `body` is
 * the already-parsed form of that SAME payload, used only to read out the
 * normalized fields below once the signature over `rawBody` has checked out.
 *
 * Replay window (Task 2b): once the signature is verified — so a forged
 * timestamp can't slip past without also forging a valid HMAC over the whole
 * raw body — `body.updated_at` (falling back to `body.created_at`) is
 * checked against `now`. A body captured off the wire and replayed later
 * (e.g. a MITM'd proxy, a leaked request log) carries its ORIGINAL
 * timestamp, so replaying it past `NOWPAYMENTS_IPN_MAX_AGE_MS` is rejected
 * here, same as a bad signature. A body with neither field, or with a value
 * that doesn't parse as a date, does NOT fail this check on its own — see
 * the ⚠ ASSUMPTION above `NOWPAYMENTS_IPN_MAX_AGE_MS` for why: this rail's
 * `ProcessedNowpaymentsTx` idempotency ledger (UNIQUE `trxId`) is always the
 * backstop replay defense regardless of whether a usable timestamp was
 * present on any given call, exactly like TokoPay/PayDisini (which never
 * carry one at all — see the doc comments on their `verifyCallback`).
 * `now` is a parameter (defaulting to `Date.now()`) purely so tests can pin
 * it instead of racing the wall clock.
 */
export function verifyIpn(
  rawBody: string,
  body: Record<string, unknown>,
  signatureHeader: string | undefined,
  creds: Pick<NowpaymentsCreds, "ipnSecret">,
  now: number = Date.now(),
): NowpaymentsIpn | null {
  if (!signatureHeader) return null;

  const expected = createHmac("sha512", creds.ipnSecret).update(rawBody).digest("hex");
  if (!constantTimeEqual(expected, signatureHeader.toLowerCase())) {
    logger.warn("NOWPayments IPN (Instant Payment Notification) webhook signature mismatch — rejecting the callback as unverified");
    return null;
  }

  const tsRaw = body.updated_at ?? body.created_at;
  if (typeof tsRaw === "string" && tsRaw) {
    const tsMs = Date.parse(tsRaw);
    if (Number.isFinite(tsMs) && now - tsMs > NOWPAYMENTS_IPN_MAX_AGE_MS) {
      logger.warn(
        { order_id: body.order_id, payment_id: body.payment_id, ipn_timestamp: tsRaw },
        "NOWPayments IPN signature is valid but its own timestamp is older than the 5-minute replay window — rejecting the callback as a likely replay",
      );
      return null;
    }
  }

  if (
    (typeof body.payment_id !== "string" && typeof body.payment_id !== "number") ||
    body.payment_id === ""
  ) {
    logger.warn("NOWPayments IPN is missing a usable payment_id — rejecting the callback instead of treating it as a valid (empty) idempotency key");
    return null;
  }
  const trxId = String(body.payment_id);
  const orderId = typeof body.order_id === "string" ? body.order_id : String(body.order_id ?? "");
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
 * inside arrays.
 *
 * NOT used internally by `verifyIpn` anymore (Task 2a fix — `verifyIpn` now
 * HMACs the raw request body bytes directly, never a re-serialization of the
 * parsed JSON). Kept exported as a standalone utility: it's still a correct,
 * independently-testable canonical-JSON sorter, and old tests/fixtures that
 * reasoned about NOWPayments' documented "sort keys, then stringify" scheme
 * can still exercise it directly without duplicating the logic by hand.
 *
 * - Plain objects: keys sorted via `Object.keys(...).sort()` (default
 *   lexicographic/UTF-16 code-unit ordering), each value recursively sorted.
 * - Arrays: element order is preserved (arrays are NOT sorted by value), but
 *   each element is recursively processed so any objects nested inside arrays
 *   also get their keys sorted.
 * - Everything else (string, number, boolean, null, undefined) is returned
 *   unchanged.
 */
export function sortKeysDeep(obj: unknown): unknown {
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
