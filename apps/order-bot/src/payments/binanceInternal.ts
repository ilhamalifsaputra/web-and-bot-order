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
import { langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";
import {
  prisma,
  listPendingInternalOrders,
  deliverPaidInternalOrder,
  markUnderpaid,
  recordUnmatchedTx,
  recordBinancePollHealth,
  resolveBinanceInternalConfig,
  type BinanceInternalConfig,
  type DeliverResult,
} from "@app/db";
import { coreT } from "../util/i18n";
import { esc } from "../util/format";
import { createBackoffGate } from "./pollBackoff";
import { paymentSuccessKb } from "../keyboards/customer";
import { sendAccountFile } from "../util/delivery";

// Internal transfers are exact off-chain ledger moves (no on-chain
// slippage/fees) — the only error source is Number() float parsing of a
// decimal string, far smaller than this. Tight on purpose: it lets the M-9
// unique-cents offset (see computeUniqueCents) shrink to a much smaller
// surcharge while still disambiguating same-amount orders.
const AMOUNT_TOLERANCE = 0.001; // USDT

export interface BinanceTx {
  txId: string;
  note: string;
  amount: number; // positive = received, in `currency`
  currency: string;
}

type PendingOrder = Awaited<ReturnType<typeof listPendingInternalOrders>>[number];

// ---------------------------------------------------------------------------
// Matching (pure — unit-tested)
// ---------------------------------------------------------------------------

/** Note equality: case-insensitive, trimmed. */
export function noteMatches(tx: { note: string }, order: { paymentRef: string | null }): boolean {
  if (!order.paymentRef) return false;
  return tx.note.trim().toLowerCase() === order.paymentRef.trim().toLowerCase();
}

/**
 * Classify a transfer against an order:
 *  - "match": note matches AND received >= expected - tolerance (exact, within
 *    tolerance, or overpaid → deliver).
 *  - "underpaid": note matches but received is short beyond tolerance.
 *  - "none": note doesn't match.
 * (The task's rule is |received-expected| <= tolerance for a match; we also
 * deliver on overpayment, since refusing a buyer who paid more is worse.)
 */
export function classifyTx(
  tx: { note: string; amount: number },
  order: { paymentRef: string | null; totalAmount: Decimal.Value },
  tolerance = AMOUNT_TOLERANCE,
): "match" | "underpaid" | "none" {
  if (!noteMatches(tx, order)) return "none";
  const expected = new Decimal(order.totalAmount).toNumber();
  if (tx.amount - expected >= -tolerance) return "match";
  return "underpaid";
}

/**
 * Amount fallback for when the note is missing/garbled (the live probe showed
 * `/sapi/v1/pay/transactions` returns an empty `note` for C2C transfers, so we
 * cannot rely on the memo alone). A transfer maps to an order ONLY when exactly
 * one pending order expects an amount within `tolerance` of the received amount.
 * With unique-cents enabled every order has a distinct total, so this is exact;
 * on a collision (≥2 candidates) we refuse and leave it for manual matching,
 * never guessing whose money it is. Returns the sole candidate or null.
 */
export function matchByAmount<T extends { totalAmount: Decimal.Value }>(
  tx: { amount: number },
  orders: readonly T[],
  tolerance = AMOUNT_TOLERANCE,
): T | null {
  const hits = orders.filter(
    (o) => Math.abs(tx.amount - new Decimal(o.totalAmount).toNumber()) <= tolerance,
  );
  return hits.length === 1 ? hits[0]! : null;
}

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
  const amount = Number(raw.amount);
  const currency = String(raw.currency ?? raw.asset ?? "");
  // Buyer memo: try the known memo-carrying fields, skipping empty strings.
  // NB: `orderId` is Binance's OWN id (not our paymentRef) — never use it here.
  const note = firstNonEmpty(raw.note, raw.remark, raw.message);
  if (txId == null || !Number.isFinite(amount) || amount <= 0) return null; // received only
  return { txId: String(txId), note, amount, currency };
}

const CONNECT_RETRY_ATTEMPTS = 3;
const CONNECT_RETRY_DELAY_MS = 1500;
// Only applied to fallback-mirror attempts (see fallThroughMirrors) — the
// primary host keeps relying on undici's implicit default, unchanged from
// before fallback support existed. Bounds the worst case once there are
// multiple mirrors to walk through: an unreachable host fails fast instead of
// hanging on undici's longer implicit timeout per attempt.
const FALLBACK_CONNECT_TIMEOUT_MS = 8_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One signed GET against /sapi/v1/pay/transactions against a given host. Split
 * out of fetchIncomingTransfers so each retry/fallback attempt gets a fresh
 * timestamp/signature (Binance rejects a stale timestamp outside recvWindow).
 * The signature covers only the query string, never the host, so calling this
 * against a mirror host is safe. `timeoutMs` is only set for fallback attempts
 * (see FALLBACK_CONNECT_TIMEOUT_MS) — omitted, the primary path behaves
 * exactly as it always has.
 */
async function requestIncomingTransfers(cfg: BinanceInternalConfig, apiBase: string, timeoutMs?: number): Promise<Response> {
  const params = new URLSearchParams({
    startTime: String(Date.now() - 60 * 60 * 1000),
    limit: "100",
    timestamp: String(Date.now()),
    recvWindow: "5000",
  });
  const qs = params.toString();
  const url = `${apiBase}/sapi/v1/pay/transactions?${qs}&signature=${sign(qs, cfg.apiSecret)}`;
  return fetch(url, {
    headers: { "X-MBX-APIKEY": cfg.apiKey },
    ...(timeoutMs != null ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
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
  const body = (await res.json()) as { data?: Record<string, unknown>[] };
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

  // Delivery is instant: skip the interim "payment verified / being prepared"
  // notice and send the account file straight away.
  try {
    await sendAccountFile(api, tgId, order, lang);
  } catch (err) {
    logger.error({ err }, `Failed to DM the account file for order ${order.orderCode} — buyer paid but has not received their credentials yet`);
  }

  // Turn the payment-instructions bubble into a success message in place.
  if (order.paymentMsgChatId != null && order.paymentMsgId != null) {
    try {
      await api.editMessageText(
        Number(order.paymentMsgChatId),
        order.paymentMsgId,
        coreT("checkout.internal_paid", lang, { code: order.orderCode }),
        { parse_mode: "HTML", reply_markup: paymentSuccessKb(lang) },
      );
    } catch {
      /* bubble may be gone/uneditable — the credential DM already informed the buyer */
    }
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
    // Heartbeat so the web ops panel shows the poller is alive (and backing off).
    await recordBinancePollHealth(prisma, {
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
  const orders = await listPendingInternalOrders(prisma, now);
  if (txs.length) logger.info(`Binance poll fetched ${txs.length} transfer(s) against ${orders.length} pending order(s)`);
  await recordBinancePollHealth(prisma, { lastTxCount: txs.length, backoffUntil: null, success: true }).catch(() => undefined);

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
    // matchByAmount). The amount path only ever yields an exact-within-tolerance
    // hit, so it's treated as a clean "match" (never auto-underpaid).
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
        logger.info(`No pending order matched Binance transfer ${tx.txId} (note: "${tx.note}", amount: ${tx.amount}) — left for manual review`);
      }
      continue;
    }
    const matchedBy = byNote ? "note" : "amount";

    const cls = byNote ? classifyTx(tx, order) : "match";
    if (cls === "underpaid") {
      if (await markUnderpaid(prisma, { orderId: order.id, binanceTxId: tx.txId, amount: tx.amount })) {
        logger.warn(`Order ${order.orderCode} underpaid — received ${tx.amount}, expected ${order.totalAmount}, left PENDING for manual review`);
        await alertAdmins(
          api,
          `⚠️ Underpaid order <code>${order.orderCode}</code>\nReceived <b>${tx.amount}</b>, expected <b>${order.totalAmount}</b> (tx ${esc(tx.txId)}).`,
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

let timer: ReturnType<typeof setTimeout> | undefined;
let isRunning = false;
let stopped = false;

export function startPolling(api: Api): void {
  stopped = false;
  const intervalMs = config.POLL_INTERVAL_SECONDS * 1000;
  const tick = async () => {
    if (stopped) return;
    if (!isRunning) {
      isRunning = true;
      try {
        await pollOnce(api);
      } catch (err) {
        logger.error({ err }, "Binance poll cycle threw an unhandled error — the cycle was aborted, polling resumes on the next tick");
      } finally {
        isRunning = false;
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
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
 * up to POLL_INTERVAL_SECONDS for the next scheduled tick. Pure latency
 * optimization: never lowers the confirmation bar, just shrinks the window
 * before the first check happens. Fire-and-forget by design (never awaited,
 * never throws) and shares the timer loop's `isRunning` guard so it can't
 * race a tick already in flight.
 */
export function triggerImmediatePoll(api: Api): void {
  if (isRunning || stopped) return;
  isRunning = true;
  void pollOnce(api)
    .catch((err) => logger.error({ err }, "Binance immediate poll (triggered right after order creation) threw an unhandled error — the regular timer will retry on its next tick"))
    .finally(() => {
      isRunning = false;
    });
}
