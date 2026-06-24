/**
 * Bybit BSC confirmation tracker — a read-only BscScan-compatible block-
 * explorer poller giving a REAL on-chain confirmation count for orders the
 * deposit poller (bybitBscDeposit.ts) has already matched to a still-
 * confirming Bybit BSC deposit (PAYMENT_DETECTED/CONFIRMING).
 *
 * Display-only, by construction: this module's only DB writes are
 * `recordBybitBscConfirmationProgress`/`recordBybitBscTrackingFailed`
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
import {
  prisma,
  listTrackedBybitBscOrders,
  recordBybitBscConfirmationProgress,
  recordBybitBscTrackingFailed,
  enqueueOrderPipelineFailed,
  resolveBybitBscTrackerConfig,
  type BybitBscTrackerConfig,
} from "@app/db";
import { renderBybitBscTrackingScreen } from "../util/format";
import { bybitBscTrackingKb } from "../keyboards/customer";
import { createBackoffGate } from "./pollBackoff";

type TrackedOrder = Awaited<ReturnType<typeof listTrackedBybitBscOrders>>[number];

/** Consecutive not-found lookups for the SAME order before escalating to
 * FAILED. In-memory (per process) — a restart resets the grace period,
 * an acceptable simplification given the alternative (persisting a counter
 * on the order row) buys little for a rare edge case. */
export const MAX_CONSECUTIVE_LOOKUP_FAILURES = 10;

class RateLimitedError extends Error {}

interface BscScanProxyResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** One BscScan "proxy" (Ethereum JSON-RPC passthrough) call. Throws
 * RateLimitedError on 429/403 or an in-body rate-limit error message. */
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
  const res = await fetch(`${cfg.apiBase}?${query}`);
  if (res.status === 429 || res.status === 403) {
    throw new RateLimitedError(`BscScan rate limited (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`BscScan ${action} HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as BscScanProxyResponse;
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

const backoff = createBackoffGate();
const lookupFailureCounts = new Map<number, number>();

export async function pollOnce(api: Api): Promise<void> {
  if (backoff.shouldSkip()) return;

  const cfg = await resolveBybitBscTrackerConfig(prisma);
  const orders = await listTrackedBybitBscOrders(prisma);
  if (!orders.length) return;

  for (const order of orders) {
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
        const failed = await recordBybitBscTrackingFailed(prisma, { orderId: order.id, reason });
        if (failed) {
          logger.warn(`Bybit BSC order ${order.orderCode} escalated to FAILED — transaction ${order.bybitTxid} never appeared on-chain after ${failures} consecutive lookups`);
          // Durable admin alert via the outbox (this poller has no web
          // context, but the outbox is the established convention for every
          // FAILED escalation regardless of which path triggered it).
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

let timer: ReturnType<typeof setTimeout> | undefined;
let isRunning = false;
let stopped = false;

export function startPolling(api: Api): void {
  stopped = false;
  const intervalMs = config.BYBIT_BSC_TRACKER_POLL_INTERVAL_SECONDS * 1000;
  const tick = async () => {
    if (stopped) return;
    if (!isRunning) {
      isRunning = true;
      try {
        await pollOnce(api);
      } catch (err) {
        logger.error({ err }, "Bybit BSC confirmation tracker poll cycle threw an unhandled error — the cycle was aborted, polling resumes on the next tick");
      } finally {
        isRunning = false;
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  logger.info(`Bybit BSC confirmation tracker poller active (every ${config.BYBIT_BSC_TRACKER_POLL_INTERVAL_SECONDS}s)`);
  timer = setTimeout(tick, intervalMs);
}

export function stopPolling(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
}

/** Fire an extra poll cycle right now, on top of the normal timer — shares
 * the timer loop's `isRunning` guard so it can't race a tick already in
 * flight. Fire-and-forget by design (never awaited, never throws). */
export function triggerImmediatePoll(api: Api): void {
  if (isRunning || stopped) return;
  isRunning = true;
  void pollOnce(api)
    .catch((err) => logger.error({ err }, "Bybit BSC confirmation tracker immediate poll threw an unhandled error — the regular timer will retry on its next tick"))
    .finally(() => {
      isRunning = false;
    });
}
