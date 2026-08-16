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
import { Decimal } from "@app/core/money";
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
  clearOrderPaymentMessage,
  type BybitConfig,
  type BybitDeliverResult,
} from "@app/db";
import { coreT } from "../util/i18n";
import { esc } from "../util/format";
import { isPermanentBubbleEditFailure } from "../util/bubbleEditFailure";
import { matchByAmount, matchUnderpaidByAmount, AMOUNT_TOLERANCE, parsePositiveAmount } from "./amountMatching";
import { createBackoffGate } from "./pollBackoff";
import { createPollLoop } from "./pollLoop";
import { withTimeout, TELEGRAM_MESSAGE_TIMEOUT_MS, TELEGRAM_DOCUMENT_TIMEOUT_MS } from "./telegramTimeout";
import type { InlineKeyboard } from "grammy";
import { sendAccountFile, settledPaymentBubble, settledPaymentKb } from "../util/delivery";

/** Bybit internal-deposit status: 1=Processing, 2=Success, 3=Failed (per
 * Bybit V5 docs — DIFFERS from the on-chain ledger, where 3=success). Deliver
 * only on Success. */
const STATUS_SUCCESS = 2;

export interface BybitDeposit {
  txId: string;
  amount: Decimal; // positive = received, in USDT
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
  } catch (err) {
    // AbortSignal.timeout stays attached to the response body in undici, so a
    // peer that sends headers and then stalls the body makes res.json()
    // reject with this same TimeoutError shape (http.ts) — distinguish that
    // from a genuinely malformed body so lastError doesn't blame the gateway
    // for sending garbage when it actually just hung.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Bybit ${path} response body read timed out`);
    }
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
  // Bybit reports amount as a decimal STRING — parse it directly with
  // Decimal instead of round-tripping through Number(), which loses
  // precision. parsePositiveAmount also absorbs a malformed string as a
  // skipped row instead of a thrown exception — see its doc-comment in
  // amountMatching.ts.
  const amount = parsePositiveAmount(raw.amount);
  const coin = String(raw.coin ?? "").toUpperCase();
  const status = Number(raw.status);
  if (txId == null || amount == null) return null; // received only
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

/**
 * Edit the anchored bubble to `text`/`markup` and report whether the order's
 * anchor may now be dropped. Never throws — a rejected bubble edit is caught
 * right here instead of propagating to the `withTimeout` race each call site
 * wraps this in, which is what lets that race keep meaning exactly one thing
 * ("the call hung past the deadline") rather than two.
 *
 * Returns "keep_anchor" for a failure that a later attempt could get past
 * (flood control, a 5xx, a network fault, anything unrecognised) so
 * `sweepPaidOrderBubbles` (jobs/index.ts) retries the edit within a minute —
 * the anchor is the ONLY thing that lists this order for that sweep, so
 * dropping it here would strand the buyer on a stale payment screen for good.
 * Returns "clear_anchor" when the edit succeeded, or when Telegram said this
 * bubble can never accept it (T1: a bubble the buyer deleted must self-heal
 * instead of costing the sweeper a slot every minute forever) —
 * `isPermanentBubbleEditFailure` (util/bubbleEditFailure.ts) draws that line
 * once for all five call sites that hold this contract.
 */
async function editAnchoredBubble(
  api: Api,
  orderCode: string,
  chatId: number,
  messageId: number,
  text: string,
  markup: InlineKeyboard,
): Promise<"clear_anchor" | "keep_anchor"> {
  try {
    await api.editMessageText(chatId, messageId, text, { parse_mode: "HTML", reply_markup: markup });
  } catch (err) {
    if (!isPermanentBubbleEditFailure(err)) {
      logger.warn(
        { err },
        `Bybit deposit poller could not flip order ${orderCode}'s payment bubble, and Telegram's answer does not rule out the same edit succeeding later (flood control, a server error, or a network fault) — its anchor is left in place on purpose so the paid-order bubble sweep retries the edit within a minute`,
      );
      return "keep_anchor";
    }
    /* bubble gone/uneditable for good — the credential or processing direct message already informed the buyer */
  }
  return "clear_anchor";
}

async function onDelivered(api: Api, order: DeliveredOrder): Promise<void> {
  // Web-only buyers have no Telegram chat — skip all DMs for them.
  if (order.user.telegramId == null) return;

  const lang = langCode(order.user.language);
  const tgId = Number(order.user.telegramId);

  // Non-null only for a WALLET_TOPUP order — the anchored-bubble edit below
  // uses this neutral status text instead of a success sentence: the buyer's
  // actual "top-up successful" DM (amount + new balance + order code) comes
  // exclusively from the outbox, enqueued once inside settleWalletTopup —
  // see that function's own doc-comment. Duplicating that sentence here as a
  // direct DM is exactly what used to double-notify a buyer whose top-up
  // settled through both this poller AND the outbox. Computed up front
  // (pure, no Telegram call) because the bubble flip below now runs BEFORE
  // the nudge/delivery step (Task E3).
  const topupBubbleText = order.kind === OrderKind.WALLET_TOPUP ? settledPaymentBubble(order).text : null;

  // Turn the payment-instructions bubble into a success message in place,
  // then clear the anchor pointer — BEFORE the nudge/delivery step below
  // (Task E3): the buyer's chat must show "Payment received" first, not
  // after their account file/top-up notice, or it reads as "the shop sent my
  // account before I paid" even though nothing was ever delivered early
  // (approveOrder's atomic claim gates every credential send — this was
  // purely a message-ordering artefact). The outbox dispatcher's own
  // payment-bubble flush hook (packages/core/src/nudge.ts) is the structural
  // backstop if this still loses the race (e.g. a slow Telegram edit), but
  // the ordering here should teach the right lesson regardless.
  //
  // Keep it for anything that could still work on a later attempt.
  // editAnchoredBubble never throws (it catches and classifies the
  // rejection itself), so `outcome` here is its own clear/keep verdict or
  // "timeout", the one case it cannot see. Bounded at
  // TELEGRAM_MESSAGE_TIMEOUT_MS so a stuck edit call can't stall the
  // credential send that follows below, let alone the poller past its own
  // tick.
  if (order.paymentMsgChatId != null && order.paymentMsgId != null) {
    const outcome = await withTimeout(
      editAnchoredBubble(
        api,
        order.orderCode,
        Number(order.paymentMsgChatId),
        order.paymentMsgId,
        topupBubbleText ?? coreT("checkout.internal_paid", lang, { code: order.orderCode }),
        // Keyboard by order kind through the shared picker, so a top-up bubble
        // this rail flips carries the wallet keyboard — the same one
        // `settledPaymentBubble` gives it when the Refresh button or the
        // sweeper gets there first (util/delivery.ts). For a WALLET_TOPUP,
        // the text above is shared too — it's `settledPaymentBubble`'s own
        // text, set as `topupBubbleText` earlier in this function. Only the
        // PRODUCT-order fallback text (`checkout.internal_paid`, right
        // above) stays this rail's own.
        settledPaymentKb(order.kind, lang),
      ),
      TELEGRAM_MESSAGE_TIMEOUT_MS,
    );
    if (outcome === "timeout") {
      logger.warn(`Bybit deposit poller gave up waiting on the bubble edit for order ${order.orderCode} after ${TELEGRAM_MESSAGE_TIMEOUT_MS}ms — the edit was not cancelled and may still land on its own; if it does not, the anchor stays put and the background bubble sweep retries it`);
    } else if (outcome === "clear_anchor") {
      await clearOrderPaymentMessage(prisma, order.id);
    }
  }

  if (order.kind === OrderKind.WALLET_TOPUP) {
    // There is nothing to deliver here — settleWalletTopup already credited
    // the wallet and enqueued the buyer's outbox DM. Nudge the dispatcher so
    // it wakes immediately instead of waiting for its next poll tick — but
    // only when a dispatcher is registered in THIS process
    // (`registerOutboxNudge`, packages/core/src/nudge.ts): the combined
    // server (apps/server/src/index.ts) runs one, so the claim holds there,
    // but the standalone order-bot binary (apps/order-bot/src/main.ts) does
    // not, and nudging is then a no-op — the DM still goes out, just on the
    // notifier process's own next poll tick.
    nudgeOutboxDispatcher();
  } else {
    // Delivery is instant: send the account file straight away. Bounded at
    // TELEGRAM_DOCUMENT_TIMEOUT_MS — a document upload is legitimately
    // slower than a plain text call (see telegramTimeout.ts), but still must
    // not fall back to grammY's 500s default.
    try {
      const outcome = await withTimeout(sendAccountFile(api, tgId, order, lang), TELEGRAM_DOCUMENT_TIMEOUT_MS);
      if (outcome === "timeout") throw new Error(`Account file upload timed out after ${TELEGRAM_DOCUMENT_TIMEOUT_MS}ms`);
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
  // Clear the anchor pointer unless the edit timed out, or failed in a way a
  // later attempt could get past — same edit-then-decide contract
  // onDelivered's own bubble edit makes above. Bounded at
  // TELEGRAM_MESSAGE_TIMEOUT_MS — see the identical bubble edit in
  // onDelivered above for why.
  const outcome = await withTimeout(
    editAnchoredBubble(
      api,
      order.orderCode,
      Number(order.paymentMsgChatId),
      order.paymentMsgId,
      coreT("checkout.internal_paid", lang, { code: order.orderCode }),
      // Same shared keyboard picker as onDelivered above. A PROCESSING order
      // is always a product sale, so this is `paymentSuccessKb` in practice —
      // routed through the picker anyway so the two edits in this file can
      // never drift apart.
      settledPaymentKb(order.kind, lang),
    ),
    TELEGRAM_MESSAGE_TIMEOUT_MS,
  );
  if (outcome === "timeout") {
    logger.warn(`Bybit deposit poller gave up waiting on the "processing" bubble edit for order ${order.orderCode} after ${TELEGRAM_MESSAGE_TIMEOUT_MS}ms — the edit was not cancelled and may still land on its own; if it does not, the anchor stays put and the background bubble sweep retries it`);
  } else if (outcome === "clear_anchor") {
    await clearOrderPaymentMessage(prisma, order.id);
  }
}

/** Send `text` to every configured admin, never throwing. Bounded as ONE
 * composite operation at TELEGRAM_MESSAGE_TIMEOUT_MS regardless of how many
 * admins are configured (same shape tokopayReconcile.ts's own alertAdmins
 * call site uses) — a slow/hung admin can't block the rest of the cycle, at
 * the accepted cost that some admins may not get notified if the whole loop
 * doesn't finish inside the budget. */
async function alertAdmins(api: Api, text: string): Promise<void> {
  const outcome = await withTimeout(alertAdminsInner(api, text), TELEGRAM_MESSAGE_TIMEOUT_MS);
  if (outcome === "timeout") {
    logger.warn(`Bybit deposit poller gave up waiting on an admin alert after ${TELEGRAM_MESSAGE_TIMEOUT_MS}ms — some admins may not have been notified`);
  }
}

async function alertAdminsInner(api: Api, text: string): Promise<void> {
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
          logger.warn(`Bybit order ${underpaidOrder.orderCode} underpaid — received ${dep.amount.toString()}, expected ${underpaidOrder.totalAmount.toString()}, flagged UNDERPAID for manual review`);
          await alertAdmins(
            api,
            `⚠️ Underpaid Bybit order <code>${underpaidOrder.orderCode}</code>\nReceived <b>${dep.amount.toString()}</b>, expected <b>${underpaidOrder.totalAmount.toString()}</b> (tx ${esc(dep.txId)}).`,
          );
        }
        continue;
      }
      if (await recordUnmatchedBybitTx(prisma, { bybitTxId: dep.txId, amount: dep.amount })) {
        logger.info(`No pending order matched Bybit deposit ${dep.txId} (amount: ${dep.amount.toString()}) — left for manual review`);
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

// ── Finding #2 (followup-review-fixes-2) ────────────────────────────────────
// This rail used to pass no explicit cycleTimeoutMs, falling back to
// createPollLoop's default `max(3 * intervalMs, 60_000)` = 60s at the 5s
// default BYBIT_POLL_INTERVAL_SECONDS. That was never actually safe: before
// this task, processDeposits' Telegram calls (sendAccountFile, alertAdmins,
// the bubble edits) were all UNBOUNDED, so one slow call could hang past ANY
// deadline. Now that every one of them is bounded (see telegramTimeout.ts and
// onDelivered/editBubbleToProcessing/alertAdmins above), an explicit deadline
// derived from real arithmetic replaces the default:
//
//   FETCH_TIMEOUT_MS (10s) — fetchRecentDeposits makes exactly ONE signed
//     bybitGet call (no retries/fallback-mirror walk, unlike Binance),
//     bounded at HTTP_TIMEOUT_MS.gatewayRead.
//   + WORST_CASE_CONCURRENT_DELIVERIES (10) × PER_DELIVERY_WORST_CASE_MS (15s)
//     — processDeposits loops over every fetched deposit; the single most
//     expensive branch per deposit is a fresh non-topup delivery: one
//     TELEGRAM_DOCUMENT_TIMEOUT_MS (10s) sendAccountFile upload, THEN one
//     TELEGRAM_MESSAGE_TIMEOUT_MS (5s) bubble edit = 15s. `10` is a
//     deliberately generous "real-world simultaneous-delivery backlog"
//     assumption, the same style bybitBscConfirmationTracker.ts's own
//     MAX_ORDERS_PER_CYCLE=8 uses (see its derivation comment) — NOT the raw
//     `limit: "50"` fetchRecentDeposits asks Bybit for. Multiplying by 50
//     would produce a ~790s deadline that blows past HALF of Bybit BSC's own
//     15-minute payment window (see bybitBscDeposit.ts's identical
//     derivation) for no real safety benefit: `pollLoop.ts`'s own abandon
//     deadline doesn't stop a cycle's real work — an abandoned cycle "may
//     still complete in the background" (see its module doc-comment) — it
//     only decides how fast a genuine hang gets NOTICED. A smaller, still-
//     generous deadline catches a real hang sooner without costing anything
//     on the (dominant) healthy path.
//   + CYCLE_TIMEOUT_MARGIN_MS (30s) — covers the remaining DB list/deliver
//     work each cycle, same flat margin the QRIS reconcile rails use.
//   = 10_000 + 10 * 15_000 + 30_000 = 190_000ms (190s, ~3m10s).
//
// Sanity check (poll-loop-wiring.test.ts pins this the same way it does for
// the QRIS rails): BYBIT_PAYMENT_WINDOW_MINUTES defaults to 30 (1800s); 190s
// is ~11% of that, comfortably under half.
const FETCH_TIMEOUT_MS = HTTP_TIMEOUT_MS.gatewayRead;
const WORST_CASE_CONCURRENT_DELIVERIES = 10;
const PER_DELIVERY_WORST_CASE_MS = TELEGRAM_DOCUMENT_TIMEOUT_MS + TELEGRAM_MESSAGE_TIMEOUT_MS;
export const BYBIT_CYCLE_TIMEOUT_MS =
  FETCH_TIMEOUT_MS + WORST_CASE_CONCURRENT_DELIVERIES * PER_DELIVERY_WORST_CASE_MS + 30_000;

const loop = createPollLoop({
  name: "Bybit Internal Transfer deposit",
  intervalMs: config.BYBIT_POLL_INTERVAL_SECONDS * 1000,
  cycleTimeoutMs: BYBIT_CYCLE_TIMEOUT_MS,
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
  }).catch((err) =>
    // Mandatory, not defensive tidiness — see the identical guard in
    // tokopayReconcile.ts's startPolling for why an unhandled rejection here
    // would take the whole bot process down at boot.
    logger.warn({ err }, "Could not read the Bybit deposit configuration for the startup log, so this boot has no line saying whether that poller is on or idle, and no unique-cents warning if it applies — the poller itself is unaffected, since it re-reads its configuration at the top of every cycle"),
  );
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
