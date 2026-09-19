/**
 * Logging — pino replacement for Python stdlib logging + RotatingFileHandler.
 * An AsyncLocalStorage carries the current Telegram update_id so every log
 * line emitted while processing an update is tagged (mirrors the PTB group -2
 * `bind_update_id` middleware / contextvar).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";
import { config } from "./config";

export const updateCtx = new AsyncLocalStorage<{ updateId?: number }>();

/**
 * Telegram API errors (grammY's GrammyError) carry the request params in
 * `payload` — delivered credentials and manual delivery text included. Detected
 * by shape so core never imports grammy. Applied to every serialized error in
 * the tree (wrappers via `error`, `aggregateErrors`); `cause` is already
 * flattened by pino into message/stack only.
 */
function stripPayload(node: unknown, depth = 0, seen = new Set<object>()): void {
  // Depth cap: an error may carry a large object graph (e.g. a grammY ctx).
  if (depth > 5 || typeof node !== "object" || node === null || seen.has(node)) return;
  seen.add(node);
  // A serialized error is a fresh object we own; plain objects may be caller data.
  if (Object.getPrototypeOf(node) !== Object.prototype && "payload" in node && "method" in node) {
    delete (node as { payload?: unknown }).payload;
  }
  for (const v of Object.values(node)) stripPayload(v, depth + 1, seen);
}

/** pino's default `err` serializer minus Telegram request payloads. */
export function safeErr(err: unknown): unknown {
  const out = pino.stdSerializers.err(err as Error);
  stripPayload(out);
  return out;
}

export function createLogger(dest?: pino.DestinationStream) {
  return pino(
    {
      level: config.LOG_LEVEL,
      base: undefined, // drop pid/hostname noise
      serializers: { err: safeErr },
      mixin: () => {
        const updateId = updateCtx.getStore()?.updateId;
        return updateId === undefined ? {} : { updateId };
      },
    },
    dest,
  );
}

export const logger = createLogger();

/** Run `fn` with the given update_id bound to the logging context. */
export function withUpdateId<T>(updateId: number | undefined, fn: () => T): T {
  return updateCtx.run({ updateId }, fn);
}
