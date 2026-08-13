/**
 * Bybit BSC confirmation tracker — a read-only BscScan-compatible block-
 * explorer poller giving a REAL on-chain confirmation count for orders the
 * deposit poller (bybitBscDeposit.ts) has already matched to a still-
 * confirming Bybit BSC deposit (PAYMENT_DETECTED/CONFIRMING).
 *
 * Display-only, by construction: this module's only DB writes are
 * `recordBybitBscConfirmationProgress`/`recordBybitBscTrackingStale`
 * (packages/db/src/crud/bybit_bsc_deposit.ts), which never call
 * approveOrder/deliverPaidBybitBscOrder and never transition toward
 * PENDING_VERIFICATION/DELIVERED. The actual delivery gate stays
 * exclusively the deposit poller's job, keyed off Bybit's own status-3
 * report — this tracker's confirmation count can disagree with Bybit's
 * internal view (a different node, different finality assumptions) without
 * any risk of double- or under-delivery.
 *
 * Two BscScan "proxy" (Ethereum-JSON-RPC-compatible) calls per tracked order
 * per cycle:
 *   - eth_blockNumber: the chain's current head.
 *   - eth_getTransactionByHash: the tracked tx's own block number (null/
 *     missing if not yet visible to this node — NOT an error, just "not
 *     found yet"; only escalated to FAILED after a bounded number of
 *     consecutive not-found cycles for the SAME order).
 *
 * `api: Api` is threaded through pollOnce/startPolling even though this
 * module doesn't call the Bot API yet — the live bubble-edit-on-progress
 * push update is wired in alongside the Telegram tracking screen, reusing
 * this same signature rather than changing it later.
 */
import type { Api } from "grammy";
import { config } from "@app/core/config";
import { langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { fetchWithTimeoutSafe, HTTP_TIMEOUT_MS } from "@app/core/http";
import {
  prisma,
  listTrackedBybitBscOrders,
  recordBybitBscConfirmationProgress,
  recordBybitBscTrackingStale,
  enqueueOrderPipelineFailed,
  resolveBybitBscTrackerConfig,
  type BybitBscTrackerConfig,
} from "@app/db";
import { renderBybitBscTrackingScreen } from "../util/format";
import { bybitBscTrackingKb } from "../keyboards/customer";
import { createBackoffGate } from "./pollBackoff";
import { createPollLoop } from "./pollLoop";

type TrackedOrder = Awaited<ReturnType<typeof listTrackedBybitBscOrders>>[number];

/** Consecutive not-found lookups for the SAME order before flagging its
 * tracking as stale/uncertain (`recordBybitBscTrackingStale` — non-terminal,
 * M-11 fix, backend audit 2026-07-31). In-memory (per process) — a restart
 * resets the grace period, an acceptable simplification given the
 * alternative (persisting a counter on the order row) buys little for a rare
 * edge case. */
export const MAX_CONSECUTIVE_LOOKUP_FAILURES = 10;

class RateLimitedError extends Error {}

interface BscScanProxyResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * One BscScan "proxy" (Ethereum JSON-RPC passthrough) call. Throws
 * RateLimitedError on 429/403 or an in-body rate-limit error message.
 *
 * The optional BscScan API key (a free, read-only rate-limit-boost token —
 * not a real secret) rides in the query string, same shape as TokoPay/
 * PayDisini's merchant credentials. Routed through `fetchWithTimeoutSafe`
 * (`@app/core/http`) for the same reason as every other credential-bearing
 * client here: Node's fetch sometimes attaches the failed request — query
 * string included — to a rejected error's `.cause`, and this keeps that from
 * ever reaching `logger.error({ err })` in `pollOnce` below (Minor 5, Task 3
 * review follow-up).
 */
async function bscscanRpc(
  action: string,
  params: Record<string, string>,
  cfg: Pick<BybitBscTrackerConfig, "apiBase" | "apiKey">,
): Promise<unknown> {
  const query = new URLSearchParams({
    module: "proxy",
    action,
    ...params,
    ...(cfg.apiKey ? { apikey: cfg.apiKey } : {}),
  }).toString();
  const res = await fetchWithTimeoutSafe(
    `${cfg.apiBase}?${query}`,
    { timeoutMs: HTTP_TIMEOUT_MS.explorerRead },
    `BscScan ${action} request`, // never log err — the query string carries the (low-severity) API key
  );
  if (res.status === 429 || res.status === 403) {
    throw new RateLimitedError(`BscScan rate limited (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`BscScan ${action} HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  let body: BscScanProxyResponse;
  try {
    body = (await res.json()) as BscScanProxyResponse;
  } catch (err) {
    // AbortSignal.timeout stays attached to the response body in undici, so a
    // peer that sends headers and then stalls the body makes res.json()
    // reject with this same TimeoutError shape (http.ts) — distinguish that
    // from a genuinely malformed body so the tracker doesn't blame the
    // explorer for sending garbage when it actually just hung.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`BscScan ${action} response body read timed out`);
    }
    throw new Error(`BscScan ${action} returned an unparseable response`);
  }
  if (body.error) {
    const msg = body.error.message ?? "";
    if (/rate limit/i.test(msg)) throw new RateLimitedError(`BscScan ${action} rate limited: ${msg}`);
    throw new Error(`BscScan ${action} error: ${msg}`);
  }
  return body.result;
}

async function fetchLatestBlock(cfg: Pick<BybitBscTrackerConfig, "apiBase" | "apiKey">): Promise<number> {
  const result = await bscscanRpc("eth_blockNumber", {}, cfg);
  return parseInt(String(result), 16);
}

/** The tracked tx's own block number, or null if it isn't visible to this
 * node yet (tx genuinely not found, or mined-but-still-pending — both read
 * as "nothing actionable yet", never an error). */
async function fetchTxBlockNumber(txHash: string, cfg: Pick<BybitBscTrackerConfig, "apiBase" | "apiKey">): Promise<number | null> {
  const result = await bscscanRpc("eth_getTransactionByHash", { txhash: txHash }, cfg);
  if (result == null) return null;
  const blockNumber = (result as { blockNumber?: string | null }).blockNumber;
  if (blockNumber == null) return null;
  return parseInt(blockNumber, 16);
}

/** Pure: a tx in the latest block itself counts as 1 confirmation (matches
 * how most explorers display it) — hence the `+ 1`. `null` propagates
 * through (tx not yet visible). */
export function computeConfirmations(latestBlock: number, txBlock: number | null): number | null {
  if (txBlock == null) return null;
  return Math.max(0, latestBlock - txBlock + 1);
}

/** Fetch + compute in one call. Never throws for "not found" (returns
 * `null`) — only for actual HTTP/rate-limit/RPC errors. */
export async function fetchConfirmations(
  txHash: string,
  cfg: Pick<BybitBscTrackerConfig, "apiBase" | "apiKey">,
): Promise<number | null> {
  const [latestBlock, txBlock] = await Promise.all([fetchLatestBlock(cfg), fetchTxBlockNumber(txHash, cfg)]);
  return computeConfirmations(latestBlock, txBlock);
}

/** Push the live tracking screen onto the anchored payment bubble with this
 * tick's fresh confirmation count/status — same direct-edit-on-stored-bubble
 * pattern as bybitBscDeposit.ts's onDelivered()/onPaymentDetected(). Called
 * on every successful lookup (not just on a status transition): the whole
 * point of live tracking is the count visibly climbing tick to tick, and a
 * repeat edit with identical content is already a harmless no-op
 * ("message is not modified", handled by the catch below). */
async function pushTrackingUpdate(
  api: Api,
  order: TrackedOrder,
  status: string,
  confirmations: number,
  requiredConfirmations: number,
): Promise<void> {
  if (order.paymentMsgChatId == null || order.paymentMsgId == null) return;
  const lang = langCode(order.user.language);
  try {
    await api.editMessageText(
      Number(order.paymentMsgChatId),
      order.paymentMsgId,
      renderBybitBscTrackingScreen(
        { orderCode: order.orderCode, status, network: order.network, confirmations, requiredConfirmations },
        lang,
      ),
      { parse_mode: "HTML", reply_markup: bybitBscTrackingKb({ id: order.id, status }, lang) },
    );
  } catch {
    /* bubble may be gone/uneditable — the order is still reachable via My Orders */
  }
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

// ── Important #3 (Task 3 review follow-up) ──────────────────────────────────
// pollOnce calls fetchConfirmations PER TRACKED ORDER, each making 2 BscScan
// RPCs now individually bounded at HTTP_TIMEOUT_MS.explorerRead (8s). Sized
// conservatively at 2 × 8s = 16s worst case per order — fetchConfirmations
// actually fires both RPCs concurrently via Promise.all (so the tight bound
// is closer to 8s/order today), but the sum is kept as the sizing basis so
// this stays correct even if a future edit ever makes the two calls
// sequential. Against a black-holing explorer that's 16s × N per cycle with
// NO cap: at N=4 tracked orders (a plain order backlog, not an unusual
// outage) that's already 64s — past the 60s default cycleTimeoutMs — and
// growing unboundedly with N, so no single fixed deadline could ever cover
// an unbounded backlog. The real fix is bounding the WORK per cycle, not
// just moving the deadline: cap how many orders one cycle inspects, then
// size cycleTimeoutMs to comfortably cover that fixed cap.
//
// MAX_ORDERS_PER_CYCLE=8 covers a generous real-world backlog of
// simultaneously-confirming BSC deposits in one cycle; cycleTimeoutMs below
// is sized off it (8 × 16s = 128s) with a margin. Orders beyond the cap are
// simply left for a later cycle — `cycleCursor` rotates the starting point
// each cycle so every tracked order gets covered in ceil(orders.length /
// MAX_ORDERS_PER_CYCLE) cycles, not just the same head-of-list orders every
// time. This is safe to defer: this module is display-only (see the file's
// own doc-comment) — it never calls approveOrder/deliverPaidBybitBscOrder,
// so an order waiting an extra cycle or two only delays how fresh its LIVE
// confirmation-count UI looks, never its actual delivery, which stays
// exclusively gated by bybitBscDeposit.ts's own poller reading Bybit's own
// status-3 report.
export const MAX_ORDERS_PER_CYCLE = 8;
const PER_ORDER_WORST_CASE_MS = 2 * HTTP_TIMEOUT_MS.explorerRead; // 16_000 — see derivation above
const CYCLE_TIMEOUT_MARGIN_MS = 22_000; // headroom above the raw worst case, same spirit as Binance's own margin
/** MAX_ORDERS_PER_CYCLE × PER_ORDER_WORST_CASE_MS + margin = 150_000 — passed
 * to `createPollLoop` below as this rail's `cycleTimeoutMs`. */
export const TRACKER_CYCLE_TIMEOUT_MS = MAX_ORDERS_PER_CYCLE * PER_ORDER_WORST_CASE_MS + CYCLE_TIMEOUT_MARGIN_MS;

/** Return up to `count` items from `items`, starting at `start` and wrapping
 * around — a simple round-robin window so a capped-per-cycle scan still
 * covers every item over successive calls instead of always favoring the
 * same head-of-list entries. */
function rotatingSlice<T>(items: readonly T[], start: number, count: number): T[] {
  if (items.length <= count) return [...items];
  const offset = ((start % items.length) + items.length) % items.length;
  const result: T[] = [];
  for (let i = 0; i < count; i++) result.push(items[(offset + i) % items.length]!);
  return result;
}

const backoff = createBackoffGate();
const lookupFailureCounts = new Map<number, number>();
let cycleCursor = 0;

export async function pollOnce(api: Api): Promise<void> {
  if (backoff.shouldSkip()) return;

  const cfg = await resolveBybitBscTrackerConfig(prisma);
  const orders = await listTrackedBybitBscOrders(prisma);

  // An order can leave the tracked set (delivered/cancelled/expired/etc.)
  // without ever hitting the success or escalation branches below, both of
  // which are the only other places this map is cleaned up — prune those
  // stale entries here so a re-tracked order (same id, later re-detected)
  // starts its grace period over rather than inheriting a stale count.
  const trackedOrderIds = new Set(orders.map((order) => order.id));
  for (const orderId of lookupFailureCounts.keys()) {
    if (!trackedOrderIds.has(orderId)) lookupFailureCounts.delete(orderId);
  }

  if (!orders.length) return;

  const batch = rotatingSlice(orders, cycleCursor, MAX_ORDERS_PER_CYCLE);
  cycleCursor += MAX_ORDERS_PER_CYCLE;

  for (const order of batch) {
    if (!order.bybitTxid) continue; // defensive — listTrackedBybitBscOrders already filters this

    let confirmations: number | null;
    try {
      confirmations = await fetchConfirmations(order.bybitTxid, cfg);
      backoff.recordSuccess();
    } catch (err) {
      if (err instanceof RateLimitedError) {
        const { hitCount, delayMs } = backoff.recordRateLimit();
        logger.warn(`Bybit BSC confirmation tracker rate-limited (hit #${hitCount}) — backing off ${delayMs}ms, rest of this cycle skipped`);
        return; // the remaining orders this cycle would likely hit the same limit
      }
      logger.error(
        { err },
        `Bybit BSC confirmation tracker failed to look up transaction ${order.bybitTxid} for order ${order.orderCode} — will retry next cycle`,
      );
      continue; // transient explorer/network error, not "tx not found" — does not count against the grace period
    }

    if (confirmations == null) {
      const failures = (lookupFailureCounts.get(order.id) ?? 0) + 1;
      lookupFailureCounts.set(order.id, failures);
      if (failures >= MAX_CONSECUTIVE_LOOKUP_FAILURES) {
        lookupFailureCounts.delete(order.id);
        const reason = `Bybit BSC transaction ${order.bybitTxid} not found on-chain after ${failures} consecutive lookups`;
        // Non-terminal (M-11 fix, backend audit 2026-07-31): this only flags
        // the order's tracking as stale/uncertain — it does NOT transition
        // the order, so it stays in PAYMENT_DETECTED/CONFIRMING (still inside
        // PRE_DELIVERY_STATUSES) and a later genuine Bybit "Success" report
        // can still auto-deliver it. Previously this escalated straight to
        // FAILED, which permanently blocked exactly that recovery path.
        const markedStale = await recordBybitBscTrackingStale(prisma, { orderId: order.id, reason });
        if (markedStale) {
          logger.warn(`Bybit BSC order ${order.orderCode} tracking is stale — transaction ${order.bybitTxid} not found on-chain after ${failures} consecutive lookups; the order stays in ${order.status} awaiting Bybit's own payment report`);
          // Durable admin alert via the outbox (this poller has no web
          // context) — same convention as every other pipeline-alert path.
          await enqueueOrderPipelineFailed(prisma, { orderId: order.id, orderCode: order.orderCode, reason }).catch(() => undefined);
        }
      }
      continue;
    }

    lookupFailureCounts.delete(order.id);
    const newStatus = await recordBybitBscConfirmationProgress(prisma, {
      orderId: order.id,
      confirmations,
      requiredConfirmations: cfg.requiredConfirmations,
    });
    if (newStatus != null) {
      await pushTrackingUpdate(api, order, newStatus, confirmations, cfg.requiredConfirmations);
    }
  }
}

// ---------------------------------------------------------------------------
// Self-scheduling loop (guards against overlapping runs) — mirrors
// bybitBscDeposit.ts's own shape exactly.
// ---------------------------------------------------------------------------

// Set by startPolling()/triggerImmediatePoll() before the loop's `run` ever
// fires — the loop itself starts `stopped`, so `run` can never be invoked
// while this is still undefined.
let boundApi: Api | undefined;

// No `onCycleTimeout` here, unlike the three crypto deposit pollers above:
// this tracker has a backoff gate but no poll-health heartbeat row of its
// own to mark as failed (display-only module — see the module doc-comment).
// Inventing a bespoke DB write for that here would be scope creep beyond
// this task's pure scheduler-wiring change; a real tracker heartbeat is a
// gap left for a later hardening task. (The three QRIS reconcilers already
// got their own heartbeats + watchdogs in Task 11/12 of this branch — this
// tracker's own missing heartbeat is now the one deliberately-out-of-scope
// gap left, for the reason given above.)
//
// cycleTimeoutMs is TRACKER_CYCLE_TIMEOUT_MS, sized off MAX_ORDERS_PER_CYCLE's
// own worst case (see its derivation above `pollOnce`) — 150s (Important #3,
// Task 3 review follow-up). Without the explicit value here the default
// `max(3 * intervalMs, 60_000)` = 60s would abandon a cycle mid-batch even at
// the now-bounded worst case.
// `run` deliberately does not thread through pollLoop.ts's `isCurrent()`
// (Task 11 review follow-up, Important #1 / Finding A): this tracker writes
// no poll-health heartbeat at all (display-only module, see the file's own
// doc-comment above), so there is nothing here a stale post-abandon write
// could retroactively mark healthy — `isCurrent()` exists to guard exactly
// that write, and this rail has none. A rail's `run` ignoring the parameter
// is explicitly safe per pollLoop.ts's own contract.
const loop = createPollLoop({
  name: "Bybit BSC confirmation tracker",
  intervalMs: config.BYBIT_BSC_TRACKER_POLL_INTERVAL_SECONDS * 1000,
  cycleTimeoutMs: TRACKER_CYCLE_TIMEOUT_MS,
  run: () => pollOnce(boundApi!),
});

export function startPolling(api: Api): void {
  boundApi = api;
  logger.info(`Bybit BSC confirmation tracker poller active (every ${config.BYBIT_BSC_TRACKER_POLL_INTERVAL_SECONDS}s)`);
  loop.start();
}

export function stopPolling(): void {
  loop.stop();
}

/** Fire an extra poll cycle right now, on top of the normal timer — shares
 * the loop's overlap guard so it can't race a cycle already in flight.
 * Fire-and-forget by design (never awaited, never throws). A no-op before
 * startPolling() has run (the loop starts stopped) — the only callers
 * (checkout.ts) are reachable only after main.ts's boot has already called
 * startPolling() synchronously. */
export function triggerImmediatePoll(api: Api): void {
  boundApi = api;
  loop.triggerNow();
}
