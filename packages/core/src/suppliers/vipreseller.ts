/**
 * VIP-Reseller supplier client — a second, independent "does this in-game
 * account exist?" lookup used ONLY for its `country` field on Mobile Legends
 * responses, to catch a buyer who picked the wrong REGION variant of a game
 * (Region-check Task A; see this task's brief). KokinPay (../suppliers/
 * kokinpay.ts, Task 7 of the Digiflazz pilot) already covers "is this a real
 * account?" but its response carries no region data. Pure: no @app/db
 * dependency, mirrors kokinpay.ts's shape exactly (creds as first arg, one
 * shared fetch/parse error-handling chokepoint that throws a static
 * credential-free `Error` on any failure, a non-throwing "no result"
 * outcome for a normal not-found/no-region-data response).
 *
 * ⚠ ASSUMPTION: the SUCCESS response shape (`{ result: true, data, message,
 *   country? }`) and the auth scheme (`sign = md5(api_id + api_key)`, static
 *   per credential pair) are confirmed directly from VIP-Reseller's live docs
 *   (vip-reseller.co.id/api/game-feature, nickname-game-code.txt) as of this
 *   task. The FAILURE response shape was not documented with an example in
 *   that research, so this client makes no assumption about its fields at
 *   all: any response where `result !== true` is treated as a normal,
 *   non-throwing "no region data available" outcome (same fail-safe
 *   convention as kokinpay.ts), and only a genuine network/HTTP failure
 *   throws. Verify the failure shape against a live account before relying
 *   on `message` for anything beyond this. The base URL is overridable via
 *   VIPRESELLER_API_BASE (mirroring KOKINPAY_API_BASE), so a corrected path
 *   can be deployed without a code change if needed.
 */
import { createHash } from "node:crypto";
import { fetchWithTimeoutSafe, HTTP_TIMEOUT_MS } from "../http";

const API_BASE = process.env.VIPRESELLER_API_BASE ?? "https://vip-reseller.co.id/api";

export interface VipResellerCreds {
  apiId: string;
  apiKey: string;
}

export interface RegionCheckResult {
  /** Null when the lookup didn't resolve, OR when this game/response doesn't
   * carry country data at all (e.g. VIP-Reseller's own docs only show
   * `country` for Mobile Legends) — both are the same "no region signal
   * available" outcome from this function's caller's point of view. */
  countryCode: string | null;
}

/**
 * POST the game-feature endpoint and return its parsed JSON body. Same single
 * choke point as kokinpay.ts's fetchKokinpayJson: every failure mode of the
 * raw `fetch()` call — a DNS/connection/TLS failure, an aborted request, or
 * the deadline elapsing first — is caught HERE and rethrown as a new `Error`
 * built from a static, credential-free string, via `fetchWithTimeoutSafe`
 * (`@app/core/http`). The request body carries `key` (the api_key value) and
 * `sign` (derived from both credentials) in plain JSON, so this function
 * (and its caller) must never log `init.body` or attach the caught error's
 * `.cause` to a logger.
 */
async function fetchVipResellerJson(
  url: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeoutSafe(url, { ...init, timeoutMs }, "VIP-Reseller game-feature"); // never log init.body — it carries the API key/sign
  if (!res.ok) {
    // Unlike kokinpay.ts, no specific non-2xx status is documented as a
    // normal "not found" outcome for this endpoint — every non-2xx is
    // treated as a genuine gateway/HTTP failure. A well-formed "no region
    // data" result is expected as a 200 with `result !== true` in the body
    // (see checkGameRegion below), per this file's top-of-file ASSUMPTION.
    throw new Error(`VIP-Reseller game-feature HTTP ${res.status}`); // never log init.body — it carries the API key/sign
  }
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("VIP-Reseller game-feature response body read timed out"); // never log init.body — it carries the API key/sign
    }
    throw new Error("VIP-Reseller game-feature returned an unparseable response"); // never log init.body — it carries the API key/sign
  }
}

/**
 * Look up an in-game account via VIP-Reseller and extract its region, if the
 * response carries one. Never throws for a normal "not found" or
 * "no region data for this game" outcome — both collapse to
 * `{ countryCode: null }`, same as this codebase's other fail-safe-to-"not
 * this" client shapes (e.g. kokinpay.ts's checkGameNickname). Only a genuine
 * network/HTTP failure (via fetchVipResellerJson above) throws, and that
 * thrown Error is always built from a static, credential-free string.
 *
 * ⚠ ASSUMPTION (flagged, same as the rest of this client): the request/
 *   response field names below follow this task's brief, which was read
 *   directly from VIP-Reseller's live docs — but, like every other supplier
 *   client in this repo, this has not been verified against a real
 *   VIP-Reseller account/response. Verify before go-live.
 */
export async function checkGameRegion(
  creds: VipResellerCreds,
  args: { gameCode: string; id: string; server?: string },
): Promise<RegionCheckResult> {
  const sign = createHash("md5").update(`${creds.apiId}${creds.apiKey}`).digest("hex");
  const body = await fetchVipResellerJson(
    `${API_BASE}/game-feature`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: creds.apiKey,
        sign,
        type: "get-nickname",
        code: args.gameCode,
        target: args.id,
        ...(args.server ? { additional_target: args.server } : {}),
      }),
    },
    HTTP_TIMEOUT_MS.gatewayRead, // a live-typing UX convenience, not a checkout-blocking call — bounded, but no need for the longer checkout write budget
  );

  if (body.result !== true) {
    // Not-found, invalid code, or any other non-success outcome — a normal
    // "no region data available" result, never a thrown error (see this
    // file's top-of-file ASSUMPTION about the undocumented failure shape).
    return { countryCode: null };
  }
  const country = body.country;
  const countryCode =
    typeof country === "object" && country !== null && typeof (country as Record<string, unknown>).code === "string"
      ? ((country as Record<string, unknown>).code as string)
      : null;
  return { countryCode };
}

export interface VipResellerNicknameResult {
  nickname: string | null;
}

/**
 * ⚠ ASSUMPTION (new, on top of this file's existing top-of-file disclaimer):
 * the request already asks type:"get-nickname" (see checkGameRegion above);
 * body.data is expected to carry the nickname string, but its exact key is
 * UNVERIFIED against a live account — this must be verified before go-live,
 * same discipline as every other flagged assumption in this file. Added for
 * the NicknameService multi-provider adapter
 * (packages/core/src/nickname/vipresellerProvider.ts); does NOT change
 * checkGameRegion or any of its callers.
 */
export async function checkNicknameViaVipReseller(
  creds: VipResellerCreds,
  args: { gameCode: string; id: string; server?: string },
): Promise<VipResellerNicknameResult> {
  const sign = createHash("md5").update(`${creds.apiId}${creds.apiKey}`).digest("hex");
  const body = await fetchVipResellerJson(
    `${API_BASE}/game-feature`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: creds.apiKey,
        sign,
        type: "get-nickname",
        code: args.gameCode,
        target: args.id,
        ...(args.server ? { additional_target: args.server } : {}),
      }),
    },
    HTTP_TIMEOUT_MS.gatewayRead, // a live-typing UX convenience, not a checkout-blocking call — bounded, but no need for the longer checkout write budget
  );

  if (body.result !== true) {
    // Not-found, invalid code, or any other non-success outcome — a normal
    // "no nickname available" result, never a thrown error (same fail-safe
    // convention as checkGameRegion above).
    return { nickname: null };
  }
  const data = body.data;
  if (typeof data === "string") {
    return { nickname: data };
  }
  if (typeof data === "object" && data !== null && typeof (data as Record<string, unknown>).nickname === "string") {
    return { nickname: (data as Record<string, unknown>).nickname as string };
  }
  // Missing/malformed body.data — degrade to "no nickname available" rather
  // than throw (see this function's ⚠ ASSUMPTION above about the unverified
  // exact key).
  return { nickname: null };
}
