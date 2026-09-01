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
 *   2. The held attempt never got an answer. A transport failure — timeout,
 *      connection dropped, laptop asleep mid-flight — leaves the outcome
 *      UNKNOWN: the refund may well have been paid out and only the response
 *      lost. That is the case this whole mechanism exists for, so the retry
 *      (the confirm dialog stays open on failure, so retrying is one click)
 *      must carry the same key and be deduped. This is also what protects a
 *      double-tapped confirm button: the second tap fires while the first has
 *      yet to answer, so it reuses the key.
 *
 * Once a response of ANY status arrives the outcome is KNOWN and the key is
 * dropped, so the next click starts a new operation with a new key. That is
 * deliberate, and it is where this differs from a naive "never regenerate on
 * failure" rule: after a received 422 ("order is no longer underpaid") the
 * server has already stored that exact answer, so reusing the key cannot
 * protect anything — it can only replay the same error forever, turning the
 * retry into a no-op even once the underlying state has moved on. Answered
 * means finished; unanswered means retry the same operation.
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
  // scope ("path + body") → the key of an attempt that never got an answer.
  const unanswered = useRef(new Map<string, string>());

  return useCallback(async <T>(path: string, body: unknown): Promise<T> => {
    const scope = JSON.stringify({ path, body });
    const key = unanswered.current.get(scope) ?? newIdempotencyKey();
    unanswered.current.set(scope, key);
    let answered = false;
    try {
      return await apiPost<T>(path, body, {
        idempotencyKey: key,
        onResponse: () => {
          answered = true;
        },
      });
    } finally {
      if (answered) unanswered.current.delete(scope);
    }
  }, []);
}
