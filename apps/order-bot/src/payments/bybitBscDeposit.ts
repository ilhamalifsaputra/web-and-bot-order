/**
 * Bybit BSC on-chain (BEP20) deposit auto-confirmation — a second, separate
 * Bybit rail alongside bybitDeposit.ts's Internal Transfer.
 *
 * Buyers send USDT on-chain (BEP20/BSC network) to our Bybit-custodied
 * deposit address. A polling loop (every BYBIT_BSC_POLL_INTERVAL_SECONDS,
 * independent of both the Binance and Bybit Internal Transfer pollers' own
 * intervals) pulls recent on-chain deposits from Bybit, matches each to a
 * PENDING order by its UNIQUE amount (BEP20 carries no memo either), and
 * auto-delivers via the normal approve path. Unlike Internal Transfer, this
 * needs a real blockchain-confirmation wait (~1-2 min) before Bybit reports
 * it as credited — that floor is exchange-side and not something this poller
 * can shrink; the only latency lever available is `triggerImmediatePoll`
 * (an extra poll right after order creation, on top of the normal timer).
 *
 * Rate-limit hits (429/403/retCode 10006/10018) use a bounded exponential
 * backoff (`pollBackoff.ts`, base 3s doubling to a 30s cap, reset on the next
 * successful call) instead of a flat fixed delay — a flat delay re-arms on
 * every consecutive hit and can stack into multi-minute outages.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 * The ONLY Bybit endpoint this module calls is
 * GET /v5/asset/deposit/query-record (signed, read-only). It never touches
 * trading or withdrawal endpoints. Use a Wallet-read-only API key (no
 * Withdraw permission) — the SAME key/secret as Internal Transfer (same
 * exchange account, shared credentials).
 *
 * The row mapping in `normalizeOnchainDeposit()` stays isolated so the
 * endpoint/fields can be swapped without touching matching/delivery.
 */
import { createHmac } from "node:crypto";
import type { Api } from "grammy";
import { config } from "@app/core/config";
import { adminIds } from "@app/core/runtime";
import { langCode, OrderStatus, NotificationEvent } from "@app/core/enums";
import { logger } from "@app/core/logger";
import {
  prisma,
  listInFlightBybitBscOrders,
  deliverPaidBybitBscOrder,
  recordBybitBscPaymentDetected,
  recordUnmatchedBybitBscTx,
  recordBybitBscPollHealth,
  resolveBybitBscConfig,
  enqueueNotification,
  type BybitBscConfig,
  type BybitBscDeliverResult,
} from "@app/db";
import { coreT } from "../util/i18n";
import { esc, renderBybitBscTrackingScreen } from "../util/format";
import { matchByAmount } from "./binanceInternal";
import { createBackoffGate } from "./pollBackoff";
import { paymentSuccessKb, bybitBscTrackingKb } from "../keyboards/customer";
import { sendAccountFile } from "../util/delivery";

// USDT itself has no on-chain "gas deducted from the sent amount" semantics
// the way native-coin transfers do, so the same tight tolerance Internal
// Transfer uses is appropriate here too. Revisit with real data if on-chain
// deposits show wider variance in practice.
const AMOUNT_TOLERANCE = 0.001; // USDT
/** Bybit on-chain deposit status codes (per Bybit V5 docs — DIFFERS from the
 * internal-transfer ledger, where 2=success). This is now load-bearing for
 * PAYMENT_DETECTED/CONFIRMING tracking, not just an FYI — re-verify the full
 * status enum against current Bybit V5 docs before relying on any code
 * other than these three. Anything outside this set (e.g. an unknown or
 * failure code) is treated as "nothing actionable yet" and skipped, same as
 * before this change. */
const STATUS_TO_BE_CONFIRMED = 1;
const STATUS_PROCESSING = 2;
const STATUS_SUCCESS = 3;
const IN_FLIGHT_BYBIT_STATUSES: ReadonlySet<number> = new Set([
  STATUS_TO_BE_CONFIRMED,
  STATUS_PROCESSING,
  STATUS_SUCCESS,
]);

export interface BybitBscDeposit {
  txId: string;
  amount: number; // positive = received, in USDT
  /** Raw Bybit V5 deposit status. Used to decide PAYMENT_DETECTED/CONFIRMING
   * (still confirming) vs. an actual delivery (status 3, "Success"). */
  bybitStatus: number;
}

type InFlightOrder = Awaited<ReturnType<typeof listInFlightBybitBscOrders>>[number];

// ---------------------------------------------------------------------------
// Signed Bybit V5 REST (read-only)
// ---------------------------------------------------------------------------

class RateLimitedError extends Error {}

/** Bybit V5 GET auth: HMAC-SHA256(secret, timestamp + apiKey + recvWindow + queryString). */
async function bybitGet(path: string, params: Record<string, string>, cfg: BybitBscConfig): Promise<Record<string, unknown>> {
  const key = cfg.apiKey;
  const secret = cfg.apiSecret;
  const recv = "5000";
  const ts = String(Date.now());
  const query = new URLSearchParams(params).toString();
  const sign = createHmac("sha256", secret).update(ts + key + recv + query).digest("hex");
  const res = await fetch(`${cfg.apiBase}${path}?${query}`, {
    headers: {
      "X-BAPI-API-KEY": key,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": recv,
      "X-BAPI-SIGN": sign,
    },
  });
  // Bybit returns its rate-limit budget on every response (not just 429s) —
  // logging it gives empirical data on real headroom instead of guessing.
  const limit = res.headers.get("X-Bapi-Limit");
  const limitStatus = res.headers.get("X-Bapi-Limit-Status");
  if (limit != null || limitStatus != null) {
    logger.debug(
      `Bybit ${path} reported its rate-limit budget — limit ${limit}, ${limitStatus} remaining, ` +
        `resets at ${res.headers.get("X-Bapi-Limit-Reset-Timestamp")}`,
    );
  }
  if (res.status === 429 || res.status === 403) {
    throw new RateLimitedError(`Bybit rate limited (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`Bybit ${path} HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { retCode?: number; retMsg?: string; result?: Record<string, unknown> };
  if (body.retCode !== 0) {
    // 10006/10018 = rate limit on the V5 retCode layer.
    if (body.retCode === 10006 || body.retCode === 10018) throw new RateLimitedError(`Bybit retCode ${body.retCode}`);
    throw new Error(`Bybit ${path} retCode ${body.retCode}: ${body.retMsg ?? ""}`);
  }
  return body.result ?? {};
}

/** Map a raw on-chain deposit row to our normalized shape (the swappable
 * bit). Keeps still-confirming rows (status 1/2) as well as SUCCESS (status
 * 3) — the still-confirming ones feed PAYMENT_DETECTED/CONFIRMING tracking,
 * never delivery (see `bybitStatus` on the returned shape). Exported so a
 * fixture test can pin the real Bybit payload shape. The on-chain endpoint
 * can return deposits across multiple chains for the same coin, so `chain`
 * is filtered against the configured chain (default "BSC") — unlike
 * Internal Transfer, which has no chain concept at all. The destination
 * `address` is also checked when present, as a defense-in-depth check
 * alongside the primary amount match (belt-and-suspenders, not the primary
 * disambiguator). */
export function normalizeOnchainDeposit(raw: Record<string, unknown>, cfg: Pick<BybitBscConfig, "chain" | "depositAddress">): BybitBscDeposit | null {
  const txId = raw.txID ?? raw.id;
  const amount = Number(raw.amount);
  const coin = String(raw.coin ?? "").toUpperCase();
  const status = Number(raw.status);
  const chain = String(raw.chain ?? "").toUpperCase();
  const address = raw.address != null ? String(raw.address) : null;
  if (txId == null || !Number.isFinite(amount) || amount <= 0) return null; // received only
  if (coin !== config.CURRENCY.toUpperCase()) return null;
  if (!IN_FLIGHT_BYBIT_STATUSES.has(status)) return null; // unknown/failed → nothing actionable yet
  if (chain !== cfg.chain.toUpperCase()) return null; // deposit on a different chain — never match
  if (address && cfg.depositAddress && address.toLowerCase() !== cfg.depositAddress.toLowerCase()) return null;
  return { txId: String(txId), amount, bybitStatus: status };
}

/** Fetch recent successful on-chain USDT deposits (last 3 days).
 * Throws RateLimitedError on 429/403/retCode rate limits. */
async function fetchRecentDeposits(cfg: BybitBscConfig): Promise<BybitBscDeposit[]> {
  const result = await bybitGet("/v5/asset/deposit/query-record", {
    coin: config.CURRENCY,
    startTime: String(Date.now() - 3 * 24 * 60 * 60 * 1000),
    limit: "50",
  }, cfg);
  const rows = (result.rows ?? []) as Record<string, unknown>[];
  return rows.map((r) => normalizeOnchainDeposit(r, cfg)).filter((d): d is BybitBscDeposit => d !== null);
}

// ---------------------------------------------------------------------------
// Delivery side-effects (DM buyer + edit the payment bubble)
// ---------------------------------------------------------------------------

type DeliveredOrder = Extract<BybitBscDeliverResult, { status: "delivered" }>["order"];

async function onDelivered(api: Api, order: DeliveredOrder): Promise<void> {
  // Web-only buyers have no Telegram chat — skip all DMs for them.
  if (order.user.telegramId == null) return;

  const lang = langCode(order.user.language);
  const tgId = Number(order.user.telegramId);

  try {
    await sendAccountFile(api, tgId, order, lang);
  } catch (err) {
    logger.error(
      { err },
      `Failed to DM the account file for order ${order.orderCode} — enqueuing outbox retry so the buyer still receives their credentials`,
    );
    try {
      await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED_DM, order.id, {
        chat_id: tgId,
        order_code: order.orderCode,
      });
    } catch (eq) {
      logger.error({ err: eq }, `Failed to enqueue outbox fallback for order ${order.orderCode} — buyer may not receive credentials without manual admin resend`);
    }
  }

  // Turn the payment-instructions bubble into a success message in place.
  if (order.paymentMsgChatId != null && order.paymentMsgId != null) {
    try {
      await api.editMessageText(
        Number(order.paymentMsgChatId),
        order.paymentMsgId,
        coreT("checkout.bybit_bsc_paid", lang, { code: order.orderCode }),
        { parse_mode: "HTML", reply_markup: paymentSuccessKb(lang) },
      );
    } catch {
      /* bubble may be gone/uneditable — the credential DM already informed the buyer */
    }
  }
}

/** Push the live tracking screen onto the anchored payment bubble right when
 * a deposit is first detected (PENDING_PAYMENT -> PAYMENT_DETECTED). Same
 * direct-edit-on-stored-bubble pattern as `onDelivered()` above — bot-
 * process-direct, never via notification_outbox (that rule is about never
 * sending Telegram from web code; an in-process poller calling the Bot API
 * directly is the pattern every poller in this file already uses). */
async function onPaymentDetected(api: Api, order: InFlightOrder, network: string): Promise<void> {
  if (order.paymentMsgChatId == null || order.paymentMsgId == null) return;
  const lang = langCode(order.user.language);
  try {
    await api.editMessageText(
      Number(order.paymentMsgChatId),
      order.paymentMsgId,
      renderBybitBscTrackingScreen(
        { orderCode: order.orderCode, status: OrderStatus.PAYMENT_DETECTED, network, confirmations: null, requiredConfirmations: null },
        lang,
      ),
      { parse_mode: "HTML", reply_markup: bybitBscTrackingKb({ id: order.id, status: OrderStatus.PAYMENT_DETECTED }, lang) },
    );
  } catch {
    /* bubble may be gone/uneditable — the order is still reachable via My Orders */
  }
}

async function alertAdmins(api: Api, text: string): Promise<void> {
  for (const adminId of adminIds()) {
    try {
      await api.sendMessage(adminId, text, { parse_mode: "HTML" });
    } catch (err) {
      logger.error({ err }, `Failed to send admin alert to admin ${adminId} — they will not see this notification in Telegram`);
    }
  }
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

const backoff = createBackoffGate();

export async function pollOnce(api: Api): Promise<void> {
  const cfg = await resolveBybitBscConfig(prisma);
  if (!cfg.enabled) return;
  // BEP20 carries no memo — amount is the ONLY disambiguator. Without
  // USE_UNIQUE_CENTS, distinct orders can land on identical totals, and a
  // deposit paying that shared amount becomes a confused-deputy risk (it
  // could be misattributed to whichever single order still happens to be
  // the only pending one at that total). Refuse to match by amount at all
  // rather than degrade — deposits fall through to "unmatched" for manual
  // review, which is always safe, instead of a live (re-checked every poll
  // tick, no restart needed) hard gate.
  if (!config.USE_UNIQUE_CENTS) {
    logger.error("Bybit BSC deposit auto-confirm is enabled but USE_UNIQUE_CENTS is OFF — refusing to match deposits by amount this cycle. Set USE_UNIQUE_CENTS=1.");
    return;
  }
  if (backoff.shouldSkip()) return;

  let deposits: BybitBscDeposit[];
  try {
    deposits = await fetchRecentDeposits(cfg);
  } catch (err) {
    const rateLimited = err instanceof RateLimitedError;
    if (rateLimited) {
      const { hitCount, delayMs } = backoff.recordRateLimit();
      logger.warn(`Bybit BSC rate-limited (hit #${hitCount}) — backing off ${delayMs}ms`);
    } else {
      logger.error({ err }, "Failed to fetch recent Bybit BSC deposits — this poll cycle is skipped, pending orders stay unmatched until the next cycle");
    }
    await recordBybitBscPollHealth(prisma, {
      lastTxCount: 0,
      backoffUntil: backoff.backoffUntil || null,
      consecutiveRateLimitHits: backoff.hitCount,
      rateLimited,
      success: false,
      error: String(err).slice(0, 300),
    }).catch(() => undefined);
    return;
  }

  backoff.recordSuccess();
  const now = new Date();
  // In-flight, not just PENDING_PAYMENT: a still-confirming deposit already
  // tied to an order on a previous cycle (PAYMENT_DETECTED/CONFIRMING) must
  // still be re-matchable by its own txid this cycle (gap #1 fix) — if this
  // queried PENDING_PAYMENT only, that order would vanish from the list the
  // moment it left PENDING_PAYMENT, and the same deposit would wrongly fall
  // through to "no candidate -> unmatched" on every later cycle.
  const orders = await listInFlightBybitBscOrders(prisma, now);
  if (deposits.length) logger.info(`Bybit BSC poll fetched ${deposits.length} deposit(s) against ${orders.length} in-flight order(s)`);
  await recordBybitBscPollHealth(prisma, { lastTxCount: deposits.length, backoffUntil: null, success: true }).catch(() => undefined);

  await processDeposits(api, deposits, orders, cfg.chain);
}

/**
 * Match a batch of fetched deposits against in-flight orders and act on
 * each. A deposit already tied to an order (its `bybitTxid`) from a
 * previous cycle is re-matched by that txid, never by amount again (gap #1
 * fix). A genuinely new deposit is matched by UNIQUE amount (BEP20 has no
 * memo) against orders that haven't seen one yet — on a collision (≥2
 * candidates) or no candidate it is recorded "unmatched" and left for
 * manual review, never guessed, but ONLY once Bybit reports it as Success;
 * a still-confirming no-match deposit is simply skipped this cycle; a later
 * deposit/order may yet resolve it, and claiming the ledger row before
 * knowing which order (if any) it belongs to would be premature. Extracted
 * from pollOnce so it can be integration-tested against the real DB without
 * the API/env gate.
 */
export async function processDeposits(
  api: Api,
  deposits: BybitBscDeposit[],
  orders: InFlightOrder[],
  network: string,
): Promise<void> {
  const pendingOnly = orders.filter((o) => o.status === OrderStatus.PENDING_PAYMENT);
  for (const dep of deposits) {
    const order =
      orders.find((o) => o.bybitTxid === dep.txId) ??
      matchByAmount({ amount: dep.amount }, pendingOnly, AMOUNT_TOLERANCE);

    if (!order) {
      if (dep.bybitStatus === STATUS_SUCCESS) {
        if (await recordUnmatchedBybitBscTx(prisma, { bybitTxId: dep.txId, amount: dep.amount })) {
          logger.info(`No pending order matched Bybit BSC deposit ${dep.txId} (amount: ${dep.amount}) — left for manual review`);
        }
      }
      continue;
    }

    if (dep.bybitStatus !== STATUS_SUCCESS) {
      // Still confirming — record/refresh PAYMENT_DETECTED only. Never
      // claims the delivery ledger; that stays exclusively the branch below.
      // Only push a bubble edit the cycle this ACTUALLY transitions — a
      // deposit still sitting at PAYMENT_DETECTED on a later cycle (or
      // already advanced to CONFIRMING by the tracker) must not keep
      // re-editing the bubble back to "just detected".
      const justDetected = await recordBybitBscPaymentDetected(prisma, { orderId: order.id, bybitTxId: dep.txId, network });
      if (justDetected) await onPaymentDetected(api, order, network);
      continue;
    }

    try {
      const r = await deliverPaidBybitBscOrder(prisma, { orderId: order.id, bybitTxId: dep.txId, amount: dep.amount });
      if (r.status === "delivered") {
        logger.info(`Delivered Bybit BSC order ${order.orderCode} (deposit ${dep.txId})`);
        await onDelivered(api, r.order);
      } else if (r.status === "stale") {
        logger.warn(`Bybit BSC deposit ${dep.txId} matched order ${order.orderCode} but it was no longer in a deliverable state — skipped to avoid double delivery, admin alerted`);
        await alertAdmins(api, `⚠️ Bybit BSC deposit matched <code>${order.orderCode}</code> but it was no longer pending (tx ${esc(dep.txId)}).`);
      }
    } catch (err) {
      logger.error({ err }, `Bybit BSC order ${order.orderCode} was paid (deposit ${dep.txId}) but delivery threw — admin alerted for manual action`);
      await alertAdmins(api, `⚠️ Paid but delivery FAILED for <code>${order.orderCode}</code> tx ${esc(dep.txId)} — ${esc(String(err).slice(0, 200))}. Manual action needed.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Self-scheduling loop (guards against overlapping runs)
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | undefined;
let isRunning = false;
let stopped = false;

export function startPolling(api: Api): void {
  stopped = false;
  const intervalMs = config.BYBIT_BSC_POLL_INTERVAL_SECONDS * 1000;
  const tick = async () => {
    if (stopped) return;
    if (!isRunning) {
      isRunning = true;
      try {
        await pollOnce(api);
      } catch (err) {
        logger.error({ err }, "Bybit BSC poll cycle threw an unhandled error — the cycle was aborted, polling resumes on the next tick");
      } finally {
        isRunning = false;
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  // The loop always runs and self-gates each cycle on resolveBybitBscConfig().enabled,
  // so enabling Bybit BSC in web-admin Settings takes effect without a restart. The
  // boot log just reports the CURRENT state.
  void resolveBybitBscConfig(prisma).then((cfg) => {
    if (!cfg.enabled) {
      logger.info("Bybit BSC deposit auto-confirm disabled (no deposit address/API creds in Settings or .env) — poller idle");
      return;
    }
    // Amount matching can only disambiguate orders when their totals are distinct.
    // With Bybit BSC on but unique-cents off, two buyers owing the same amount become
    // unmatchable (refused, not mis-delivered) — auto-confirm silently degrades.
    if (!config.USE_UNIQUE_CENTS) {
      logger.warn(
        "⚠ Bybit BSC deposit auto-confirm is ENABLED but USE_UNIQUE_CENTS is OFF — " +
          "BEP20 has no memo, so equal-total orders cannot be matched by amount. " +
          "Set USE_UNIQUE_CENTS=1 so every order has a distinct total.",
      );
    }
    logger.info(`Bybit BSC deposit poller active (every ${config.BYBIT_BSC_POLL_INTERVAL_SECONDS}s)`);
  });
  timer = setTimeout(tick, intervalMs);
}

export function stopPolling(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
}

/**
 * Fire an extra poll cycle right now, on top of the normal timer — called
 * right after a fresh order is anchored so its very first check doesn't wait
 * up to BYBIT_BSC_POLL_INTERVAL_SECONDS for the next scheduled tick. This is
 * a pure latency optimization: the real floor on this rail is the on-chain
 * confirmation Bybit itself requires (~1-2 min), which this cannot shrink —
 * it only removes the poll-interval delay layered on top of that floor.
 * Fire-and-forget by design (never awaited, never throws) and shares the
 * timer loop's `isRunning` guard so it can't race a tick already in flight.
 */
export function triggerImmediatePoll(api: Api): void {
  if (isRunning || stopped) return;
  isRunning = true;
  void pollOnce(api)
    .catch((err) => logger.error({ err }, "Bybit BSC immediate poll (triggered right after order creation) threw an unhandled error — the regular timer will retry on its next tick"))
    .finally(() => {
      isRunning = false;
    });
}
