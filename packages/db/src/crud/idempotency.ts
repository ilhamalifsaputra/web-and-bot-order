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
 *   1. `claimIdempotentRequest` — atomically reserves key+endpoint by
 *      inserting a pending row. Same key+endpoint+hash already completed ⇒
 *      replay the stored response verbatim, without re-running the mutation;
 *      still running in another request ⇒ wait for it, then replay (or throw
 *      `IdempotencyRequestInProgressError` after the wait budget). A
 *      different hash under the same key+endpoint throws
 *      `IdempotencyKeyReuseError`. Both errors ⇒ the caller answers 409.
 *   2. Run the mutation as normal when the claim is ours (null returned).
 *   3. `saveIdempotentResponse` — persist the response that was just sent, so
 *      a retry with the same key replays it next time. A mutation that throws
 *      instead releases its claim (`releaseIdempotentClaim`); one that never
 *      does either (a crashed process) expires after
 *      IDEMPOTENCY_CLAIM_EXPIRY_MS. Routes use `IdempotencyClaimTracker` to
 *      wire all three.
 *
 * Before backend audit E2 step 1 was a plain read, so two requests with the
 * same key in flight at once both read "nothing yet" and both ran.
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
 * Thrown by `claimIdempotentRequest` when another request holding the same
 * key+endpoint is still running and did not finish within the wait budget.
 * Nothing ran for this caller; it should answer 409 and let the client retry
 * with the same key, which will then replay the first request's response.
 */
export class IdempotencyRequestInProgressError extends Error {
  constructor(
    public readonly key: string,
    public readonly endpoint: string,
  ) {
    super(`A request with Idempotency-Key "${key}" for "${endpoint}" is still being processed`);
  }
}

/**
 * How long a claim may stay unfinished before it is treated as crashed (the
 * process died, or the connection dropped, between running the mutation and
 * saving its response) and a retry may take it over. Every claimed mutation is
 * one short database transaction, capped at 10 s by the client's
 * `transactionOptions.timeout` (packages/db/src/client.ts), so a minute is far
 * past any request that is genuinely still running. A takeover re-runs the
 * mutation, which is exactly what a key-less retry did before this mechanism
 * existed; the mutations' own state guards still apply.
 */
export const IDEMPOTENCY_CLAIM_EXPIRY_MS = 60_000;

/** How long a duplicate waits for the first request to finish by default. */
const DEFAULT_CLAIM_WAIT_MS = 8_000;
const CLAIM_POLL_INTERVAL_MS = 100;

/**
 * Reserve this key+endpoint for the caller, or hand back the response another
 * request already produced for it. Replaces the old read-only lookup, which let
 * two concurrent requests with the same key both read "nothing yet" and both
 * run the mutation (backend audit E2 item 1).
 *
 * The reservation is an INSERT of a pending row under the (key, endpoint)
 * unique index, so exactly one concurrent caller can win it.
 * - Returns null: this caller owns the claim — run the mutation, then call
 *   `saveIdempotentResponse` (or `releaseIdempotentClaim` if it throws).
 * - Returns { statusCode, responseBody }: a completed response for the same
 *   key and requestHash — send it back as-is, re-run nothing. When another
 *   request is still running, this waits up to `waitMs` for it to finish.
 * - Throws IdempotencyKeyReuseError: same key+endpoint, different requestHash
 *   — answer 409, run nothing.
 * - Throws IdempotencyRequestInProgressError: the other request is still
 *   running after `waitMs` — answer 409, run nothing.
 *
 * A claim left pending for longer than IDEMPOTENCY_CLAIM_EXPIRY_MS is taken
 * over by a compare-and-swap on `pendingSince`, so two retries racing for a
 * crashed claim cannot both win it.
 */
export async function claimIdempotentRequest(
  db: Db,
  args: { key: string; endpoint: string; requestHash: string; waitMs?: number; now?: Date },
): Promise<IdempotentReplay | null> {
  const where = { key_endpoint: { key: args.key, endpoint: args.endpoint } };
  const waitMs = args.waitMs ?? DEFAULT_CLAIM_WAIT_MS;
  const startedAt = Date.now();

  for (;;) {
    const now = args.now ?? new Date();
    try {
      await db.idempotencyRecord.create({
        data: {
          key: args.key,
          endpoint: args.endpoint,
          requestHash: args.requestHash,
          statusCode: 0,
          responseBody: "",
          pendingSince: now,
        },
      });
      return null;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }

    const existing = await db.idempotencyRecord.findUnique({ where });
    // Released between our insert and this read: try to claim it again.
    if (!existing) continue;
    if (existing.requestHash !== args.requestHash) {
      throw new IdempotencyKeyReuseError(args.key, args.endpoint);
    }
    if (existing.pendingSince === null) {
      return { statusCode: existing.statusCode, responseBody: existing.responseBody };
    }
    if (now.getTime() - existing.pendingSince.getTime() > IDEMPOTENCY_CLAIM_EXPIRY_MS) {
      const takeover = await db.idempotencyRecord.updateMany({
        where: { id: existing.id, requestHash: args.requestHash, pendingSince: existing.pendingSince },
        data: { pendingSince: now },
      });
      if (takeover.count === 1) return null;
      // Another retry took it over first; it is now a fresh claim to wait on.
    }
    if (Date.now() - startedAt >= waitMs) {
      throw new IdempotencyRequestInProgressError(args.key, args.endpoint);
    }
    await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_INTERVAL_MS));
  }
}

/**
 * Persist a just-completed mutation's response so a retry with the same key
 * replays it instead of re-running the mutation. Call this for whatever
 * response the caller is about to send back — a validation-error response is
 * just as safe (and just as worth caching) to replay as a success, since
 * replaying it re-runs nothing.
 *
 * Completes the caller's pending claim. A completed row is never overwritten:
 * the first saved response is the one every later retry replays. A caller that
 * never claimed (no pending row) still gets a row inserted, and a duplicate
 * insert racing it is swallowed rather than erroring or overwriting.
 */
export async function saveIdempotentResponse(
  db: Db,
  args: { key: string; endpoint: string; requestHash: string; statusCode: number; responseBody: string },
): Promise<void> {
  const completed = await db.idempotencyRecord.updateMany({
    where: {
      key: args.key,
      endpoint: args.endpoint,
      requestHash: args.requestHash,
      pendingSince: { not: null },
    },
    data: { statusCode: args.statusCode, responseBody: args.responseBody, pendingSince: null },
  });
  if (completed.count > 0) return;
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

/** The identity of one claimed request. */
export interface IdempotencyClaim {
  key: string;
  endpoint: string;
  requestHash: string;
}

/**
 * Per-route-module bookkeeping that ties a claim to the HTTP request that made
 * it, so a claim the handler never completed — it threw (a 500), or it
 * returned through an early exit that deliberately stores nothing — is
 * released when the response goes out instead of blocking retries until it
 * expires. Keyed by the request object in a WeakMap, so nothing leaks.
 *
 * Route usage: `claims.claim(...)` where the handler used to look the key up,
 * `claims.save(...)` where it stores the response, and one hook per route
 * module: `app.addHook("onResponse", (req) => claims.releaseUnsettled(prisma, req))`.
 */
export class IdempotencyClaimTracker {
  private readonly unsettled = new WeakMap<object, IdempotencyClaim>();

  /** `claimIdempotentRequest`, remembering the claim when this request owns it. */
  async claim(db: Db, request: object, args: IdempotencyClaim & { waitMs?: number }): Promise<IdempotentReplay | null> {
    const replay = await claimIdempotentRequest(db, args);
    if (replay === null) {
      this.unsettled.set(request, { key: args.key, endpoint: args.endpoint, requestHash: args.requestHash });
    }
    return replay;
  }

  /** `saveIdempotentResponse`, then forget the claim — it is completed. */
  async save(
    db: Db,
    request: object,
    args: IdempotencyClaim & { statusCode: number; responseBody: string },
  ): Promise<void> {
    await saveIdempotentResponse(db, args);
    this.unsettled.delete(request);
  }

  /** Release this request's claim if it was never saved. Safe to call for any request. */
  async releaseUnsettled(db: Db, request: object): Promise<void> {
    const claim = this.unsettled.get(request);
    if (!claim) return;
    this.unsettled.delete(request);
    await releaseIdempotentClaim(db, claim);
  }
}

/**
 * Drop the caller's still-pending claim after its mutation threw, so a retry
 * with the same key can run again right away instead of waiting out
 * IDEMPOTENCY_CLAIM_EXPIRY_MS. Never touches a completed response.
 */
export async function releaseIdempotentClaim(
  db: Db,
  args: { key: string; endpoint: string; requestHash: string },
): Promise<void> {
  await db.idempotencyRecord.deleteMany({
    where: {
      key: args.key,
      endpoint: args.endpoint,
      requestHash: args.requestHash,
      pendingSince: { not: null },
    },
  });
}
