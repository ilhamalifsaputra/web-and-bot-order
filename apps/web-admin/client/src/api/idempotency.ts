/**
 * Client half of the opt-in `Idempotency-Key` contract the six payment
 * mutations implement (deliver / refund / cancel / match / credit / dismiss in
 * src/routes/api/payments.ts, on top of packages/db/src/crud/idempotency.ts).
 * Clone of the storefront hook (apps/storefront/client/src/api/idempotency.ts),
 * same as api/client.ts is a clone of its storefront twin.
 *
 * WHAT THE SERVER DOES, because the key lifecycle below only makes sense
 * against it:
 *   - No header  ⇒ opt out; the mutation runs, exactly as before.
 *   - Same key + same endpoint + same request hash ⇒ the stored response is
 *     replayed verbatim and NOTHING re-runs. The hash covers a small, fixed
 *     set of the request's meaningful fields (`{ orderId }` for the three
 *     per-order actions, `{ binanceTxId, orderCode }` for match and credit,
 *     `{ binanceTxId }` for dismiss), and the routes store the response for
 *     EVERY exit, 4xx included — a replayed failure is still a replay, so the
 *     admin gets the identical error back without the mutation being
 *     reconsidered.
 *   - Same key + same endpoint + a DIFFERENT request hash ⇒ HTTP 409
 *     `idempotency_key_reused`. Reusing one key across two genuinely different
 *     requests is treated as a client bug, never guessed at.
 *
 * THE KEY LIFECYCLE that falls out of those three rules. A held key is reused
 * for a call only when BOTH are true:
 *
 *   1. The request is byte-identical to the held one (same path, same body).
 *      Every field the server hashes is either in the path (the order id) or
 *      in the body (the transfer id, the order code), so an admin who edits
 *      the manual-match form between attempts gets a fresh key instead of a
 *      409. Bulk dismiss falls out of the same rule for free: each transfer is
 *      its own body, hence its own key.
 *
 *   2. The held attempt's outcome is still UNKNOWN. That means no response at
 *      all (timeout, connection dropped, laptop asleep mid-flight) — and also
 *      two statuses that DID arrive but answered nothing:
 *
 *      - **5xx.** No route here ever stores one. `respond()` — the only caller
 *        of `saveIdempotentResponse` — is used with 200/400/404/422 and
 *        nothing else, because a 500 is an escaped `throw` and a 502/504 is
 *        the reverse proxy giving up before the app replied at all. A 504 over
 *        a refund that actually paid out is the textbook double-payment case:
 *        the row IS stored (with its real 200), and only reusing the key
 *        replays it.
 *      - **429.** `paymentsMutationRateLimited` short-circuits and returns
 *        before the route reaches its idempotency block at all
 *        (src/routes/api/payments.ts:129, and the same five lines on the other
 *        five routes), so a throttled attempt stores nothing and tells us
 *        nothing about whether an EARLIER attempt ran. Dropping the key here
 *        would be actively harmful, because a 429 is exactly what repeated
 *        retry-clicking after a timeout provokes: attempt 1 times out with the
 *        refund possibly paid, attempt 2 is throttled, and a fresh key on
 *        attempt 3 pays it again.
 *
 *      In all of these the refund may well have been paid out and only the
 *      answer lost, which is the case this whole mechanism exists for, so the
 *      retry must carry the same key.
 *
 * Any other response makes the outcome KNOWN and drops the key, so the next
 * click starts a new operation. That is deliberate, and it is where this
 * differs from a naive "never regenerate on failure" rule: after a received
 * 422 ("order is no longer underpaid") the server has already stored that
 * exact answer, so reusing the key cannot protect anything — it can only
 * replay the same error forever, turning the retry into a no-op even once the
 * underlying state has moved on.
 *
 * 401/403 need no special case: both short-circuit before the idempotency
 * block too, but both drive a full page reload in this codebase, which takes
 * the whole ref map with it regardless of what this decided.
 *
 * KNOWN LIMIT — this makes a SEQUENTIAL retry safe, which is what it is for.
 * It does not fully dedupe two requests genuinely in flight at once (a
 * double-tapped confirm that outruns the button's disabled state):
 * `findIdempotentResponse` only reads a row that `saveIdempotentResponse`
 * writes at response time, so there is no in-flight reservation — both can
 * read null, both can run, and the loser's insert is swallowed as a unique
 * violation. Closing that would need a reservation row written on the way in.
 *
 * The held keys live in a `useRef`, so they survive re-renders and any number
 * of retries within one visit to the page, and are gone when the page unmounts
 * — leaving a fresh page (or a reload) as the admin's escape hatch from a
 * replayed error. The map only ever holds requests whose outcome is still in
 * doubt, which in practice is zero or one entry.
 */
import { useCallback, useRef } from "react";
import { apiPost } from "./client";

/**
 * A fresh opaque key. `crypto.randomUUID` is the obvious choice but is
 * SECURE-CONTEXT ONLY — an admin panel served over plain http:// (a LAN box, a
 * staging host without TLS) has no such function, and calling it there would
 * throw a TypeError out of the Refund button. `getRandomValues`, which carries
 * the actual entropy, has no such restriction, so fall back to formatting a
 * v4 UUID from it by hand. The server treats the key as an opaque string
 * (`normalizeIdempotencyKey`: non-empty, ≤255 chars), so only uniqueness
 * matters, not the UUID formatting.
 */
function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
    const key = unanswered.get(scope) ?? newIdempotencyKey();
    unanswered.set(scope, key);
    let answered = false;
    try {
      return await apiPost<T>(path, body, {
        idempotencyKey: key,
        // 5xx and 429 are responses that arrived without answering the
        // question — see the header comment.
        onResponse: (status) => {
          answered = status < 500 && status !== 429;
        },
      });
    } finally {
      if (answered) unanswered.delete(scope);
    }
  }, []);
}
