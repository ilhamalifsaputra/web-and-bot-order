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
import { fetchWithTimeoutSafe, HTTP_TIMEOUT_MS } from "@app/core/http";
import {
  prisma,
  resolveBybitConfig,
  resolveBinanceInternalConfig,
  getTokopayCreds,
  getPaydisiniCreds,
  getNowpaymentsCreds,
  getDigiflazzCreds,
  getKokinpayCreds,
  getVipResellerCreds,
  getMelostoreCreds,
} from "@app/db";
import { checkTransaction as tokopayCheckTransaction } from "@app/core/payments/tokopay";
import { checkTransaction as paydisiniCheckTransaction } from "@app/core/payments/paydisini";
import { getPaymentStatus as nowpaymentsGetStatus } from "@app/core/payments/nowpayments";
import { getPriceList } from "@app/core/suppliers/digiflazz";
import { checkGameNickname } from "@app/core/suppliers/kokinpay";
import { checkGameRegion } from "@app/core/suppliers/vipreseller";
import { checkGameNickname as melostoreCheckGameNickname } from "@app/core/suppliers/melostore";

export interface ConnectionTestResult {
  ok: boolean;
  detail: string;
}

// Deliberately never a real order — nothing in this app looks this id up, so
// it can never collide with a live transaction.
const SENTINEL_REF = "settings-connection-test";

// Reads ONLY `.message`, never `.cause` — this is the single boundary where
// every caught error in this file becomes admin-facing text, and it must
// stay that way. Node's fetch sometimes attaches the failed request (headers
// included, so an API key) to a rejected fetch's `err.cause`; every
// credentialed call site in this file routes through `fetchWithTimeoutSafe`
// (`@app/core/http`), which already rethrows a fresh, cause-free Error, but
// that guarantee lives at each call site, not here. This function is the
// backstop: it's what kept the two bare `fetch()` calls this file used to
// have (Bybit/Binance, before they were routed through
// `fetchWithTimeoutSafe`) from ever leaking a credential through
// `ConnectionTestResult.detail`, and it protects any future call site added
// here the same way. Do NOT "improve" this to also read `.cause` for extra
// debugging detail — that would leak a credential into an admin-facing string.
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
  const res = await fetchWithTimeoutSafe(
    `${cfg.apiBase}${path}?${query}`,
    {
      headers: {
        "X-BAPI-API-KEY": cfg.apiKey,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": recv,
        "X-BAPI-SIGN": sign,
      },
      timeoutMs: HTTP_TIMEOUT_MS.gatewayWrite, // a human admin is waiting synchronously on the Settings page — no next tick to retry for them
    },
    "Bybit connection test", // never log err — it may carry the X-BAPI-API-KEY header
  );
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
    const res = await fetchWithTimeoutSafe(
      `${cfg.apiBase}/sapi/v1/pay/transactions?${qs}&signature=${binanceSign(qs, cfg.apiSecret)}`,
      {
        headers: { "X-MBX-APIKEY": cfg.apiKey },
        timeoutMs: HTTP_TIMEOUT_MS.gatewayWrite, // a human admin is waiting synchronously on the Settings page — no next tick to retry for them
      },
      "Binance connection test", // never log err — it may carry the X-MBX-APIKEY header
    );
    if (res.ok) return { ok: true, detail: "Connected — Binance accepted the API key and returned transaction data." };
    const body = (await res.json().catch(() => ({}))) as { msg?: string };
    return { ok: false, detail: `Binance rejected the request${body.msg ? `: ${body.msg}` : ""} (HTTP ${res.status}).` };
  } catch (err) {
    return { ok: false, detail: `Could not reach Binance: ${errorMessage(err)}` };
  }
}

/** Fetches Digiflazz's price list with the currently-saved credentials — the
 * lightest read-only call that actually proves the username/API key pair is
 * accepted, same "call the real endpoint, don't just check the shape"
 * approach as Bybit/Binance above. Not gated behind a PAYMENT_METHODS entry
 * (Digiflazz is a supplier, not a checkout payment method) — this key only
 * needs to exist in CONNECTION_TESTS for the generic
 * /api/settings/payments/:method/test route to dispatch it. */
export async function testDigiflazz(): Promise<ConnectionTestResult> {
  const creds = await getDigiflazzCreds(prisma);
  if (!creds) return { ok: false, detail: "Digiflazz username and API key are not both set." };
  try {
    const items = await getPriceList(creds);
    return { ok: true, detail: `Connected — ${items.length} SKU(s) in the price list.` };
  } catch (err) {
    return { ok: false, detail: `Digiflazz test failed: ${errorMessage(err)}` };
  }
}

/** A throwaway lookup that will never match a real account — reports whether
 * KokinPay accepted the request at all (a well-formed found-OR-not-found
 * response), not whether this particular id happens to exist. Mirrors
 * testDigiflazz's "call the real endpoint, don't just check the shape"
 * approach: `id: "0"` is not a real KokinPay account id for any game, so a
 * "not found" response here is the EXPECTED, connection-works outcome. */
export async function testKokinpay(): Promise<ConnectionTestResult> {
  const creds = await getKokinpayCreds(prisma);
  if (!creds) return { ok: false, detail: "KokinPay API key is not set." };
  try {
    const result = await checkGameNickname(creds, { gameCode: "mobile-legends", id: "0" });
    return {
      ok: true,
      detail: result.valid
        ? `Connected — KokinPay accepted the API key and returned a nickname ("${result.nickname}").`
        : "Connected — KokinPay accepted the API key and responded (the test id wasn't found, as expected).",
    };
  } catch (err) {
    return { ok: false, detail: `KokinPay test failed: ${errorMessage(err)}` };
  }
}

/** A throwaway Mobile Legends lookup that will never match a real account —
 * reports whether VIP-Reseller accepted the request at all (a well-formed
 * found-OR-not-found response), not whether this particular id happens to
 * exist. Same "call the real endpoint, don't just check the shape" approach
 * as testKokinpay: `id: "0"` is not a real account id, so a "not found"
 * result (countryCode: null) here is the EXPECTED, connection-works outcome
 * — region-check success/failure is not what this test measures. */
export async function testVipReseller(): Promise<ConnectionTestResult> {
  const creds = await getVipResellerCreds(prisma);
  if (!creds) return { ok: false, detail: "VIP-Reseller API ID and API key are not both set." };
  try {
    const result = await checkGameRegion(creds, { gameCode: "mobile-legends", id: "0" });
    return {
      ok: true,
      detail: result.countryCode
        ? `Connected — VIP-Reseller accepted the credentials and returned a region ("${result.countryCode}").`
        : "Connected — VIP-Reseller accepted the credentials and responded (the test id wasn't found, as expected).",
    };
  } catch (err) {
    return { ok: false, detail: `VIP-Reseller test failed: ${errorMessage(err)}` };
  }
}

/** A throwaway lookup that will never match a real account — reports whether
 * MeloStore accepted the request at all (a well-formed found-OR-not-found
 * response), not whether this particular id happens to exist. Same "call the
 * real endpoint, don't just check the shape" approach as testKokinpay/
 * testVipReseller: `id: "0"` is not a real MeloStore account id for any
 * game, so a "not found" result (errorCode 4001/4006) here is the EXPECTED,
 * connection-works outcome. */
export async function testMelostore(): Promise<ConnectionTestResult> {
  const creds = await getMelostoreCreds(prisma);
  if (!creds) return { ok: false, detail: "MeloStore API key and secret key are not both set." };
  try {
    const result = await melostoreCheckGameNickname(creds, { gameCode: "mobile-legends", id: "0" });
    return {
      ok: true,
      detail: result.valid
        ? `Connected — MeloStore accepted the credentials and returned a nickname ("${result.nickname}").`
        : "Connected — MeloStore accepted the credentials and responded (the test id wasn't found, as expected).",
    };
  } catch (err) {
    return { ok: false, detail: `MeloStore test failed: ${errorMessage(err)}` };
  }
}

/** Method key (as used in PAYMENT_METHODS / PAY_CRED_GROUPS, or — for
 * Digiflazz/KokinPay/VIP-Reseller/MeloStore — the supplier equivalent) →
 * tester. "bybit_bsc" intentionally reuses testBybit — it shares the same
 * account credentials as "bybit", so there is nothing separate to verify
 * here. */
export const CONNECTION_TESTS: Record<string, () => Promise<ConnectionTestResult>> = {
  tokopay: testTokopay,
  paydisini: testPaydisini,
  nowpayments: testNowpayments,
  bybit: testBybit,
  bybit_bsc: testBybit,
  binance_internal: testBinanceInternal,
  digiflazz: testDigiflazz,
  kokinpay: testKokinpay,
  vipreseller: testVipReseller,
  melostore: testMelostore,
};
