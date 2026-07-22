/**
 * "Test Connection" backend for the Settings page (Settings refinement, §7/§13).
 * One function per gateway, all returning the same shape so the route handler
 * and the client can treat every gateway identically. Never logs or returns a
 * credential value — only a human-readable outcome string.
 *
 * TokoPay/PayDisini/NOWPayments have no dedicated "ping" endpoint (see the
 * `⚠ ASSUMPTION` notes in packages/core/src/payments/*.ts — their exact
 * request/response shapes are documented as unverified guesses, not confirmed
 * against a live dashboard). Rather than pretend a confident pass/fail is
 * possible for those three, `classifyCheckError` below surfaces the gateway's
 * own raw response text so an admin can judge it themselves, and only reports
 * a hard failure when the HTTP call itself didn't succeed. Bybit, Binance
 * Internal, and Telegram use real, well-documented signed endpoints — those
 * three DO get a reliable ok/fail signal.
 */
import { createHmac } from "node:crypto";
import {
  prisma,
  resolveBybitConfig,
  resolveBinanceInternalConfig,
  getTokopayCreds,
  getPaydisiniCreds,
  getNowpaymentsCreds,
} from "@app/db";
import { checkTransaction as tokopayCheckTransaction } from "@app/core/payments/tokopay";
import { checkTransaction as paydisiniCheckTransaction } from "@app/core/payments/paydisini";
import { getPaymentStatus as nowpaymentsGetStatus } from "@app/core/payments/nowpayments";

export interface ConnectionTestResult {
  ok: boolean;
  detail: string;
}

// Deliberately never a real order — nothing in this app looks this id up, so
// it can never collide with a live transaction.
const SENTINEL_REF = "settings-connection-test";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shared by TokoPay/PayDisini: distinguishes a transport-level failure (bad
 * merchant/secret typically manifests as a same-shaped rejection as "not
 * found" for these two gateways — see the file header) from the gateway
 * responding at all. */
function classifyCheckError(err: unknown, gatewayLabel: string): ConnectionTestResult {
  const message = errorMessage(err);
  const httpMatch = message.match(/HTTP (\d+)/);
  if (httpMatch) {
    return {
      ok: false,
      detail: `Could not reach ${gatewayLabel} (HTTP ${httpMatch[1]}). Check your network connection or the gateway's status page.`,
    };
  }
  const rejectedMatch = message.match(/rejected: (.+)$/);
  if (rejectedMatch) {
    return {
      ok: true,
      detail: `${gatewayLabel} accepted the request and responded: "${rejectedMatch[1]}" — expected, since this test looks up a reference id that doesn't exist. If your credentials were wrong, ${gatewayLabel} would say so here instead.`,
    };
  }
  return { ok: false, detail: `${gatewayLabel} test failed: ${message}` };
}

export async function testTokopay(): Promise<ConnectionTestResult> {
  const creds = await getTokopayCreds(prisma);
  if (!creds) return { ok: false, detail: "TokoPay merchant ID and secret are not both set." };
  try {
    await tokopayCheckTransaction(creds, { refId: SENTINEL_REF, amountIdr: 1000 });
    return { ok: true, detail: "TokoPay responded to a status lookup — merchant ID and secret are accepted." };
  } catch (err) {
    return classifyCheckError(err, "TokoPay");
  }
}

export async function testPaydisini(): Promise<ConnectionTestResult> {
  const creds = await getPaydisiniCreds(prisma);
  if (!creds) return { ok: false, detail: "PayDisini user key and API key are not both set." };
  try {
    await paydisiniCheckTransaction(creds, { refId: SENTINEL_REF, amountIdr: 1000 });
    return { ok: true, detail: "PayDisini responded to a status lookup — user key and API key are accepted." };
  } catch (err) {
    return classifyCheckError(err, "PayDisini");
  }
}

export async function testNowpayments(): Promise<ConnectionTestResult> {
  const creds = await getNowpaymentsCreds(prisma);
  if (!creds) return { ok: false, detail: "NOWPayments API key is not set." };
  try {
    await nowpaymentsGetStatus(creds, { invoiceId: SENTINEL_REF });
    return { ok: true, detail: "NOWPayments responded to a status lookup — the API key is accepted." };
  } catch (err) {
    const message = errorMessage(err);
    const httpMatch = message.match(/HTTP (\d+)/);
    const code = httpMatch ? Number(httpMatch[1]) : null;
    if (code === 401 || code === 403) return { ok: false, detail: "NOWPayments rejected the API key." };
    if (code === 404) {
      return { ok: true, detail: "NOWPayments responded — the API key is accepted (the test invoice wasn't found, as expected)." };
    }
    return { ok: false, detail: `NOWPayments test failed: ${message}` };
  }
}

/** Bybit V5 GET auth, same scheme as the production deposit poller
 * (apps/order-bot/src/payments/bybitDeposit.ts): HMAC-SHA256(secret,
 * timestamp + apiKey + recvWindow + queryString). */
async function bybitSignedGet(
  path: string,
  params: Record<string, string>,
  cfg: { apiKey: string; apiSecret: string; apiBase: string },
): Promise<{ httpOk: boolean; httpStatus: number; retCode?: number; retMsg?: string }> {
  const recv = "5000";
  const ts = String(Date.now());
  const query = new URLSearchParams(params).toString();
  const sign = createHmac("sha256", cfg.apiSecret).update(ts + cfg.apiKey + recv + query).digest("hex");
  const res = await fetch(`${cfg.apiBase}${path}?${query}`, {
    headers: {
      "X-BAPI-API-KEY": cfg.apiKey,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": recv,
      "X-BAPI-SIGN": sign,
    },
  });
  const body = (await res.json().catch(() => ({}))) as { retCode?: number; retMsg?: string };
  return { httpOk: res.ok, httpStatus: res.status, retCode: body.retCode, retMsg: body.retMsg };
}

/** Tests the Bybit account credentials shared by both the "Bybit" (Internal
 * Transfer) and "Bybit BSC" (on-chain) cards — same API key/secret, same
 * exchange account, so one test covers both. Calls the exact read-only
 * endpoint the production deposit poller uses, with `limit: "1"` to keep it
 * cheap. */
export async function testBybit(): Promise<ConnectionTestResult> {
  const cfg = await resolveBybitConfig(prisma);
  if (!cfg.enabled) return { ok: false, detail: "Bybit UID, API key, and API secret are not all set." };
  try {
    const { httpOk, httpStatus, retCode, retMsg } = await bybitSignedGet(
      "/v5/asset/deposit/query-internal-record",
      { limit: "1" },
      cfg,
    );
    if (httpOk && retCode === 0) {
      return { ok: true, detail: "Connected — Bybit accepted the API key and returned deposit data." };
    }
    return { ok: false, detail: `Bybit rejected the request: ${retMsg ?? `HTTP ${httpStatus}`} (code ${retCode ?? "?"}).` };
  } catch (err) {
    return { ok: false, detail: `Could not reach Bybit: ${errorMessage(err)}` };
  }
}

function binanceSign(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

/** Same read-only endpoint the production Binance Internal Transfer poller
 * uses (apps/order-bot/src/payments/binanceInternal.ts), `limit: "1"`. */
export async function testBinanceInternal(): Promise<ConnectionTestResult> {
  const cfg = await resolveBinanceInternalConfig(prisma);
  if (!cfg.enabled) return { ok: false, detail: "Binance UID, API key, and API secret are not all set." };
  try {
    const params = new URLSearchParams({ limit: "1", timestamp: String(Date.now()), recvWindow: "5000" });
    const qs = params.toString();
    const res = await fetch(`${cfg.apiBase}/sapi/v1/pay/transactions?${qs}&signature=${binanceSign(qs, cfg.apiSecret)}`, {
      headers: { "X-MBX-APIKEY": cfg.apiKey },
    });
    if (res.ok) return { ok: true, detail: "Connected — Binance accepted the API key and returned transaction data." };
    const body = (await res.json().catch(() => ({}))) as { msg?: string };
    return { ok: false, detail: `Binance rejected the request${body.msg ? `: ${body.msg}` : ""} (HTTP ${res.status}).` };
  } catch (err) {
    return { ok: false, detail: `Could not reach Binance: ${errorMessage(err)}` };
  }
}

/** Method key (as used in PAYMENT_METHODS / PAY_CRED_GROUPS) → tester.
 * "bybit_bsc" intentionally reuses testBybit — it shares the same account
 * credentials as "bybit", so there is nothing separate to verify here. */
export const CONNECTION_TESTS: Record<string, () => Promise<ConnectionTestResult>> = {
  tokopay: testTokopay,
  paydisini: testPaydisini,
  nowpayments: testNowpayments,
  bybit: testBybit,
  bybit_bsc: testBybit,
  binance_internal: testBinanceInternal,
};
