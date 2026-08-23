/**
 * MeloStore supplier client — a nickname-check provider for the
 * multi-provider NicknameService (packages/core/src/nickname/). Pure: no
 * @app/db dependency, mirrors kokinpay.ts's/vipreseller.ts's shape (creds as
 * first arg, one shared fetch/parse error-handling chokepoint that throws a
 * static credential-free `Error` on any failure).
 *
 * ⚠ ASSUMPTION: this ENTIRE client is a best-effort reading of MeloStore's
 *   public H2H partner docs (h2h.melostore.id/en/docs) — NOT verified
 *   against a live MeloStore account (no credentials were available while
 *   writing this). Base URL, auth header names (X-API-Key/X-Secret-Key/
 *   X-H2H-Signature), and the check-nickname endpoint path are read from the
 *   docs page as best I could tell; the exact request/response JSON field
 *   names below (`game_code`/`target`/`target_zone` in the request, and
 *   `code`/`message`/`data.nickname` in the response, with `code: 0` meaning
 *   success and `code: 4001`/`code: 4006` meaning the two documented
 *   non-throwing failure outcomes) are a best guess and MUST be verified
 *   against a real account before go-live, same discipline as every other
 *   "⚠ ASSUMPTION" in this repo's supplier clients. The base URL is
 *   overridable via MELOSTORE_API_BASE, so a corrected base can be deployed
 *   without a code change if that part of the assumption turns out wrong.
 *
 * ⚠ ASSUMPTION (signature scheme): the docs describe an HMAC-SHA256
 *   signature over the request body, sent as X-H2H-Signature, but do not
 *   show a worked example. This client signs the *exact* JSON string passed
 *   as the request body (HMAC over JSON is order-sensitive, so signing a
 *   re-serialization of the same object could produce a different digest) —
 *   verify this matches MeloStore's actual verification logic before
 *   go-live.
 */
import { createHmac } from "node:crypto";
import { fetchWithTimeoutSafe, HTTP_TIMEOUT_MS } from "../http";

const API_BASE = process.env.MELOSTORE_API_BASE ?? "https://api.melostore.id/api/v1/h2h";

export interface MelostoreCreds {
  apiKey: string;
  secretKey: string;
}

export interface NicknameCheckResult {
  valid: boolean;
  nickname: string | null;
  /**
   * MeloStore's own documented error code (4001 "Account not found" or 4006
   * "Target parameter input is incomplete or invalid"), present only on a
   * non-throwing failure outcome. Unlike kokinpay.ts's NicknameCheckResult,
   * this client's adapter (../nickname/melostoreProvider.ts) needs to map
   * these two cases to different NicknameErrorCode values, so this field
   * carries that distinction through instead of folding both into a single
   * `valid:false`.
   */
  errorCode?: 4001 | 4006;
}

/**
 * POST the check-nickname endpoint and return its parsed JSON body. Same
 * single choke point as fetchKokinpayJson: every failure mode of the raw
 * `fetch()` call — a DNS/connection/TLS failure, an aborted request, or the
 * deadline elapsing first — is caught HERE and rethrown as a new `Error`
 * built from a static, credential-free string, via `fetchWithTimeoutSafe`
 * (`../http`). Unlike KokinPay (which signals "not found"/"invalid" via HTTP
 * status codes 404/400), MeloStore's documented 4001/4006 outcomes ride in
 * the JSON body of an ordinary 200 response, so this chokepoint treats ANY
 * non-2xx HTTP status as a genuine failure — the 4001/4006 body-code
 * handling happens one layer up, in checkGameNickname. The request carries
 * `apiKey`/`secretKey` in headers and the signature is derived from
 * `secretKey`, so this function (and its caller) must never log `init.body`,
 * `init.headers`, or attach the caught error's `.cause` to a logger.
 */
async function fetchMelostoreJson(
  url: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeoutSafe(url, { ...init, timeoutMs }, "MeloStore check-nickname"); // never log init.body/init.headers — they carry the API key, secret key, and signature
  if (!res.ok) {
    throw new Error(`MeloStore check-nickname HTTP ${res.status}`); // never log init.body/init.headers — they carry the API key, secret key, and signature
  }
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("MeloStore check-nickname response body read timed out"); // never log init.body/init.headers — they carry the API key, secret key, and signature
    }
    throw new Error("MeloStore check-nickname returned an unparseable response"); // never log init.body/init.headers — they carry the API key, secret key, and signature
  }
}

/**
 * Look up an in-game account's nickname via MeloStore. Never throws for
 * MeloStore's two documented non-throwing outcomes — error code 4001
 * ("Account not found") and 4006 ("Target parameter input is incomplete or
 * invalid") — both represented as `{ valid: false, nickname: null, errorCode
 * }`, same fail-safe-to-"not this" shape as this codebase's other supplier
 * clients. Only a genuine network/HTTP failure (via fetchMelostoreJson
 * above), an unparseable body, or a response carrying a `code` this client
 * doesn't recognize throws, and every thrown Error is built from a static,
 * credential-free string.
 *
 * ⚠ ASSUMPTION (flagged again here, same as this file's header): the
 *   request/response field names below are a best guess from MeloStore's
 *   public docs, NOT verified against a real account. Verify before go-live.
 */
export async function checkGameNickname(
  creds: MelostoreCreds,
  args: { gameCode: string; id: string; server?: string },
): Promise<NicknameCheckResult> {
  const bodyString = JSON.stringify({
    game_code: args.gameCode,
    target: args.id,
    ...(args.server ? { target_zone: args.server } : {}),
  }); // never log this — it is signed below and sent as the request body

  const signature = createHmac("sha256", creds.secretKey).update(bodyString).digest("hex"); // never log creds.secretKey or this signature

  const body = await fetchMelostoreJson(
    `${API_BASE}/check-nickname`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-Key": creds.apiKey,
        "X-Secret-Key": creds.secretKey,
        "X-H2H-Signature": signature,
      },
      body: bodyString,
    },
    HTTP_TIMEOUT_MS.gatewayRead, // a live-typing UX convenience, not a checkout-blocking call — bounded, but no need for the longer checkout write budget
  );

  if (typeof body.code !== "number") {
    // A well-formed MeloStore response always has a numeric `code` field.
    // Anything else — most concretely, a generic API-gateway error page for
    // a wrong endpoint path — must not be silently folded into the normal
    // {valid:false} "not found" outcome below, same reasoning as
    // kokinpay.ts's equivalent guard.
    throw new Error("MeloStore check-nickname returned an unexpected response shape"); // never log init.body/init.headers — they carry the API key, secret key, and signature
  }
  if (body.code === 0) {
    const data = body.data as Record<string, unknown> | undefined;
    const nickname = data && typeof data.nickname === "string" ? data.nickname : null;
    return { valid: nickname !== null, nickname };
  }
  if (body.code === 4001 || body.code === 4006) {
    // Documented non-throwing outcomes — not-found (4001) or invalid target
    // input (4006). Carried through as `errorCode` so the adapter
    // (../nickname/melostoreProvider.ts) can map each to a distinct
    // NicknameErrorCode.
    return { valid: false, nickname: null, errorCode: body.code };
  }
  // Any other `code` value is undocumented — treat as a genuine failure
  // rather than silently returning a "not found" outcome for an unrecognized
  // response.
  throw new Error("MeloStore check-nickname returned an unrecognized response code"); // never log init.body/init.headers — they carry the API key, secret key, and signature
}
