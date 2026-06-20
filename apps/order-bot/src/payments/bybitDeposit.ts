/**
 * Bybit USDT-BSC (BEP20) on-chain deposit auto-confirmation.
 *
 * Buyers send USDT on BNB Smart Chain to our shared Bybit deposit address. A
 * polling loop pulls recent deposits from Bybit, matches each to a PENDING order
 * by its UNIQUE amount (BEP20 has no memo), and auto-delivers via the normal
 * approve path.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 * The ONLY Bybit endpoint this module calls is GET /v5/asset/deposit/query-record
 * (signed, read-only). It never touches trading or withdrawal endpoints. Use a
 * Wallet-read-only API key (no Withdraw permission). A live probe
 * (scripts/bybit-probe.ts) confirmed deposits surface here with a real `txID`,
 * `amount`, and `status` (3 = success), and an EMPTY `tag` on BSC — hence
 * amount-only matching.
 *
 * The row mapping in `normalizeDeposit()` stays isolated so the endpoint/fields
 * can be swapped without touching matching/delivery.
 */
import { createHmac } from "node:crypto";
import type { Api } from "grammy";
import { config } from "@app/core/config";
import { adminIds } from "@app/core/runtime";
import { langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import {
  prisma,
  listPendingBybitOrders,
  deliverPaidBybitOrder,
  recordUnmatchedBybitTx,
  recordBybitPollHealth,
  resolveBybitConfig,
  type BybitConfig,
  type BybitDeliverResult,
} from "@app/db";
import { coreT } from "../util/i18n";
import { esc } from "../util/format";
import { matchByAmount } from "./binanceInternal";
import { paymentSuccessKb } from "../keyboards/customer";
import { sendAccountFile } from "../util/delivery";

const AMOUNT_TOLERANCE = 0.01; // USDT
/** Bybit deposit status: 3 = success (credited). Deliver only on this. */
const STATUS_SUCCESS = 3;

export interface BybitDeposit {
  txId: string;
  amount: number; // positive = received, in USDT
  chain: string;
}

type PendingOrder = Awaited<ReturnType<typeof listPendingBybitOrders>>[number];

// ---------------------------------------------------------------------------
// Signed Bybit V5 REST (read-only)
// ---------------------------------------------------------------------------

class RateLimitedError extends Error {}

/** Bybit V5 GET auth: HMAC-SHA256(secret, timestamp + apiKey + recvWindow + queryString). */
async function bybitGet(path: string, params: Record<string, string>, cfg: BybitConfig): Promise<Record<string, unknown>> {
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

/** Map a raw deposit row to our normalized shape (the swappable bit). Only
 * SUCCESS (status 3) deposits on the configured chain are kept; exported so a
 * fixture test can pin the real Bybit payload shape. */
export function normalizeDeposit(raw: Record<string, unknown>, chain = config.BYBIT_DEPOSIT_CHAIN): BybitDeposit | null {
  const txId = raw.txID ?? raw.txid ?? raw.id;
  const amount = Number(raw.amount);
  const coin = String(raw.coin ?? "").toUpperCase();
  const rowChain = String(raw.chain ?? "");
  const status = Number(raw.status);
  if (txId == null || !Number.isFinite(amount) || amount <= 0) return null; // received only
  if (coin !== config.CURRENCY.toUpperCase()) return null;
  if (rowChain.toUpperCase() !== chain.toUpperCase()) return null;
  if (status !== STATUS_SUCCESS) return null; // pending/processing → skip until credited
  return { txId: String(txId), amount, chain: rowChain };
}

/** Fetch recent successful USDT deposits on the configured chain (last 3 days).
 * Throws RateLimitedError on 429/403/retCode rate limits. */
async function fetchRecentDeposits(cfg: BybitConfig): Promise<BybitDeposit[]> {
  const result = await bybitGet("/v5/asset/deposit/query-record", {
    coin: config.CURRENCY,
    startTime: String(Date.now() - 3 * 24 * 60 * 60 * 1000),
    limit: "50",
  }, cfg);
  const rows = (result.rows ?? []) as Record<string, unknown>[];
  return rows.map((r) => normalizeDeposit(r, cfg.chain)).filter((d): d is BybitDeposit => d !== null);
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

  // Delivery is instant: send the account file straight away.
  try {
    await sendAccountFile(api, tgId, order, lang);
  } catch (err) {
    logger.error({ err }, `account file DM failed for order ${order.orderCode}`);
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
      logger.error({ err }, `admin alert to ${adminId} failed`);
    }
  }
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

let backoffUntil = 0;

export async function pollOnce(api: Api): Promise<void> {
  const cfg = await resolveBybitConfig(prisma);
  if (!cfg.enabled) return;
  if (Date.now() < backoffUntil) return;

  let deposits: BybitDeposit[];
  try {
    deposits = await fetchRecentDeposits(cfg);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      backoffUntil = Date.now() + 60_000;
      logger.warn("Bybit rate-limited — backing off 60s");
    } else {
      logger.error({ err }, "Bybit deposit fetch failed");
    }
    await recordBybitPollHealth(prisma, { lastTxCount: 0, backoffUntil: backoffUntil || null }).catch(() => undefined);
    return;
  }

  const now = new Date();
  const orders = await listPendingBybitOrders(prisma, now);
  if (deposits.length) logger.info(`Bybit poll: ${deposits.length} deposit(s) fetched, ${orders.length} pending order(s)`);
  await recordBybitPollHealth(prisma, { lastTxCount: deposits.length, backoffUntil: null }).catch(() => undefined);

  await processDeposits(api, deposits, orders);
}

/**
 * Match a batch of fetched deposits against pending orders and act on each.
 * BEP20 has no memo, so matching is by UNIQUE amount only: a deposit maps to an
 * order iff exactly one pending order expects that amount (within tolerance).
 * On a collision (≥2 candidates) or no candidate it is recorded "unmatched" and
 * left for manual review — never guessed. Extracted from pollOnce so it can be
 * integration-tested against the real DB without the API/env gate.
 */
export async function processDeposits(api: Api, deposits: BybitDeposit[], orders: PendingOrder[]): Promise<void> {
  for (const dep of deposits) {
    const order = matchByAmount({ amount: dep.amount }, orders, AMOUNT_TOLERANCE);
    if (!order) {
      if (await recordUnmatchedBybitTx(prisma, { bybitTxId: dep.txId, amount: dep.amount })) {
        logger.info(`Unmatched Bybit deposit tx=${dep.txId} amount=${dep.amount}`);
      }
      continue;
    }

    try {
      const r = await deliverPaidBybitOrder(prisma, { orderId: order.id, bybitTxId: dep.txId, amount: dep.amount });
      if (r.status === "delivered") {
        logger.info(`Match(amount) → delivered Bybit order ${order.orderCode} (tx ${dep.txId})`);
        await onDelivered(api, r.order);
      } else if (r.status === "stale") {
        logger.warn(`Matched Bybit deposit ${dep.txId} but order ${order.orderCode} no longer PENDING`);
        await alertAdmins(api, `⚠️ Bybit deposit matched <code>${order.orderCode}</code> but it was no longer pending (tx ${esc(dep.txId)}).`);
      }
    } catch (err) {
      logger.error({ err }, `Delivery failed for Bybit order ${order.orderCode} tx ${dep.txId}`);
      await alertAdmins(api, `⚠️ Paid but delivery FAILED for <code>${order.orderCode}</code> (out of stock?) tx ${esc(dep.txId)}. Manual action needed.`);
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
        logger.error({ err }, "Bybit poll cycle error");
      } finally {
        isRunning = false;
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  // The loop always runs and self-gates each cycle on resolveBybitConfig().enabled,
  // so enabling Bybit in web-admin Settings takes effect without a restart. The
  // boot log just reports the CURRENT state.
  void resolveBybitConfig(prisma).then((cfg) => {
    if (!cfg.enabled) {
      logger.info("Bybit deposit auto-confirm disabled (no address/API creds in Settings or .env) — poller idle");
      return;
    }
    // Amount matching can only disambiguate orders when their totals are distinct.
    // With Bybit on but unique-cents off, two buyers owing the same amount become
    // unmatchable (refused, not mis-delivered) — auto-confirm silently degrades.
    if (!config.USE_UNIQUE_CENTS) {
      logger.warn(
        "⚠ Bybit deposit auto-confirm is ENABLED but USE_UNIQUE_CENTS is OFF — " +
          "BEP20 has no memo, so equal-total orders cannot be matched by amount. " +
          "Set USE_UNIQUE_CENTS=1 so every order has a distinct total.",
      );
    }
    logger.info(`Bybit deposit poller active (every ${config.POLL_INTERVAL_SECONDS}s)`);
  });
  timer = setTimeout(tick, intervalMs);
}

export function stopPolling(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
