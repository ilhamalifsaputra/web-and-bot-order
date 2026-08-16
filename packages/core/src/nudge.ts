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

/**
 * Process-wide hook that lets `packages/outbox-dispatcher` ask the bot
 * process to finish flipping an order's payment bubble to its settled state
 * right before it sends an order-scoped settlement DM (Task E3).
 *
 * The bug this exists to close: nothing is ever delivered before payment —
 * every credential send is gated by `approveOrder`'s atomic claim
 * (`packages/db/src/crud/orders.ts`) — but a buyer could still SEE their
 * account file arrive before the "Payment received" bubble edit, purely a
 * message-ordering artefact. A QRIS bubble is a photo, so flipping it is a
 * delete-then-send (two Telegram calls), while the credential DM is one —
 * so the fast path (`nudge(); flip();`, one call already made) could land
 * its DM before the flip's own two calls finished, however each rail's own
 * fast path ordered its two steps. Reordering every poller/webhook/admin-
 * approval call site narrows the gap but cannot close it for the two paths
 * that never share a process with a bot `Api` at all: the storefront
 * webhooks (forbidden from touching Telegram) and admin manual approval —
 * both rely entirely on the background sweeper (`sweepPaidOrderBubbles`,
 * apps/order-bot/src/jobs/index.ts) to flip their bubble, on its own cron
 * tick, with no relationship to when the DM goes out. This hook is the
 * structural fix that covers every path at once, by running exactly where
 * every path's DM already funnels through: the outbox dispatcher.
 *
 * `packages/outbox-dispatcher` must not depend on `apps/order-bot` — the
 * code that actually knows how to read an order and edit a Telegram message
 * lives there — so this mirrors `registerOutboxNudge` above exactly: only
 * `apps/server`'s combined process (the one process that ever runs both the
 * dispatcher and a bot `Api` instance) registers the real implementation,
 * once at boot; the dispatcher only ever calls the registered function
 * through this file, never `apps/order-bot` directly.
 *
 * Safe when nothing is registered (a standalone notifier process, or a
 * test): `flushPaymentBubble` is then a no-op, exactly like
 * `nudgeOutboxDispatcher` above.
 */
let flushBubble: ((orderId: number) => Promise<void>) | null = null;

/**
 * Ask the registered implementation (if any) to finish flipping `orderId`'s
 * payment bubble. No-op when nothing is registered. Whether this rejects
 * depends entirely on the registered function — see that function's own
 * contract; `packages/outbox-dispatcher`'s own call sites additionally bound
 * and swallow this, so a hung or failing flush can never block or fail the
 * settlement DM it precedes.
 */
export async function flushPaymentBubble(orderId: number): Promise<void> {
  await flushBubble?.(orderId);
}

/**
 * Register the payment-bubble flush implementation. Pass `null` to clear it
 * (mirrors `registerOutboxNudge`'s own reset-to-null convention, though
 * unlike that hook this one is registered once at boot and never cleared in
 * production — the `null` case exists for tests).
 */
export function registerPaymentBubbleFlush(fn: ((orderId: number) => Promise<void>) | null): void {
  flushBubble = fn;
}
