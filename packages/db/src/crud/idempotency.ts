/**
 * Client-side idempotency for mutating requests (checkout, refund, ...) — a
 * DIFFERENT mechanism from the payment-gateway Processed*Tx ledgers
 * (crud/nowpayments.ts, crud/tokopay.ts, etc.). Those dedupe an INBOUND
 * webhook callback that a gateway may resend; this dedupes a request a
 * BROWSER/ADMIN CLIENT sends twice — a double-tapped submit button, or a
 * network retry after the client never saw the first response. Do not reuse
 * one for the other's problem.
 *
 * Usage at a route: the caller supplies an `Idempotency-Key` header (opaque,
 * client-generated, e.g. a UUID minted once per checkout/refund attempt).
 *   1. `findIdempotentResponse` — same key+endpoint+hash seen before ⇒
 *      replay the stored response verbatim, without re-running the mutation.
 *      A different hash under the same key+endpoint throws
 *      `IdempotencyKeyReuseError` — the caller should answer 409.
 *   2. Run the mutation as normal when there is no prior record.
 *   3. `saveIdempotentResponse` — persist the response that was just sent, so
 *      a retry with the same key replays it next time.
 *
 * No key header ⇒ opt out entirely; every existing caller that never sends
 * one keeps today's exactly-once-per-request behavior unchanged.
 *
 * KNOWN FOLLOW-UP: `idempotency_records` has no retention/TTL and grows
 * unbounded — same as the Processed*Tx ledgers above, which also have no
 * cleanup job today (checked: `packages/db/src/crud/storageMaintenance.ts`
 * doesn't touch any of them). A row here is only ever useful for as long as
 * a client might plausibly retry with the same key (minutes, not months), so
 * a scheduled `deleteMany({ where: { createdAt: { lt: <cutoff> } } })` would
 * be a safe, cheap addition later — not built now since no such job exists
 * for this table's siblings either, and one wasn't requested by this task.
 */
import { createHash } from "node:crypto";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";

/** A previously completed response, ready to be replayed verbatim. */
export interface IdempotentReplay {
  statusCode: number;
  responseBody: string;
}

/** Thrown when a key+endpoint pair is reused with a DIFFERENT request body
 * than the one it was first claimed with — a client bug (reusing a key
 * across two distinct requests), never silently replayed or overwritten. */
export class IdempotencyKeyReuseError extends Error {
  constructor(
    public readonly key: string,
    public readonly endpoint: string,
  ) {
    super(`Idempotency-Key "${key}" was already used for "${endpoint}" with a different request`);
  }
}

/**
 * Stable, opaque digest of a request's meaningful fields — used ONLY to
 * detect "same key, different request" (see IdempotencyKeyReuseError), never
 * to reconstruct the payload. Callers must pass a plain object built with a
 * fixed, deterministic shape (same keys, same order) on every call for the
 * same logical request, or two equivalent requests could hash differently.
 * Deliberately excludes anything that legitimately varies between an
 * original request and its retry but doesn't change what's being asked for
 * (a CSRF token, for instance) — callers should omit those from what they
 * pass in here.
 */
export function hashIdempotentRequest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

/**
 * Look up a stored response for this key+endpoint.
 * - Returns null: no record yet — the caller should run the mutation and
 *   then call `saveIdempotentResponse`.
 * - Returns the stored { statusCode, responseBody }: an exact replay (same
 *   key, same requestHash) — send this back as-is, do not re-run anything.
 * - Throws IdempotencyKeyReuseError: same key+endpoint, different
 *   requestHash — the caller should answer 409, not run the mutation.
 */
export async function findIdempotentResponse(
  db: Db,
  args: { key: string; endpoint: string; requestHash: string },
): Promise<IdempotentReplay | null> {
  const existing = await db.idempotencyRecord.findUnique({
    where: { key_endpoint: { key: args.key, endpoint: args.endpoint } },
  });
  if (!existing) return null;
  if (existing.requestHash !== args.requestHash) {
    throw new IdempotencyKeyReuseError(args.key, args.endpoint);
  }
  return { statusCode: existing.statusCode, responseBody: existing.responseBody };
}

/**
 * Persist a just-completed mutation's response so a retry with the same key
 * replays it instead of re-running the mutation. Call this for whatever
 * response the caller is about to send back — a validation-error response is
 * just as safe (and just as worth caching) to replay as a success, since
 * replaying it re-runs nothing.
 *
 * A duplicate insert (two requests racing the same brand-new key at once) is
 * swallowed silently rather than erroring or overwriting: SQLite serializes
 * the two writes, exactly one insert wins, and the loser's own caller still
 * got the response its own mutation produced — nothing is lost by not
 * overwriting the winner's row with a second, redundant copy of the same
 * requestHash's outcome.
 */
export async function saveIdempotentResponse(
  db: Db,
  args: { key: string; endpoint: string; requestHash: string; statusCode: number; responseBody: string },
): Promise<void> {
  try {
    await db.idempotencyRecord.create({
      data: {
        key: args.key,
        endpoint: args.endpoint,
        requestHash: args.requestHash,
        statusCode: args.statusCode,
        responseBody: args.responseBody,
      },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
}
