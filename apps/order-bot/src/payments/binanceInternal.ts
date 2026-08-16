/**
 * Binance Internal Transfer (UID-based) auto-confirmation.
 *
 * Buyers send USDT to our Binance UID with the order's `paymentRef` as the note.
 * A polling loop pulls recent incoming transfers from Binance, matches them to
 * PENDING orders by note + amount, and auto-delivers via the normal approve path.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 * The ONLY Binance endpoint this module calls is GET /sapi/v1/pay/transactions
 * (signed, read-only). It never touches trading or withdrawal endpoints. Use a
 * read-only API key.
 *
 * ⚠ NOTE FIELD: a live probe (scripts/binance-probe.ts) confirmed the endpoint
 * returns C2C transfers but with an EMPTY `note` on historical rows — i.e. the
 * buyer memo may not surface here. Matching therefore has two layers: (1) note →
 * paymentRef (primary, once a memo'd test transfer confirms the field), and
 * (2) a unique-amount fallback (matchByAmount) so auto-confirm still works when
 * the note is absent. The row mapping in `normalizeTx()` stays isolated so the
 * endpoint/fields can be swapped without touching matching/delivery.
 *
 * Rate-limit hits (429/418) use a bounded exponential backoff (`pollBackoff.ts`,
 * base 3s doubling to a 30s cap, reset on the next successful call) instead of
 * a flat fixed delay — a flat delay re-arms on every consecutive hit and can
 * stack into multi-minute outages.
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
  listPendingInternalOrders,
  deliverPaidInternalOrder,
  markUnderpaid,
  recordUnmatchedTx,
  recordBinancePollHealth,
  resolveBinanceInternalConfig,
  enqueueNotification,
  clearOrderPaymentMessage,
  type BinanceInternalConfig,
  type DeliverResult,
} from "@app/db";
import { coreT } from "../util/i18n";
import { esc } from "../util/format";
import { isPermanentBubbleEditFailure } from "../util/bubbleEditFailure";
import { createBackoffGate } from "./pollBackoff";
import { createPollLoop } from "./pollLoop";
import { sendAccountFile, settledPaymentBubble, settledPaymentKb } from "../util/delivery";
import {
  AMOUNT_TOLERANCE,
  noteMatches,
  classifyTx,
  matchByAmount,
  matchUnderpaidByAmount,
  overpaymentCap,
  parsePositiveAmount,
} from "./amountMatching";

// Task 13: the pure amount-matching functions (noteMatches, classifyTx,
// matchByAmount, matchUnderpaidByAmount, overpaymentCap, AMOUNT_TOLERANCE)
// now live in ./amountMatching.ts, Decimal-based end to end, shared with
// both Bybit rails. Re-exported here so this module's own existing import
// path (`../src/payments/binanceInternal`, used by binance-internal.test.ts)
// stays valid.
export { AMOUNT_TOLERANCE, noteMatches, classifyTx, matchByAmount, matchUnderpaidByAmount, overpaymentCap };

export interface BinanceTx {
  txId: string;
  note: string;
  amount: Decimal; // positive = received, in `currency`
  currency: string;
}

type PendingOrder = Awaited<ReturnType<typeof listPendingInternalOrders>>[number];

// ---------------------------------------------------------------------------
// Signed Binance REST (read-only)
// ---------------------------------------------------------------------------

function sign(query: string, apiSecret: string): string {
  return createHmac("sha256", apiSecret).update(query).digest("hex");
}

class RateLimitedError extends Error {}

/** First value that is a non-empty string after trimming, else "". Used because
 * `??` only skips null/undefined — an empty-string `note` must fall through. */
function firstNonEmpty(...vals: unknown[]): string {
  for (const v of vals) {
    const s = (v == null ? "" : String(v)).trim();
    if (s) return s;
  }
  return "";
}

/** Map a raw pay/transactions row to our normalized shape (the swappable bit).
 * Exported for the fixture test that pins the real Binance payload shape. */
export function normalizeTx(raw: Record<string, unknown>): BinanceTx | null {
  const txId = raw.transactionId ?? raw.transactionGroupId ?? raw.id;
  // Binance reports amount as a decimal STRING — parse it directly with
  // Decimal instead of round-tripping through Number(), which loses
  // precision. parsePositiveAmount also absorbs a malformed string (e.g. a
  // thousands separator) as a skipped row instead of a thrown exception —
  // see its doc-comment in amountMatching.ts.
  const amount = parsePositiveAmount(raw.amount);
  const currency = String(raw.currency ?? raw.asset ?? "");
  // Buyer memo: try the known memo-carrying fields, skipping empty strings.
  // NB: `orderId` is Binance's OWN id (not our paymentRef) — never use it here.
  const note = firstNonEmpty(raw.note, raw.remark, raw.message);
  if (txId == null || amount == null) return null; // received only
  return { txId: String(txId), note, amount, currency };
}

const CONNECT_RETRY_ATTEMPTS = 3;
const CONNECT_RETRY_DELAY_MS = 1500;
// Applied to fallback-mirror attempts (see fallThroughMirrors), shorter than
// the primary host's own gatewayRead budget: bounds the worst case once
// there are multiple mirrors to walk through, so an unreachable host fails
// fast instead of eating a full gatewayRead-sized wait per mirror.
const FALLBACK_CONNECT_TIMEOUT_MS = 8_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One signed GET against /sapi/v1/pay/transactions against a given host. Split
 * out of fetchIncomingTransfers so each retry/fallback attempt gets a fresh
 * timestamp/signature (Binance rejects a stale timestamp outside recvWindow).
 * The signature covers only the query string, never the host, so calling this
 * against a mirror host is safe. `timeoutMs` defaults to `HTTP_TIMEOUT_MS.gatewayRead`
 * for the primary host; fallback-mirror attempts (see fallThroughMirrors)
 * pass the shorter `FALLBACK_CONNECT_TIMEOUT_MS` explicitly. Either way the
 * call is now bounded — before this task the primary host relied on
 * undici's implicit (much longer) default, unlike the mirror path.
 *
 * The credential rides in a header (X-MBX-APIKEY), not the query string —
 * the same shape Bybit and NOWPayments have (Important #1, Task 3 review
 * follow-up: Binance was the one header-credential client this task left
 * unwrapped). Routed through `fetchWithTimeoutSafe` (`@app/core/http`) so a
 * rejected fetch()'s `.cause` — which Node's fetch sometimes populates with
 * the failed request, headers included — never reaches `requestWithRetries`'
 * warn log or `fetchIncomingTransfers`' `logger.error({ err })` / poll-health
 * heartbeat below.
 */
async function requestIncomingTransfers(
  cfg: BinanceInternalConfig,
  apiBase: string,
  timeoutMs: number = HTTP_TIMEOUT_MS.gatewayRead,
): Promise<Response> {
  const params = new URLSearchParams({
    startTime: String(Date.now() - 60 * 60 * 1000),
    limit: "100",
    timestamp: String(Date.now()),
    recvWindow: "5000",
  });
  const qs = params.toString();
  const url = `${apiBase}/sapi/v1/pay/transactions?${qs}&signature=${sign(qs, cfg.apiSecret)}`;
  return fetchWithTimeoutSafe(
    url,
    { headers: { "X-MBX-APIKEY": cfg.apiKey }, timeoutMs },
    "Binance pay/transactions request", // never log err — it may carry the X-MBX-APIKEY header
  );
}

/** Up to CONNECT_RETRY_ATTEMPTS tries against ONE host, CONNECT_RETRY_DELAY_MS
 * apart — re-resolves DNS from scratch each attempt, so a one-off bad answer
 * rarely survives three tries. Throws the last connect error if every attempt
 * against this host fails. */
async function requestWithRetries(cfg: BinanceInternalConfig, apiBase: string): Promise<Response> {
  let connectErr: unknown;
  for (let attempt = 1; attempt <= CONNECT_RETRY_ATTEMPTS; attempt++) {
    try {
      return await requestIncomingTransfers(cfg, apiBase);
    } catch (err) {
      connectErr = err;
      if (attempt < CONNECT_RETRY_ATTEMPTS) {
        logger.warn(`Binance connect attempt ${attempt} failed, retrying — ${(err as Error).message}`);
        await sleep(CONNECT_RETRY_DELAY_MS);
      }
    }
  }
  throw connectErr;
}

/**
 * Walk cfg.apiBaseFallbacks (official Binance mirror hosts) one attempt each,
 * after the primary host's own retry budget is exhausted. Stops at the first
 * connect-level success and logs which mirror recovered the cycle (visible in
 * production if this ever actually fires). Rethrows the PRIMARY's error (more
 * informative than the last mirror's) if every fallback also fails, or there
 * are none configured — preserving today's exact error/behavior when
 * BINANCE_API_BASE_FALLBACKS is empty.
 */
async function fallThroughMirrors(cfg: BinanceInternalConfig, primaryErr: unknown): Promise<Response> {
  for (const mirror of cfg.apiBaseFallbacks) {
    try {
      const res = await requestIncomingTransfers(cfg, mirror, FALLBACK_CONNECT_TIMEOUT_MS);
      logger.warn(`Binance primary host unreachable — recovered via fallback mirror ${mirror}`);
      return res;
    } catch {
      // try the next mirror
    }
  }
  throw primaryErr;
}

/**
 * Fetch recent incoming transfers (last hour). Throws RateLimitedError on
 * 429/418. Retries a couple of times on a connect-level failure against the
 * PRIMARY host (cfg.apiBase) — see requestWithRetries. Only once that budget
 * is exhausted does it walk cfg.apiBaseFallbacks (official Binance mirror
 * hosts), one attempt per fallback, stopping at the first connect-level
 * success — automatic in-cycle escalation, not a config swap an admin has to
 * make by hand. HTTP-level responses (including 429/418) are never retried/
 * escalated here; those already have their own handling below / in
 * pollOnce's backoff (an HTTP error from a host that DID connect is not a
 * connectivity problem the fallback list can fix).
 */
export async function fetchIncomingTransfers(cfg: BinanceInternalConfig): Promise<BinanceTx[]> {
  let res: Response;
  try {
    res = await requestWithRetries(cfg, cfg.apiBase);
  } catch (primaryErr) {
    res = await fallThroughMirrors(cfg, primaryErr);
  }

  if (res.status === 429 || res.status === 418) {
    throw new RateLimitedError(`Binance rate limited (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`Binance pay/transactions HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  let body: { data?: Record<string, unknown>[] };
  try {
    body = (await res.json()) as { data?: Record<string, unknown>[] };
  } catch (err) {
    // AbortSignal.timeout stays attached to the response body in undici, so a
    // peer that sends headers and then stalls the body makes res.json()
    // reject with this same TimeoutError shape (http.ts) — distinguish that
    // from a genuinely malformed body so lastError doesn't blame the gateway
    // for sending garbage when it actually just hung.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("Binance pay/transactions response body read timed out");
    }
    // A 200 with an unparseable body (HTML error page, truncated response, …)
    // — turn the raw SyntaxError into a readable failure so this cycle fails
    // cleanly (logged + a failed heartbeat, see pollOnce's catch) instead of
    // an opaque "Unexpected token < in JSON" bubbling up.
    throw new Error("Binance pay/transactions returned an unparseable response");
  }
  const rows = body.data ?? [];
  return rows
    .map(normalizeTx)
    .filter((t): t is BinanceTx => t !== null && t.currency.toUpperCase() === cfg.currency.toUpperCase());
}

// ---------------------------------------------------------------------------
// Delivery side-effects (DM buyer + edit the payment bubble)
// ---------------------------------------------------------------------------

type DeliveredOrder = Extract<DeliverResult, { status: "delivered" }>["order"];

async function onDelivered(api: Api, order: DeliveredOrder): Promise<void> {
  // Web-only buyers have no Telegram chat — skip all DMs for them.
  if (order.user.telegramId == null) return;

  const lang = langCode(order.user.language);
  const tgId = Number(order.user.telegramId);

  // Non-null only for a WALLET_TOPUP order — the anchored-bubble edit further
  // down uses this neutral status text instead of a success sentence: the
  // buyer's actual "top-up successful" DM (amount + new balance + order code)
  // now comes exclusively from the outbox, enqueued once inside
  // settleWalletTopup — see that function's own doc-comment. Duplicating that
  // sentence here as a direct DM is exactly what used to double-notify a
  // buyer whose top-up settled through both this poller AND the outbox.
  let topupBubbleText: string | null = null;

  if (order.kind === OrderKind.WALLET_TOPUP) {
    // There is nothing to deliver here — settleWalletTopup already credited
    // the wallet and enqueued the buyer's outbox DM. Nudge the dispatcher so
    // it wakes immediately instead of waiting for its next poll tick — but
    // only when a dispatcher is registered in THIS process
    // (`registerOutboxNudge`, packages/core/src/nudge.ts): the combined
    // server (apps/server/src/index.ts) runs one, so the claim holds there,
    // but the standalone order-bot binary (apps/order-bot/src/main.ts) does
    // not, and nudging is then a no-op — the DM still goes out, just on the
    // notifier process's own next poll tick. Also give the bubble the same
    // neutral "payment received" text every other settled top-up gets.
    nudgeOutboxDispatcher();
    topupBubbleText = settledPaymentBubble(order).text;
  } else {
    // Delivery is instant: skip the interim "payment verified / being prepared"
    // notice and send the account file straight away.
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

  // Turn the payment-instructions bubble into a success message in place, then
  // clear the anchor pointer. The edit never throws out of here — the buyer's
  // credentials have already been delivered, so a bubble problem must not
  // interrupt anything — but WHY it failed decides whether the anchor goes:
  // see editAnchoredBubbleAndDecide below.
  if (order.paymentMsgChatId != null && order.paymentMsgId != null) {
    await editAnchoredBubbleAndDecide(api, order, {
      chatId: Number(order.paymentMsgChatId),
      messageId: order.paymentMsgId,
      text: topupBubbleText ?? coreT("checkout.internal_paid", lang, { code: order.orderCode }),
      lang,
      what: "success",
    });
  }
}

/**
 * Edit one anchored bubble to `text`, then clear the order's anchor — unless
 * the failure looks like one a later attempt could get past.
 *
 * Clearing the anchor takes the order out of `sweepPaidOrderBubbles`'s work
 * queue (jobs/index.ts) for good, so it may only happen once the edit either
 * succeeded or failed for a reason that will never change. A flood-controlled
 * or network-faulted edit keeps its anchor so that sweep retries it within a
 * minute; a bubble the buyer deleted drops its anchor and stops consuming a
 * slot in every future sweep. `isPermanentBubbleEditFailure`
 * (util/bubbleEditFailure.ts) is where that line is drawn, shared with the two
 * Bybit rails, the two QRIS reconcile rails, the generic sweeper and the
 * Refresh button so all six agree.
 *
 * Never throws: the buyer already has their credentials (or their
 * ORDER_PROCESSING_DM), so nothing about the bubble is worth failing delivery
 * over.
 */
async function editAnchoredBubbleAndDecide(
  api: Api,
  order: DeliveredOrder,
  args: { chatId: number; messageId: number; text: string; lang: string; what: "success" | "processing" },
): Promise<void> {
  try {
    await api.editMessageText(args.chatId, args.messageId, args.text, {
      parse_mode: "HTML",
      // Keyboard by order kind through the shared picker, so a top-up bubble
      // this rail flips carries the wallet keyboard — the same one
      // `settledPaymentBubble` gives it when the Refresh button or the sweeper
      // gets there first (util/delivery.ts). Only the keyboard is shared; the
      // text stays this rail's own, passed in by the caller.
      reply_markup: settledPaymentKb(order.kind, args.lang),
    });
  } catch (err) {
    if (!isPermanentBubbleEditFailure(err)) {
      logger.warn(
        { err },
        `Binance internal poller could not flip order ${order.orderCode}'s payment bubble to its ${args.what} message, and Telegram's answer does not rule out the same edit succeeding later (flood control, a server error, or a network fault) — its anchor is left in place on purpose so the paid-order bubble sweep retries the edit within a minute`,
      );
      return;
    }
    /* bubble gone/uneditable for good — the credential or processing direct message already informed the buyer */
  }
  await clearOrderPaymentMessage(prisma, order.id);
}

/**
 * Flip the payment-instructions bubble to a success message for a "processing"
 * (manual-delivery) order. The buyer already gets a separate
 * ORDER_PROCESSING_DM via the outbox (enqueued by settlePaidOrder) — this only
 * keeps the anchored QR bubble from sitting at "waiting for payment" forever.
 * Reuses the exact same success text/keyboard onDelivered's bubble edit uses;
 * never throws.
 */
async function editBubbleToProcessing(api: Api, order: DeliveredOrder): Promise<void> {
  if (order.user.telegramId == null) return;
  if (order.paymentMsgChatId == null || order.paymentMsgId == null) return;
  const lang = langCode(order.user.language);
  // Same edit-then-decide contract onDelivered's own bubble edit makes above:
  // a bubble that can never be edited again drops its anchor and self-heals,
  // one Telegram merely refused this minute keeps it so the sweep retries.
  await editAnchoredBubbleAndDecide(api, order, {
    chatId: Number(order.paymentMsgChatId),
    messageId: order.paymentMsgId,
    text: coreT("checkout.internal_paid", lang, { code: order.orderCode }),
    lang,
    what: "processing",
  });
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
  const cfg = await resolveBinanceInternalConfig(prisma);
  if (!cfg.enabled) return;
  if (backoff.shouldSkip()) return;

  let txs: BinanceTx[];
  try {
    txs = await fetchIncomingTransfers(cfg);
  } catch (err) {
    const rateLimited = err instanceof RateLimitedError;
    if (rateLimited) {
      const { hitCount, delayMs } = backoff.recordRateLimit();
      logger.warn(`Binance rate-limited (hit #${hitCount}) — backing off ${delayMs}ms`);
    } else {
      logger.error({ err }, "Failed to fetch incoming Binance transfers — this poll cycle is skipped, pending orders stay unmatched until the next cycle");
    }
    // Guarded by isCurrent() (Task 11 review follow-up, Minor #3 — the same
    // rule bybitDeposit.ts and bybitBscDeposit.ts already apply to their own
    // identically-shaped failure branch): a stale write from an abandoned
    // cycle is stale evidence either way — even this `success: false` write
    // would double-count the SAME underlying failure the abandon heartbeat
    // already recorded (once as the abandon, once here) — so the abandoned
    // cycle's own view of this cycle's outcome is retired the moment it's
    // abandoned, not just its optimistic half.
    if (isCurrent()) {
      await recordBinancePollHealth(prisma, {
        lastTxCount: 0,
        backoffUntil: backoff.backoffUntil || null,
        consecutiveRateLimitHits: backoff.hitCount,
        rateLimited,
        success: false,
        error: String(err).slice(0, 300),
      }).catch(() => undefined);
    } else {
      logger.warn("Binance poll cycle finished after its own deadline had already abandoned it — skipping the failure heartbeat write so it can't double-count the abandon-failure heartbeat already recorded");
    }
    return;
  }

  backoff.recordSuccess();
  const now = new Date();
  const orders = await listPendingInternalOrders(prisma, now);
  if (txs.length) logger.info(`Binance poll fetched ${txs.length} transfer(s) against ${orders.length} pending order(s)`);
  // Task 11 review follow-up, Important #1 (Finding A): a cycle abandoned by
  // pollLoop.ts's deadline keeps running in the background and can still
  // reach this write minutes later — writing `success: true` then would
  // overwrite the abandon-failure heartbeat the deadline already recorded
  // and reset consecutiveFailures, making a hung poller read healthy.
  // isCurrent() is false once this cycle has been abandoned, so the write is
  // skipped instead.
  if (isCurrent()) {
    await recordBinancePollHealth(prisma, { lastTxCount: txs.length, backoffUntil: null, success: true }).catch(() => undefined);
  } else {
    logger.warn("Binance poll cycle finished after its own deadline had already abandoned it — skipping the success heartbeat write so it can't overwrite the abandon-failure heartbeat already recorded");
  }

  await processTransfers(api, txs, orders);
}

/**
 * Match a batch of fetched transfers against the pending orders and act on each
 * (deliver / underpaid / unmatched). Pure-ish wiring extracted from `pollOnce`
 * so it can be integration-tested against the real DB without the API/env gate.
 */
export async function processTransfers(api: Api, txs: BinanceTx[], orders: PendingOrder[]): Promise<void> {
  const byRef = new Map<string, PendingOrder>();
  for (const o of orders) if (o.paymentRef) byRef.set(o.paymentRef.toLowerCase(), o);

  for (const tx of txs) {
    // Primary: match the buyer's note to an order's paymentRef. Fallback: when
    // the note is empty/garbled, match by a unique expected amount (see
    // matchByAmount, M-14 backend audit 2026-07-31: best-fit among orders the
    // payment covers, capped overpayment, tie-refusal). The amount path only
    // ever yields a hit at or above the matched order's total, so it's
    // treated as a clean "match" (never auto-underpaid) — a short amount
    // simply yields no hit here.
    //
    // The amount fallback is gated on USE_UNIQUE_CENTS: without it, distinct
    // orders can share an identical total, turning a no-note transfer into a
    // confused-deputy risk (paying a shared amount could match whichever
    // single order happens to still be pending at that total, not the payer's
    // own). Memo-based matching above is unaffected and always safe.
    const byNote = tx.note ? byRef.get(tx.note.trim().toLowerCase()) : undefined;
    const order = byNote ?? (config.USE_UNIQUE_CENTS ? matchByAmount(tx, orders) : undefined);
    if (!order) {
      if (await recordUnmatchedTx(prisma, { binanceTxId: tx.txId, amount: tx.amount })) {
        logger.info(`No pending order matched Binance transfer ${tx.txId} (note: "${tx.note}", amount: ${tx.amount.toString()}) — left for manual review`);
      }
      continue;
    }
    const matchedBy = byNote ? "note" : "amount";

    const cls = byNote ? classifyTx(tx, order) : "match";
    if (cls === "underpaid") {
      if (await markUnderpaid(prisma, { orderId: order.id, binanceTxId: tx.txId, amount: tx.amount })) {
        logger.warn(`Order ${order.orderCode} underpaid — received ${tx.amount.toString()}, expected ${order.totalAmount.toString()}, left PENDING for manual review`);
        await alertAdmins(
          api,
          `⚠️ Underpaid order <code>${order.orderCode}</code>\nReceived <b>${tx.amount.toString()}</b>, expected <b>${order.totalAmount.toString()}</b> (tx ${esc(tx.txId)}).`,
        );
      }
      continue;
    }

    if (cls === "match") {
      try {
        const r = await deliverPaidInternalOrder(prisma, { orderId: order.id, binanceTxId: tx.txId, amount: tx.amount });
        if (r.status === "delivered") {
          logger.info(`Matched by ${matchedBy} — delivered order ${order.orderCode} (transfer ${tx.txId})`);
          await onDelivered(api, r.order);
        } else if (r.status === "processing") {
          logger.info(`Order ${order.orderCode} paid — queued for manual fulfilment (transfer ${tx.txId})`);
          nudgeOutboxDispatcher();
          await editBubbleToProcessing(api, r.order);
        } else if (r.status === "stale") {
          logger.warn(`Transfer ${tx.txId} matched order ${order.orderCode} but it was no longer PENDING — skipped to avoid double delivery, admin alerted`);
          await alertAdmins(api, `⚠️ Transfer matched <code>${order.orderCode}</code> but it was no longer pending (tx ${esc(tx.txId)}).`);
        }
      } catch (err) {
        logger.error({ err }, `Order ${order.orderCode} was paid (transfer ${tx.txId}) but delivery threw — admin alerted for manual action`);
        await alertAdmins(api, `⚠️ Paid but delivery FAILED for <code>${order.orderCode}</code> tx ${esc(tx.txId)} — ${esc(String(err).slice(0, 200))}. Manual action needed.`);
      }
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

// ── Important #2 (Task 3 review follow-up) ──────────────────────────────────
// Worst-case failover-to-mirror-k arithmetic: the primary host's own retry
// budget (requestWithRetries, unchanged by this task) is
// CONNECT_RETRY_ATTEMPTS(3) × HTTP_TIMEOUT_MS.gatewayRead(10s) +
// 2 × CONNECT_RETRY_DELAY_MS(1.5s) sleeps between attempts = 33s. Each
// subsequent fallback-mirror attempt (fallThroughMirrors) is bounded at
// FALLBACK_CONNECT_TIMEOUT_MS(8s), one attempt per mirror, no sleep between.
// BINANCE_API_BASE_FALLBACKS defaults to FIVE mirrors (config.ts), so the
// worst case — primary exhausted, every mirror also unreachable/slow — is
// 33s + 5 × 8s = 73s. The default cycleTimeoutMs (`max(3 * intervalMs,
// 60_000)` = 60s at the default 10s POLL_INTERVAL_SECONDS) is BELOW that
// worst case: a cycle could be abandoned mid-failover on a mirror attempt
// that would have succeeded seconds later, and the abandon heartbeat would
// carry only the generic "did not finish within 60000ms" message instead of
// the real "all Binance hosts unreachable" error. 90_000 gives ~17s of
// margin above the 73s worst case so the cycle always has time to either
// succeed via a mirror or genuinely exhaust every host and report why.
export const BINANCE_CYCLE_TIMEOUT_MS = 90_000;

const loop = createPollLoop({
  name: "Binance Internal Transfer",
  intervalMs: config.POLL_INTERVAL_SECONDS * 1000,
  cycleTimeoutMs: BINANCE_CYCLE_TIMEOUT_MS,
  run: (isCurrent) => pollOnce(boundApi!, isCurrent),
  // A hung cycle abandoned past its deadline must still show up as a failed
  // heartbeat on the ops panel, not silence — the existing failure branch in
  // pollOnce() already writes the same shape on a fetch/HTTP error.
  onCycleTimeout: (elapsedMs) =>
    recordBinancePollHealth(prisma, {
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
  // The loop always runs and self-gates each cycle on
  // resolveBinanceInternalConfig().enabled, so enabling Binance Internal in
  // web-admin Settings takes effect without a restart. The boot log just
  // reports the CURRENT state.
  void resolveBinanceInternalConfig(prisma).then((cfg) => {
    if (!cfg.enabled) {
      logger.info("Binance Internal Transfer disabled (no UID/API creds in Settings or .env) — poller idle");
      return;
    }
    // The amount fallback (matchByAmount) can only disambiguate orders when
    // their totals are distinct. With Binance Internal on but unique-cents
    // off, two buyers owing the same amount become unmatchable (refused, not
    // mis-delivered) — auto-confirm silently degrades. Warn loudly at boot.
    if (!config.USE_UNIQUE_CENTS) {
      logger.warn(
        "⚠ Binance Internal is ENABLED but USE_UNIQUE_CENTS is OFF — equal-total " +
          "orders cannot be matched by amount when the note is missing. Set " +
          "USE_UNIQUE_CENTS=1 so every order has a distinct total.",
      );
    }
    logger.info(`Binance Internal Transfer poller active (every ${config.POLL_INTERVAL_SECONDS}s)`);
  }).catch((err) =>
    // Mandatory, not defensive tidiness — see the identical guard in
    // tokopayReconcile.ts's startPolling for why an unhandled rejection here
    // would take the whole bot process down at boot.
    logger.warn({ err }, "Could not read the Binance Internal Transfer configuration for the startup log, so this boot has no line saying whether that poller is on or idle, and no unique-cents warning if it applies — the poller itself is unaffected, since it re-reads its configuration at the top of every cycle"),
  );
  loop.start();
}

export function stopPolling(): void {
  loop.stop();
}

/**
 * Fire an extra poll cycle right now, on top of the normal timer — called
 * right after a fresh order is anchored so its very first check doesn't wait
 * up to POLL_INTERVAL_SECONDS for the next scheduled tick. Pure latency
 * optimization: never lowers the confirmation bar, just shrinks the window
 * before the first check happens. Fire-and-forget by design (never awaited,
 * never throws) and shares the loop's overlap guard so it can't race a cycle
 * already in flight. A no-op before startPolling() has run (the loop starts
 * stopped) — the only callers (checkout.ts, walletTopup.ts) are reachable
 * only after main.ts's boot has already called startPolling() synchronously.
 */
export function triggerImmediatePoll(api: Api): void {
  boundApi = api;
  loop.triggerNow();
}
