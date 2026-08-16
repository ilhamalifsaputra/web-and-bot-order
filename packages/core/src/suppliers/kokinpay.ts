/**
 * KokinPay supplier client — a live "does this in-game account exist, and
 * what's its nickname?" lookup for the storefront's instant-buy flow (Task 7,
 * the final task of the Digiflazz top-up pilot). Digiflazz itself has no
 * nickname-check endpoint; KokinPay (api.kokinpay.com) is a separate, paid
 * service chosen specifically for this feature — see this task's brief for
 * the provider decision. Pure: no @app/db dependency, mirrors
 * ../suppliers/digiflazz.ts's shape (creds as first arg, one shared
 * fetch/parse error-handling chokepoint that throws a static
 * credential-free `Error` on any failure).
 *
 * ⚠ ASSUMPTION: KokinPay's own docs page is internally inconsistent about
 *   whether the endpoint path includes a `/v1` prefix — its prose names
 *   `POST https://api.kokinpay.com/v1/check-nickname`, but the page's own
 *   curl example omits `/v1`. This client uses the `/v1`-prefixed path as
 *   its best guess (consistent with the rest of this repo's supplier/gateway
 *   clients, which all version their base path), but this is UNVERIFIED
 *   against a live KokinPay account. Verify the correct path (with a real
 *   API key and a real lookup) before go-live — same "flag unverified
 *   wire-format assumptions, confirm before go-live" discipline already used
 *   throughout ../suppliers/digiflazz.ts. The base URL is overridable via
 *   KOKINPAY_API_BASE (mirroring digiflazz.ts's DIGIFLAZZ_API_BASE), so a
 *   corrected path can be deployed without a code change if the assumption
 *   above turns out wrong.
 */
import { fetchWithTimeoutSafe, HTTP_TIMEOUT_MS } from "../http";

const API_BASE = process.env.KOKINPAY_API_BASE ?? "https://api.kokinpay.com/v1";

export interface KokinpayCreds {
  apiKey: string;
}

export interface NicknameCheckResult {
  valid: boolean;
  nickname: string | null;
}

/**
 * POST the check-nickname endpoint and return its parsed JSON body. Same
 * single choke point as digiflazz.ts's fetchDigiflazzJson: every failure mode
 * of the raw `fetch()` call — a DNS/connection/TLS failure, an aborted
 * request, or the deadline elapsing first — is caught HERE and rethrown as a
 * new `Error` built from a static, credential-free string, via
 * `fetchWithTimeoutSafe` (`@app/core/http`). The request body carries
 * `api_key` in plain JSON (KokinPay's auth scheme — no header signature), so
 * this function (and its caller) must never log `init.body` or attach the
 * caught error's `.cause` to a logger.
 */
async function fetchKokinpayJson(
  url: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeoutSafe(url, { ...init, timeoutMs }, "KokinPay check-nickname"); // never log init.body — it carries the API key
  if (!res.ok && res.status !== 400 && res.status !== 404) {
    // 400 (invalid game_code) and 404 (account not found) are normal,
    // well-formed "not valid" outcomes per KokinPay's docs — parsed as JSON
    // below like any other response. Anything else non-2xx is a genuine
    // gateway/HTTP failure.
    throw new Error(`KokinPay check-nickname HTTP ${res.status}`); // never log init.body — it carries the API key
  }
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("KokinPay check-nickname response body read timed out"); // never log init.body — it carries the API key
    }
    throw new Error("KokinPay check-nickname returned an unparseable response"); // never log init.body — it carries the API key
  }
}

/**
 * Look up an in-game account's nickname via KokinPay. Never throws for a
 * normal "not found" or "invalid game_code" outcome — those are represented
 * as `{ valid: false, nickname: null }`, same as this codebase's other
 * fail-safe-to-"not this" client shapes (e.g. digiflazz.ts's
 * normalizeStatus). Only a genuine network/HTTP failure (via
 * fetchKokinpayJson above) throws, and that thrown Error is always built
 * from a static, credential-free string.
 *
 * ⚠ ASSUMPTION (flagged, same as the rest of this client): the request/
 *   response field names below follow this task's brief, which was read
 *   directly from KokinPay's live docs — but, like every other supplier
 *   client in this repo, this has not been verified against a real KokinPay
 *   account/response. Verify before go-live.
 */
export async function checkGameNickname(
  creds: KokinpayCreds,
  args: { gameCode: string; id: string; server?: string },
): Promise<NicknameCheckResult> {
  const body = await fetchKokinpayJson(
    `${API_BASE}/check-nickname`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: creds.apiKey,
        id: args.id,
        game_code: args.gameCode,
        ...(args.server ? { server: args.server } : {}),
      }),
    },
    HTTP_TIMEOUT_MS.gatewayRead, // a live-typing UX convenience, not a checkout-blocking call — bounded, but no need for the longer checkout write budget
  );

  if (typeof body.status !== "boolean") {
    // A well-formed KokinPay response always has a boolean `status` field.
    // Anything else — most concretely, a generic API-gateway 404/500 JSON
    // error page returned for a WRONG endpoint path — must not be silently
    // folded into the normal {valid:false} "not found" outcome below, or a
    // wrong path becomes indistinguishable from a real "account not found"
    // (see this file's top-of-file ASSUMPTION about the unverified /v1
    // path). Throwing here is what lets testKokinpay's go-live connection
    // check actually catch a wrong-path misconfiguration instead of
    // reporting a false "Connected".
    throw new Error("KokinPay check-nickname returned an unexpected response shape"); // never log init.body — it carries the API key
  }
  if (body.status === true) {
    const data = body.data as Record<string, unknown> | undefined;
    const nickname = data && typeof data.nickname === "string" ? data.nickname : null;
    return { valid: nickname !== null, nickname };
  }
  // { status: false } — not-found or invalid game_code, both a normal
  // "no live check result" outcome, never a thrown error.
  return { valid: false, nickname: null };
}
