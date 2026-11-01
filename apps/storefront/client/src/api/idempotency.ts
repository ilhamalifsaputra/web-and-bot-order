/**
 * Client half of the opt-in `Idempotency-Key` contract the order-creating
 * routes implement (POST /api/v1/checkout in src/routes/api.ts, POST
 * /api/v1/topup/order in src/routes/apiTopup.ts, both on top of
 * packages/db/src/crud/idempotency.ts). Clone of the web-admin hook
 * (apps/web-admin/client/src/api/idempotency.ts), same as api/client.ts is a
 * clone of its web-admin twin.
 *
 * WHAT THE SERVER DOES, because the key lifecycle below only makes sense
 * against it:
 *   - No header  ⇒ opt out; the mutation runs, exactly as before.
 *   - Same key + same endpoint + same request hash ⇒ the stored response is
 *     replayed verbatim and NOTHING re-runs. The hash covers a small, fixed
 *     set of the request's meaningful fields, and the routes store the
 *     response for EVERY exit, 4xx included — a replayed failure is still a
 *     replay, so the buyer gets the identical error back without the mutation
 *     being reconsidered.
 *   - Same key + same endpoint + a DIFFERENT request hash ⇒ HTTP 409
 *     `error.idempotency_key_reused`. Reusing one key across two genuinely
 *     different requests is treated as a client bug, never guessed at.
 *
 * THE KEY LIFECYCLE that falls out of those three rules. A held key is reused
 * for a call only when BOTH are true:
 *
 *   1. The request is byte-identical to the held one (same path, same body).
 *      Anything the buyer edits between attempts — the payment method, the
 *      voucher, a rejected guest email, the info-step answers — changes the
 *      body, and every one of those fields is also in the server's request
 *      hash. Reusing the key across such an edit would earn a 409 rather than
 *      protection, so an edited request always gets a fresh key. (The reverse
 *      mistake is harmless: a body that differs while the server's narrower
 *      hash would not simply forgoes replay for that one attempt, which is
 *      exactly today's behaviour.)
 *
 *   2. The held attempt's outcome is still UNKNOWN. That means no response at
 *      all (timeout, connection dropped, tab offline mid-flight) — and also
 *      two statuses that DID arrive but answered nothing:
 *
 *      - **5xx.** No route here ever stores one. `respond()` — the only caller
 *        of `saveIdempotentResponse` — is used with 200/201/400/404/422 and
 *        nothing else, because a 500 is an escaped `throw` and a 502/504 is
 *        the reverse proxy giving up before the app replied at all. A 504 over
 *        a checkout that actually completed is the textbook duplicate-order
 *        case: the row IS stored (with its real 201), and only reusing the key
 *        replays it.
 *      - **429.** The submit rate limiter short-circuits and returns before
 *        the route reaches its idempotency block at all (routes/api.ts:532,
 *        routes/apiTopup.ts:299), so a throttled attempt stores nothing and
 *        tells us nothing about whether an EARLIER attempt ran. Dropping the
 *        key here would be actively harmful, because a 429 is exactly what
 *        repeated retry-clicking after a timeout provokes: attempt 1 times out
 *        with the order possibly created, attempt 2 is throttled, and a fresh
 *        key on attempt 3 buys the same thing twice.
 *
 *      In all of these the order may well have been created and only the
 *      answer lost, which is the case this whole mechanism exists for, so the
 *      retry must carry the same key.
 *
 * Any other response makes the outcome KNOWN and drops the key, so the next
 * click starts a new operation. That is deliberate, and it is where this
 * differs from a naive "never regenerate on failure" rule: after a received
 * 4xx the server has already stored that exact answer, so reusing the key
 * cannot protect anything — it can only replay the same error forever, turning
 * the retry button into a no-op for a buyer whose stock or price problem has
 * since cleared.
 *
 * 401/403 need no special case: both short-circuit before the idempotency
 * block too, but both drive a full page reload in this codebase, which takes
 * the whole ref map with it regardless of what this decided.
 *
 * TWO REQUESTS IN FLIGHT AT ONCE (a double-tap that outruns the button's
 * disabled state) are deduped too: the server reserves the key on the way in
 * (`claimIdempotentRequest`), so the second waits for the first and replays
 * its response. Only if the first is still running after the server's wait
 * budget does the second get HTTP 409 `error.idempotency_request_in_progress`
 * — which stores nothing and answers nothing (the first attempt may still
 * complete), so this hook HOLDS the key on it exactly like a 5xx or 429. Were
 * the key dropped, a lost first response would leave the next click with a
 * fresh key and the mutation would run twice; a byte-identical retry cannot
 * hit `key_reused`. Only that one 409 is held — it is told apart from every
 * other 409 (`key_reused`, a code already taken, ...) by the server's error
 * code, and those still drop the key as answered — with one exception:
 * `key_reused` against a key HELD from an unknown attempt says only that the
 * earlier attempt reached the server, so that key stays held. A 2xx whose body
 * cannot be read also leaves the key held: the order may exist and the buyer
 * never saw it.
 *
 * The held keys live in a `useRef`, so they survive re-renders and any number
 * of retries within one visit to the page, and are gone when the page unmounts
 * — leaving a fresh page (or a reload) as the buyer's escape hatch from a
 * replayed error. The map only ever holds requests whose outcome is still in
 * doubt, which in practice is zero or one entry.
 */
import { useCallback, useRef } from "react";
import { randomUuid } from "../lib/randomId";
import { apiPost } from "./client";

/** A fresh opaque key (lib/randomId.ts explains the plain-http fallback). The
 * server treats it as an opaque string (`normalizeIdempotencyKey`: non-empty,
 * ≤255 chars), so only uniqueness matters. */
const newIdempotencyKey = randomUuid;

/** The server's error code for "the first attempt with this key is still
 * running" — the one 409 that leaves the outcome unknown. */
const REQUEST_IN_PROGRESS = "error.idempotency_request_in_progress";
/** A key the server already holds for a request with a different hash. */
const KEY_REUSED = "error.idempotency_key_reused";

/**
 * What a failed order-creating call says about whether the order exists — the
 * page-level twin of the hook's own held/dropped decision below, read off the
 * thrown error (`api/client.ts` attaches `status` whenever a response arrived).
 *
 * - `unanswered`: no response at all (fetch's TypeError, an abort, a 2xx whose
 *   body would not parse), a 5xx, or the in-progress 409. The order may exist.
 * - `inconclusive`: a 429 (the limiter answered before the route ran) or
 *   `error.idempotency_key_reused` (an earlier attempt with this key reached the
 *   server under a different hash). Neither says anything new about an earlier
 *   attempt, so the caller keeps whatever it already believed.
 * - `answered`: anything else. The server decided, and no order was made by
 *   this attempt.
 */
export type OrderFailureOutcome = "unanswered" | "inconclusive" | "answered";

export function orderFailureOutcome(err: unknown): OrderFailureOutcome {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  const message = err instanceof Error ? err.message : "";
  if (typeof status !== "number") {
    const transport = err instanceof TypeError || err instanceof SyntaxError || (err instanceof Error && err.name === "AbortError");
    return transport ? "unanswered" : "answered";
  }
  if (status >= 500) return "unanswered";
  if (status === 409 && message === REQUEST_IN_PROGRESS) return "unanswered";
  if (status === 429 || (status === 409 && message === KEY_REUSED)) return "inconclusive";
  return "answered";
}

/** `apiPost`, with the `Idempotency-Key` lifecycle above applied. */
export type IdempotentPost = <T>(path: string, body: unknown) => Promise<T>;

export function useIdempotentPost(): IdempotentPost {
  // scope ("path + body") → the key of an attempt whose outcome is still in
  // doubt. Built on first use rather than in the `useRef` argument, which
  // would allocate and discard a Map on every render.
  const unansweredRef = useRef<Map<string, string> | null>(null);

  return useCallback(async <T>(path: string, body: unknown): Promise<T> => {
    const unanswered = (unansweredRef.current ??= new Map<string, string>());
    const scope = JSON.stringify({ path, body });
    // A key held from an earlier attempt whose outcome is still unknown.
    const heldKey = unanswered.get(scope);
    const key = heldKey ?? newIdempotencyKey();
    unanswered.set(scope, key);
    let answered = false;
    let status: number | undefined;
    try {
      const result = await apiPost<T>(path, body, {
        idempotencyKey: key,
        onResponse: (s) => {
          status = s;
        },
      });
      // Answered only once the body is in hand: a 201 whose body never
      // arrived intact still leaves the buyer not knowing their order.
      answered = true;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      answered =
        status !== undefined &&
        // A 2xx that threw here failed while its body was read (review I1).
        status >= 300 &&
        // 5xx and 429 arrived without answering the question — see the header comment.
        status < 500 &&
        status !== 429 &&
        // The in-progress 409 is unanswered too; only its error code tells it from other 409s.
        message !== REQUEST_IN_PROGRESS &&
        // key_reused against a key HELD from an unknown attempt says only that
        // the earlier attempt reached the server: keep holding it so a retry can
        // still replay that attempt (review I3). A fresh key's key_reused is a
        // real answer and drops it as before.
        !(heldKey !== undefined && message === KEY_REUSED);
      throw err;
    } finally {
      if (answered) unanswered.delete(scope);
    }
  }, []);
}
