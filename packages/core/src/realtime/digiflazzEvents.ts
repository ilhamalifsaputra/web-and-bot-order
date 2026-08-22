import { EventEmitter } from "node:events";

/**
 * Process-wide pub/sub for realtime UI push (Server-Sent Events). Mirrors
 * nudge.ts's "safe no-op when nothing is subscribed" contract, but uses a
 * real EventEmitter (not nudge.ts's single overwritable callback slot)
 * because, unlike nudge.ts's one dispatcher, an arbitrary number of open
 * SSE connections (one per admin tab / storefront visitor) all need to
 * hear the same event.
 *
 * This is a LATENCY OPTIMIZATION for the single-process production
 * topology (apps/server/src/index.ts, where the web-admin app, storefront
 * app, order-bot cron jobs, and outbox dispatcher all share one process)
 * ONLY — it fires nothing at all when the emitting code (order-bot's cron
 * jobs) runs in a separate OS process from the SSE-serving Fastify app
 * (the standalone apps/order-bot/src/main.ts dev/worktree topology this
 * repo's CLAUDE.md documents). Every SSE route consuming these events
 * MUST independently poll the DB on its own short fallback interval so
 * correctness never depends on this emitter firing — see the (later,
 * not-yours) SSE route helper's own doc comment for that fallback.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0); // unbounded SSE connections is expected, not a leak

/** Fired once a catalog re-sync's outcome has been persisted (success,
 * aborted, or error) — see packages/db/src/crud/digiflazzSyncStatus.ts for
 * what "outcome" means here. Carries no payload; subscribers re-read the
 * current status themselves (getDigiflazzSyncStatus) rather than trusting
 * a stale snapshot passed through the event, since multiple emits can
 * coalesce before a slow subscriber gets scheduled. */
export function emitDigiflazzCatalogSyncChanged(): void {
  bus.emit("catalog-sync-changed");
}

/** Subscribe to catalog-sync-changed events. Returns an unsubscribe
 * function — callers (SSE route handlers) MUST call it when their
 * connection closes, or the listener leaks for the process's lifetime. */
export function onDigiflazzCatalogSyncChanged(fn: () => void): () => void {
  bus.on("catalog-sync-changed", fn);
  return () => bus.off("catalog-sync-changed", fn);
}

/** Fired once a specific order's Digiflazz dispatch status has changed
 * (claimed, delivered, failed, or rechecked) — see the digiflazzStatus/
 * digiflazzAttempts/digiflazzNextRecheckAt/digiflazzFailureDetail fields
 * on Order. Carries only the order id, for the same "subscribers re-read
 * current state themselves" reason as the catalog-sync event above. */
export function emitDigiflazzOrderStatusChanged(orderId: number): void {
  bus.emit("order-status-changed", orderId);
}

/** Subscribe to order-status-changed events for ANY order (the callback
 * receives the orderId and is responsible for filtering to the one it
 * cares about — a per-order SSE route has exactly one order id it's
 * watching). Returns an unsubscribe function; callers MUST call it on
 * connection close. */
export function onDigiflazzOrderStatusChanged(fn: (orderId: number) => void): () => void {
  bus.on("order-status-changed", fn);
  return () => bus.off("order-status-changed", fn);
}
