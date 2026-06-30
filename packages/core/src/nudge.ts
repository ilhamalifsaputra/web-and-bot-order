/**
 * Process-wide wakeup hook for the outbox dispatcher.
 *
 * `registerOutboxNudge` is called by `runDispatcher` at the start of each
 * interruptible sleep so callers can break out of it immediately.
 * `nudgeOutboxDispatcher` is called by webhook handlers and reconcile pollers
 * right after they enqueue an ORDER_DELIVERED_DM row — skipping the poll
 * interval and delivering the account DM in under a second instead of up to
 * NOTIF_POLL_INTERVAL_SECONDS.
 *
 * Safe when no dispatcher is running (standalone bot binary, tests): nudge()
 * is a no-op because wakeUp is null.
 */
let wakeUp: (() => void) | null = null;

/** Wake the dispatcher's current sleep immediately, if one is in progress. */
export function nudgeOutboxDispatcher(): void {
  wakeUp?.();
}

/**
 * Register the resolve callback for the dispatcher's current sleep.
 * Pass `null` to clear the registration after the sleep resolves.
 */
export function registerOutboxNudge(fn: (() => void) | null): void {
  wakeUp = fn;
}
