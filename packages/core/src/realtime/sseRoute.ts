import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../logger";

/** The minimal slice of a Fastify reply this helper needs — real Fastify
 * `FastifyReply` objects satisfy this structurally, no cast/adapter
 * needed at call sites. Kept framework-free (packages/core has no
 * fastify dependency) so this module is testable with a plain mock. */
export interface SseReply {
  hijack(): void;
  raw: ServerResponse;
}

/** The minimal slice of a Fastify request this helper needs. */
export interface SseRequest {
  raw: IncomingMessage;
}

export interface StreamSseOptions<T> {
  /** Read the current state once, at connect time — sent as the first
   * event so a fresh tab doesn't wait for the next change. */
  initial: () => Promise<T>;
  /** Re-read current state from the source of truth (the DB). Called on
   * every fallback poll tick AND every in-process emit — this is what
   * guarantees correctness independent of whether the emit ever fires
   * (see the module doc comment below). */
  poll: () => Promise<T>;
  /** Subscribe to the in-process "something changed" signal (e.g.
   * onDigiflazzOrderStatusChanged). Returns an unsubscribe function.
   * Purely a latency optimization — see the module doc comment. */
  subscribe: (onChange: () => void) => () => void;
  /** Dedupe predicate: return true only when `next` genuinely differs
   * from the last value actually pushed to this connection (`prev` is
   * null before the first push). Prevents redundant `data:` frames when
   * poll/subscribe both fire for the same underlying change. */
  changed: (prev: T | null, next: T) => boolean;
  /** Fallback poll interval — also doubles as the SSE keep-alive cadence
   * (an unchanged tick still writes a `: keep-alive` comment line, so the
   * connection never goes silent long enough for an idle-timing proxy to
   * drop it). Default 12000ms. */
  pollIntervalMs?: number;
}

/**
 * Serve one Server-Sent Events connection over `reply`/`req`, pushing
 * JSON-encoded `data:` frames whenever `opts.changed` says the state
 * moved. Two ways a push gets triggered, layered together — a single
 * subscriber-fired change is pushed by the in-process path, and a state
 * change that DID happen with no matching emit (or on a topology where
 * the emitter never fires at all) is still caught within
 * `opts.pollIntervalMs`:
 *
 * - **In-process fast path** (`opts.subscribe`): near-instant, but only
 *   fires at all in the single-process production topology
 *   (`apps/server/src/index.ts`, where the web app and the order-bot cron
 *   jobs that call the corresponding `emit*` function share one process).
 * - **DB-poll fallback** (`opts.poll`, every `pollIntervalMs`):
 *   correctness-bearing — this is what makes the realtime feature still
 *   eventually-correct (within one poll interval) in the standalone
 *   dev/worktree topology (`apps/order-bot/src/main.ts` running as its
 *   own OS process, separate from the web app serving this route), where
 *   the in-process emitter can never fire across the process boundary.
 *   Every caller of this helper MUST treat the fallback as the source of
 *   truth and the subscribe path as pure latency optimization — never
 *   the other way around.
 *
 * Resolves once the connection closes (client disconnect, or the server
 * tearing down) — awaiting it is optional for callers (typical usage is
 * `void streamSse(reply, req, opts)` inside a route handler after
 * `reply.hijack()` has effectively taken over the response), but it's
 * returned so a caller that wants to know when cleanup finished can wait
 * on it (e.g. in a test).
 *
 * Design choice on initial-fetch failure (see task brief point 7): if
 * `opts.initial()` rejects, that failure is caught HERE, logged, and the
 * connection is closed cleanly (the returned promise resolves) rather
 * than being allowed to propagate out of `streamSse` itself. Rationale:
 * by the time `opts.initial()` runs, `reply.hijack()` has already been
 * called, so the caller's route handler has fully handed the raw
 * response over to us — there is no framework-level error handler left
 * upstream to catch a thrown rejection and turn it into an HTTP error
 * response; letting it propagate would either be silently swallowed by
 * an unawaited `void streamSse(...)` call site (an unhandled rejection)
 * or force every future call site to duplicate this same try/catch. A
 * broken initial connect logging a warning and closing cleanly is safer
 * and simpler for callers than either alternative.
 */
export function streamSse<T>(
  reply: SseReply,
  req: SseRequest,
  opts: StreamSseOptions<T>
): Promise<void> {
  const pollIntervalMs = opts.pollIntervalMs ?? 12_000;

  return new Promise<void>((resolve) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    let lastPushed: T | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let closed = false;

    const connectionGone = () => reply.raw.destroyed || reply.raw.writableEnded;

    const writeData = (value: T) => {
      if (connectionGone()) return;
      let frame: string;
      try {
        frame = `data: ${JSON.stringify(value)}\n\n`;
      } catch (err) {
        // A circular reference or a BigInt in the caller-supplied value would
        // throw synchronously here — no current caller can trigger this
        // (all three routes stream plain string/number/null fields from a
        // narrow Prisma `select`), but this module already fixed two other
        // instances of exactly this bug class (unguarded opts.changed()/
        // opts.subscribe() calls) — this is the third, in the one place
        // those earlier fixes didn't cover. A throw here would otherwise be
        // an unhandled rejection (this runs inside the unawaited connect
        // IIFE) AND leave the hijacked socket open forever. No safe partial
        // frame exists for a value that can't be JSON-stringified, so close
        // the connection instead of attempting one.
        logger.warn({ err }, "SSE writeData() failed to JSON.stringify the pushed value; closing the connection");
        cleanup();
        return;
      }
      reply.raw.write(frame);
      lastPushed = value;
    };

    const writeKeepAlive = () => {
      if (connectionGone()) return;
      reply.raw.write(": keep-alive\n\n");
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
      if (unsubscribe !== null) {
        try {
          unsubscribe();
        } catch (err) {
          // Caller-supplied — must never crash cleanup (this can run
          // synchronously inside the "close" event handler, where an
          // uncaught throw would be worse than a swallowed one here).
          logger.warn({ err }, "SSE subscribe()'s unsubscribe function threw during cleanup");
        }
        unsubscribe = null;
      }
      // Actually terminate the response — without this, a connection that
      // never gets past a failing initial() (or any other cleanup() call
      // reached before the client itself disconnected) leaves the socket
      // open indefinitely: reply.hijack() + writeHead() have already told
      // the client "200, streaming," and nothing else will ever end it.
      if (!connectionGone()) reply.raw.end();
      resolve();
    };

    /** Re-read current state and push a data frame (if changed) or a
     * keep-alive comment (if not). Used by both the subscribe fast path
     * and the poll fallback tick. */
    const reReadAndMaybePush = async () => {
      if (closed) return;
      if (connectionGone()) {
        // Belt-and-suspenders: the "close" listener should already have
        // run cleanup(), but stop the interval/unsubscribe here too in
        // case a write-time check catches it first.
        cleanup();
        return;
      }
      let next: T;
      try {
        next = await opts.poll();
      } catch (err) {
        logger.warn({ err }, "SSE poll() failed while re-reading current state; skipping this tick");
        return;
      }
      if (closed) return;
      if (connectionGone()) {
        cleanup();
        return;
      }
      let isChanged: boolean;
      try {
        isChanged = opts.changed(lastPushed, next);
      } catch (err) {
        // Caller-supplied — must never crash this fire-and-forget tick
        // (reReadAndMaybePush is invoked as `void ...()`, so an unguarded
        // throw here would be an unhandled promise rejection). Safer
        // default: skip this tick like a poll() failure, rather than
        // guessing whether "changed" was meant.
        logger.warn({ err }, "SSE changed() threw while comparing state; skipping this tick");
        return;
      }
      if (isChanged) {
        writeData(next);
      } else {
        writeKeepAlive();
      }
    };

    req.raw.on("close", cleanup);

    void (async () => {
      let initialValue: T;
      try {
        initialValue = await opts.initial();
      } catch (err) {
        logger.warn({ err }, "SSE initial() failed; closing the connection cleanly");
        cleanup();
        return;
      }

      if (closed || connectionGone()) {
        cleanup();
        return;
      }

      writeData(initialValue);

      // writeData's own JSON.stringify guard closes the connection
      // (cleanup()) on a failure to serialize initialValue, rather than
      // throwing — so unlike the try/catches above, that failure surfaces
      // as `closed` becoming true rather than a caught exception here. Bail
      // out the same way the two blocks above do, or subscribe()/setInterval
      // below would register a listener and a timer against an already-torn
      // -down connection that nothing will ever clear.
      if (closed) return;

      try {
        unsubscribe = opts.subscribe(() => {
          void reReadAndMaybePush();
        });
      } catch (err) {
        // Caller-supplied — same reasoning as opts.initial() failing: no
        // upstream error handler is left once reply.hijack() has run, so
        // close cleanly rather than let this propagate as an unhandled
        // rejection out of this unawaited IIFE. The poll fallback alone
        // (started below) would otherwise still work without a subscribe
        // path, but a THROWING subscribe implementation is a caller bug
        // worth surfacing/closing over, not silently limping on without
        // the fast path.
        logger.warn({ err }, "SSE subscribe() threw while establishing the fast path; closing the connection cleanly");
        cleanup();
        return;
      }

      interval = setInterval(() => {
        void reReadAndMaybePush();
      }, pollIntervalMs);
    })();
  });
}
