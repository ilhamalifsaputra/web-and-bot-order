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

export const logger = pino({
  level: config.LOG_LEVEL,
  base: undefined, // drop pid/hostname noise
  mixin: () => {
    const updateId = updateCtx.getStore()?.updateId;
    return updateId === undefined ? {} : { updateId };
  },
});

/** Run `fn` with the given update_id bound to the logging context. */
export function withUpdateId<T>(updateId: number | undefined, fn: () => T): T {
  return updateCtx.run({ updateId }, fn);
}
