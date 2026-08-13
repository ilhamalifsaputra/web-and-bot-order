/**
 * Bybit Internal Transfer (UID→UID, off-chain, instant) deposit auto-confirmation.
 *
 * Buyers send USDT via Bybit's own "Internal Transfer" (Bybit account to Bybit
 * account, no blockchain hop) to our shared Bybit UID. A polling loop (every
 * BYBIT_POLL_INTERVAL_SECONDS, independent of the Binance poller's interval)
 * pulls recent internal deposits from Bybit, matches each to a PENDING order
 * by its UNIQUE amount (internal transfers carry no memo), and auto-delivers
 * via the normal approve path. Unlike the old on-chain BEP20 path, there is no
 * blockchain-confirmation wait — delivery is effectively instant.
 *
 * Rate-limit hits (429/403/retCode 10006/10018) use a bounded exponential
 * backoff (`pollBackoff.ts`, base 3s doubling to a 30s cap, reset on the next
 * successful call) instead of a flat fixed delay — a flat delay re-arms on
 * every consecutive hit and can stack into multi-minute outages.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 * The ONLY Bybit endpoint this module calls is
 * GET /v5/asset/deposit/query-internal-record (signed, read-only). It never
 * touches trading or withdrawal endpoints. Use a Wallet-read-only API key (no
 * Withdraw permission). A live probe (scripts/bybit-internal-probe.ts)
 * confirmed the internal-deposit status mapping per Bybit V5 docs DIFFERS from
 * the on-chain ledger: 1=Processing, 2=Success, 3=Failed (on-chain uses 3 for
 * success) — deliver only on status 2.
 *
 * The row mapping in `normalizeInternalDeposit()` stays isolated so the
 * endpoint/fields can be swapped without touching matching/delivery.
 */
import { createHmac } from "node:crypto";
import type { Api } from "grammy";
import { config } from "@app/core/config";
import { adminIds } from "@app/core/runtime";
import { langCode, NotificationEvent, OrderKind } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { fetchWithTimeoutSafe, HTTP_TIMEOUT_MS } from "@app/core/http";
import { nudgeOutboxDispatcher } from "@app/core/nudge";
import {
  prisma,
  listPendingBybitOrders,
  deliverPaidBybitOrder,
  markUnderpaidBybit,
  recordUnmatchedBybitTx,
  recordBybitPollHealth,
  resolveBybitConfig,
  enqueueNotification,
  getUser,
  type BybitConfig,
  type BybitDeliverResult,
} from "@app/db";
import { coreT } from "../util/i18n";
import { esc } from "../util/format";
import { matchByAmount, matchUnderpaidByAmount, AMOUNT_TOLERANCE } from "./amountMatching";
import { createBackoffGate } from "./pollBackoff";
import { createPollLoop } from "./pollLoop";
import { paymentSuccessKb } from "../keyboards/customer";
import { sendAccountFile, walletTopupSuccessText } from "../util/delivery";

/** Bybit internal-deposit status: 1=Processing, 2=Success, 3=Failed (per
 * Bybit V5 docs — DIFFERS from the on-chain ledger, where 3=success). Deliver
 * only on Success. */
const STATUS_SUCCESS = 2;

export interface BybitDeposit {
  txId: string;
  amount: number; // positive = received, in USDT
}

type PendingOrder = Awaited<ReturnType<typeof listPendingBybitOrders>>[number];

// ---------------------------------------------------------------------------
// Signed Bybit V5 REST (read-only)
// ---------------------------------------------------------------------------

class RateLimitedError extends Error {}

/**
 * Bybit V5 GET auth: HMAC-SHA256(secret, timestamp + apiKey + recvWindow + queryString).
 * The credential rides in a header (X-BAPI-API-KEY), not the query string —
 * but Node's fetch sometimes attaches the failed request, headers included,
 * to a rejected error's `.cause`. `fetchWithTimeoutSafe` (`@app/core/http`)
 * catches any rejection (network failure OR the `timeoutMs` deadline
 * elapsing) and rethrows a fresh, static-message Error before it can escape,
 * so a naive `logger.error({ err })` downstream never sees the header.
 */
async function bybitGet(path: string, params: Record<string, string>, cfg: BybitConfig): Promise<Record<string, unknown>> {
  const key = cfg.apiKey;
  const secret = cfg.apiSecret;
  const recv = "5000";
  const ts = String(Date.now());
  const query = new URLSearchParams(params).toString();
  const sign = createHmac("sha256", secret).update(ts + key + recv + query).digest("hex");
  const res = await fetchWithTimeoutSafe(
    `${cfg.apiBase}${path}?${query}`,
    {
      headers: {
        "X-BAPI-API-KEY": key,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": recv,
        "X-BAPI-SIGN": sign,
      },
      timeoutMs: HTTP_TIMEOUT_MS.gatewayRead, // poller — the next tick retries if this is slow
    },
    `Bybit ${path} request`, // never log err — it may carry the X-BAPI-API-KEY header
  );
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
  let body: { retCode?: number; retMsg?: string; result?: Record<string, unknown> };
  try {
    body = (await res.json()) as { retCode?: number; retMsg?: string; result?: Record<string, unknown> };
  } catch {
    throw new Error(`Bybit ${path} returned an unparseable response`);
  }
  if (body.retCode !== 0) {
    // 10006/10018 = rate limit on the V5 retCode layer.
    if (body.retCode === 10006 || body.retCode === 10018) throw new RateLimitedError(`Bybit retCode ${body.retCode}`);
    throw new Error(`Bybit ${path} retCode ${body.retCode}: ${body.retMsg ?? ""}`);
  }
  return body.result ?? {};
}

/** Map a raw internal-deposit row to our normalized shape (the swappable bit).
 * Only SUCCESS (status 2) deposits are kept; exported so a fixture test can
 * pin the real Bybit payload shape. Internal transfers have no chain, so there
 * is no chain parameter or chain filter here (matching is amount-only). */
export function normalizeInternalDeposit(raw: Record<string, unknown>): BybitDeposit | null {
  const txId = raw.txID ?? raw.id;
  const amount = Number(raw.amount);
  const coin = String(raw.coin ?? "").toUpperCase();
  const status = Number(raw.status);
  if (txId == null || !Number.isFinite(amount) || amount <= 0) return null; // received only
  if (coin !== config.CURRENCY.toUpperCase()) return null;
  if (status !== STATUS_SUCCESS) return null; // processing/failed → skip until credited
  return { txId: String(txId), amount };
}

/** Fetch recent successful internal-transfer USDT deposits (last 3 days).
 * Throws RateLimitedError on 429/403/retCode rate limits. Exported (in
 * addition to being used by `pollOnce` below) so a test can call it directly
 * against a rejected `fetch()` and assert on the thrown Error itself — e.g.
 * that it carries no `.cause` — the same way the query-string-credential
 * gateway clients' own tests do, rather than only observing the sanitized
 * message after it's been reduced to a string in a DB health record. */
export async function fetchRecentDeposits(cfg: BybitConfig): Promise<BybitDeposit[]> {
  const result = await bybitGet("/v5/asset/deposit/query-internal-record", {
    coin: config.CURRENCY,
    startTime: String(Date.now() - 3 * 24 * 60 * 60 * 1000),
    endTime: String(Date.now()),
    limit: "50",
  }, cfg);
  const rows = (result.rows ?? []) as Record<string, unknown>[];
  return rows.map(normalizeInternalDeposit).filter((d): d is BybitDeposit => d !== null);
}

// ---------------------------------------------------------------------------
// Delivery side-effects (DM buyer + edit the payment bubble)
// ---------------------------------------------------------------------------

type DeliveredOrder = Extract<BybitDeliverResult, { status: "delivered" }>["order"];

async function onDelivered(api: Api, order: DeliveredOrder): Promise<void> {
  // Web-only buyers have no Telegram chat — skip all DMs for them.
  if (order.user.telegramId == null) return;

  const lang = langCode(order.user.language);
  const tgId = Number(order.user.telegramId);

  // Non-null only for a WALLET_TOPUP order — both the DM below and the
  // anchored-bubble edit further down reuse this exact text, so it's built
  // once and shared instead of re-fetching the fresh balance twice.
  let topupSuccessText: string | null = null;

  if (order.kind === OrderKind.WALLET_TOPUP) {
    // There is nothing to deliver here — settleWalletTopup already credited
    // the wallet, so there's no account file to send; tell the buyer what
    // was credited and their new balance instead.
    const freshUser = await getUser(prisma, order.userId);
    const newBalance = freshUser
      ? order.currency === "IDR"
        ? freshUser.walletBalance
        : freshUser.walletBalanceUsdt
      : order.totalAmount;
    topupSuccessText = walletTopupSuccessText(order, newBalance, lang);
    try {
      await api.sendMessage(tgId, topupSuccessText, { parse_mode: "HTML" });
    } catch (err) {
      logger.error({ err }, `Failed to DM the wallet top-up success message for order ${order.orderCode}`);
    }
  } else {
    // Delivery is instant: send the account file straight away.
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
  }

  // Turn the payment-instructions bubble into a success message in place.
  if (order.paymentMsgChatId != null && order.paymentMsgId != null) {
    try {
      await api.editMessageText(
        Number(order.paymentMsgChatId),
        order.paymentMsgId,
        topupSuccessText ?? coreT("checkout.internal_paid", lang, { code: order.orderCode }),
        { parse_mode: "HTML", reply_markup: paymentSuccessKb(lang) },
      );
    } catch {
      /* bubble may be gone/uneditable — the credential DM already informed the buyer */
    }
  }
}

/**
 * Flip the payment-instructions bubble to a success message for a "processing"
 * (manual-delivery) order. The buyer already gets a separate
 * ORDER_PROCESSING_DM via the outbox (enqueued by settlePaidOrder) — this only
 * keeps the anchored bubble from sitting at "waiting for payment" forever.
 * Reuses the exact same success text/keyboard onDelivered's bubble edit uses;
 * never throws.
 */
async function editBubbleToProcessing(api: Api, order: DeliveredOrder): Promise<void> {
  if (order.user.telegramId == null) return;
  if (order.paymentMsgChatId == null || order.paymentMsgId == null) return;
  const lang = langCode(order.user.language);
  try {
    await api.editMessageText(
      Number(order.paymentMsgChatId),
      order.paymentMsgId,
      coreT("checkout.internal_paid", lang, { code: order.orderCode }),
      { parse_mode: "HTML", reply_markup: paymentSuccessKb(lang) },
    );
  } catch {
    /* bubble may be gone/uneditable — the ORDER_PROCESSING_DM already informed the buyer */
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

export async function pollOnce(api: Api, isCurrent: () => boolean = () => true): Promise<void> {
  const cfg = await resolveBybitConfig(prisma);
  if (!cfg.enabled) return;
  // Internal Transfer carries no memo — amount is the ONLY disambiguator.
  // Without USE_UNIQUE_CENTS, distinct orders can land on identical totals,
  // and a deposit paying that shared amount becomes a confused-deputy risk
  // (it could be misattributed to whichever single order still happens to be
  // the only pending one at that total). Refuse to match by amount at all
  // rather than degrade — deposits fall through to "unmatched" for manual
  // review, which is always safe, instead of a live (re-checked every poll
  // tick, no restart needed) hard gate.
  if (!config.USE_UNIQUE_CENTS) {
    logger.error("Bybit deposit auto-confirm is enabled but USE_UNIQUE_CENTS is OFF — refusing to match deposits by amount this cycle. Set USE_UNIQUE_CENTS=1.");
    return;
  }
  if (backoff.shouldSkip()) return;

  let deposits: BybitDeposit[];
  try {
    deposits = await fetchRecentDeposits(cfg);
  } catch (err) {
    const rateLimited = err instanceof RateLimitedError;
    if (rateLimited) {
      const { hitCount, delayMs } = backoff.recordRateLimit();
      logger.warn(`Bybit rate-limited (hit #${hitCount}) — backing off ${delayMs}ms`);
    } else {
      logger.error({ err }, "Failed to fetch recent Bybit deposits — this poll cycle is skipped, pending orders stay unmatched until the next cycle");
    }
    // Guarded by isCurrent() (Task 11 review follow-up, Minor #3 — the same
    // rule the QRIS reconcile rails already apply to their combined write):
    // a stale write from an abandoned cycle is stale evidence either way —
    // even this `success: false` write would double-count the SAME
    // underlying failure the abandon heartbeat already recorded (once as the
    // abandon, once here) — so the abandoned cycle's own view of this
    // cycle's outcome is retired the moment it's abandoned, not just its
    // optimistic half.
    if (isCurrent()) {
      await recordBybitPollHealth(prisma, {
        lastTxCount: 0,
        backoffUntil: backoff.backoffUntil || null,
        consecutiveRateLimitHits: backoff.hitCount,
        rateLimited,
        success: false,
        error: String(err).slice(0, 300),
      }).catch(() => undefined);
    } else {
      logger.warn("Bybit poll cycle finished after its own deadline had already abandoned it — skipping the failure heartbeat write so it can't double-count the abandon-failure heartbeat already recorded");
    }
    return;
  }

  backoff.recordSuccess();
  const now = new Date();
  const orders = await listPendingBybitOrders(prisma, now);
  if (deposits.length) logger.info(`Bybit poll fetched ${deposits.length} deposit(s) against ${orders.length} pending order(s)`);
  // Task 11 review follow-up, Important #1 (Finding A): a cycle abandoned by
  // pollLoop.ts's deadline keeps running in the background and can still
  // reach this write minutes later — writing `success: true` then would
  // overwrite the abandon-failure heartbeat the deadline already recorded
  // and reset consecutiveFailures, making a hung poller read healthy.
  // isCurrent() is false once this cycle has been abandoned, so the write is
  // skipped instead.
  if (isCurrent()) {
    await recordBybitPollHealth(prisma, { lastTxCount: deposits.length, backoffUntil: null, success: true }).catch(() => undefined);
  } else {
    logger.warn("Bybit poll cycle finished after its own deadline had already abandoned it — skipping the success heartbeat write so it can't overwrite the abandon-failure heartbeat already recorded");
  }

  await processDeposits(api, deposits, orders);
}

/**
 * Match a batch of fetched deposits against pending orders and act on each.
 * Internal Transfer has no memo, so matching is by UNIQUE amount only:
 * `matchByAmount` picks the pending order with the LARGEST total the deposit
 * covers (best fit, not just "any order at or below the amount") — a buyer
 * who rounds up must still match (M-14, backend audit 2026-07-31), but only
 * up to a capped overpayment (too far above the matched order's total is
 * treated as unrelated money, not this order overpaid). On a tie at that
 * best-fit total (≥2 candidates) it is refused, never guessed. A deposit
 * that's short of every match candidate is then tried against
 * `matchUnderpaidByAmount`'s mirrored short-side search (itself floored —
 * only a plausibly-sized shortfall counts): if it's uniquely attributable to
 * one pending order there, that order is flagged UNDERPAID instead of
 * silently falling through to "unmatched". Extracted from pollOnce so it can
 * be integration-tested against the real DB without the API/env gate.
 */
export async function processDeposits(api: Api, deposits: BybitDeposit[], orders: PendingOrder[]): Promise<void> {
  for (const dep of deposits) {
    const order = matchByAmount({ amount: dep.amount }, orders, AMOUNT_TOLERANCE);
    if (!order) {
      const underpaidOrder = matchUnderpaidByAmount({ amount: dep.amount }, orders, AMOUNT_TOLERANCE);
      if (underpaidOrder) {
        if (await markUnderpaidBybit(prisma, { orderId: underpaidOrder.id, bybitTxId: dep.txId, amount: dep.amount })) {
          logger.warn(`Bybit order ${underpaidOrder.orderCode} underpaid — received ${dep.amount}, expected ${underpaidOrder.totalAmount}, flagged UNDERPAID for manual review`);
          await alertAdmins(
            api,
            `⚠️ Underpaid Bybit order <code>${underpaidOrder.orderCode}</code>\nReceived <b>${dep.amount}</b>, expected <b>${underpaidOrder.totalAmount}</b> (tx ${esc(dep.txId)}).`,
          );
        }
        continue;
      }
      if (await recordUnmatchedBybitTx(prisma, { bybitTxId: dep.txId, amount: dep.amount })) {
        logger.info(`No pending order matched Bybit deposit ${dep.txId} (amount: ${dep.amount}) — left for manual review`);
      }
      continue;
    }

    try {
      const r = await deliverPaidBybitOrder(prisma, { orderId: order.id, bybitTxId: dep.txId, amount: dep.amount });
      if (r.status === "delivered") {
        logger.info(`Matched by amount — delivered Bybit order ${order.orderCode} (deposit ${dep.txId})`);
        await onDelivered(api, r.order);
      } else if (r.status === "processing") {
        logger.info(`Bybit order ${order.orderCode} paid — queued for manual fulfilment (deposit ${dep.txId})`);
        nudgeOutboxDispatcher();
        await editBubbleToProcessing(api, r.order);
      } else if (r.status === "stale") {
        logger.warn(`Bybit deposit ${dep.txId} matched order ${order.orderCode} but it was no longer PENDING — skipped to avoid double delivery, admin alerted`);
        await alertAdmins(api, `⚠️ Bybit deposit matched <code>${order.orderCode}</code> but it was no longer pending (tx ${esc(dep.txId)}).`);
      }
    } catch (err) {
      logger.error({ err }, `Bybit order ${order.orderCode} was paid (deposit ${dep.txId}) but delivery threw — admin alerted for manual action`);
      await alertAdmins(api, `⚠️ Paid but delivery FAILED for <code>${order.orderCode}</code> tx ${esc(dep.txId)} — ${esc(String(err).slice(0, 200))}. Manual action needed.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Self-scheduling loop (guards against overlapping runs)
// ---------------------------------------------------------------------------

// Set by startPolling()/triggerImmediatePoll() before the loop's `run` ever
// fires — the loop itself starts `stopped`, so `run` can never be invoked
// while this is still undefined.
let boundApi: Api | undefined;

const loop = createPollLoop({
  name: "Bybit Internal Transfer deposit",
  intervalMs: config.BYBIT_POLL_INTERVAL_SECONDS * 1000,
  run: (isCurrent) => pollOnce(boundApi!, isCurrent),
  // A hung cycle abandoned past its deadline must still show up as a failed
  // heartbeat on the ops panel, not silence — the existing failure branch in
  // pollOnce() already writes the same shape on a fetch/HTTP error.
  onCycleTimeout: (elapsedMs) =>
    recordBybitPollHealth(prisma, {
      lastTxCount: 0,
      // Read the same module-level backoff gate the failure branch above
      // reads, so an abandoned cycle doesn't erase a live "backing off, N
      // rate-limit hits" state the panel is currently showing — the gate is
      // untouched by the timeout itself, only this heartbeat write is new.
      backoffUntil: backoff.backoffUntil || null,
      consecutiveRateLimitHits: backoff.hitCount,
      // Not a rate-limit event: this cycle timed out (hung), it wasn't told
      // by the gateway to back off. rateLimited stays false so the abandon
      // (a) doesn't stamp lastRateLimitAt with a rate-limit that didn't
      // happen, and (b) still increments consecutiveFailures — a hang is a
      // genuine failure, unlike a rate-limit hit, which deliberately leaves
      // that counter alone.
      rateLimited: false,
      success: false,
      error: `Poll cycle abandoned after ${elapsedMs}ms without finishing`,
    }).catch(() => undefined),
});

export function startPolling(api: Api): void {
  boundApi = api;
  // The loop always runs and self-gates each cycle on resolveBybitConfig().enabled,
  // so enabling Bybit in web-admin Settings takes effect without a restart. The
  // boot log just reports the CURRENT state.
  void resolveBybitConfig(prisma).then((cfg) => {
    if (!cfg.enabled) {
      logger.info("Bybit deposit auto-confirm disabled (no UID/API creds in Settings or .env) — poller idle");
      return;
    }
    // Amount matching can only disambiguate orders when their totals are distinct.
    // With Bybit on but unique-cents off, two buyers owing the same amount become
    // unmatchable (refused, not mis-delivered) — auto-confirm silently degrades.
    if (!config.USE_UNIQUE_CENTS) {
      logger.warn(
        "⚠ Bybit deposit auto-confirm is ENABLED but USE_UNIQUE_CENTS is OFF — " +
          "Internal Transfer has no memo, so equal-total orders cannot be matched by amount. " +
          "Set USE_UNIQUE_CENTS=1 so every order has a distinct total.",
      );
    }
    logger.info(`Bybit deposit poller active (every ${config.BYBIT_POLL_INTERVAL_SECONDS}s)`);
  });
  loop.start();
}

export function stopPolling(): void {
  loop.stop();
}

/**
 * Fire an extra poll cycle right now, on top of the normal timer — called
 * right after a fresh order is anchored so its very first check doesn't wait
 * up to BYBIT_POLL_INTERVAL_SECONDS for the next scheduled tick. This is a
 * pure latency optimization: it never lowers the confirmation bar, just
 * shrinks the window before the first check happens. Fire-and-forget by
 * design (never awaited, never throws) and shares the loop's overlap guard
 * so it can't race a cycle already in flight. A no-op before startPolling()
 * has run (the loop starts stopped) — the only callers (checkout.ts,
 * walletTopup.ts) are reachable only after main.ts's boot has already called
 * startPolling() synchronously.
 */
export function triggerImmediatePoll(api: Api): void {
  boundApi = api;
  loop.triggerNow();
}
