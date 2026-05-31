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
 * ⚠ UNVERIFIED ASSUMPTION: that incoming UID internal transfers appear in
 * /sapi/v1/pay/transactions with a buyer-supplied `note`. This is the linchpin
 * of auto-confirmation and must be confirmed against a live account — the row
 * mapping in `normalizeTx()` is intentionally isolated so the endpoint/fields
 * can be swapped without touching the matching/delivery logic.
 */
import { createHmac } from "node:crypto";
import type { Api } from "grammy";
import { config, isBinanceInternalEnabled } from "@app/core/config";
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
  type DeliverResult,
} from "@app/db";
import { coreT } from "../util/i18n";
import { esc } from "../util/format";
import { notificationKb } from "../keyboards/customer";

const AMOUNT_TOLERANCE = 0.01; // USDT

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

// ---------------------------------------------------------------------------
// Signed Binance REST (read-only)
// ---------------------------------------------------------------------------

function sign(query: string): string {
  return createHmac("sha256", config.BINANCE_API_SECRET ?? "").update(query).digest("hex");
}

class RateLimitedError extends Error {}

/** Map a raw pay/transactions row to our normalized shape (the swappable bit). */
function normalizeTx(raw: Record<string, unknown>): BinanceTx | null {
  const txId = raw.transactionId ?? raw.transactionGroupId ?? raw.id;
  const amount = Number(raw.amount);
  const currency = String(raw.currency ?? raw.asset ?? "");
  // Binance Pay puts the buyer memo in `note`; some payloads use `orderId`.
  const note = String(raw.note ?? raw.orderId ?? raw.remark ?? "");
  if (txId == null || !Number.isFinite(amount) || amount <= 0) return null; // received only
  return { txId: String(txId), note, amount, currency };
}

/** Fetch recent incoming transfers (last hour). Throws RateLimitedError on 429/418. */
async function fetchIncomingTransfers(): Promise<BinanceTx[]> {
  const params = new URLSearchParams({
    startTime: String(Date.now() - 60 * 60 * 1000),
    limit: "100",
    timestamp: String(Date.now()),
    recvWindow: "5000",
  });
  const qs = params.toString();
  const url = `${config.BINANCE_API_BASE}/sapi/v1/pay/transactions?${qs}&signature=${sign(qs)}`;
  const res = await fetch(url, { headers: { "X-MBX-APIKEY": config.BINANCE_API_KEY ?? "" } });
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
    .filter((t): t is BinanceTx => t !== null && t.currency.toUpperCase() === config.CURRENCY.toUpperCase());
}

// ---------------------------------------------------------------------------
// Delivery side-effects (DM buyer + edit the payment bubble)
// ---------------------------------------------------------------------------

function buildCredentialsBlob(
  items: Array<{ productId: number; product: { name: string }; stockItem: { credentials: string } | null }>,
  lang: string,
): string {
  const groups: Array<[string, string[]]> = [];
  const idx = new Map<number, number>();
  for (const it of items) {
    if (!it.stockItem) continue;
    if (!idx.has(it.productId)) {
      idx.set(it.productId, groups.length);
      groups.push([it.product.name, []]);
    }
    groups[idx.get(it.productId)!]![1].push(it.stockItem.credentials);
  }
  return groups
    .map(([name, creds]) => {
      const header = coreT("order.delivered_group_header", lang, { product: esc(name), count: creds.length });
      return `${header}\n<pre>${esc(creds.join("\n"))}</pre>`;
    })
    .join("\n\n");
}

type DeliveredOrder = Extract<DeliverResult, { status: "delivered" }>["order"];

async function onDelivered(api: Api, order: DeliveredOrder): Promise<void> {
  const lang = langCode(order.user.language);
  const tgId = Number(order.user.telegramId);

  try {
    await api.sendMessage(tgId, coreT("order.payment_verified", lang, { code: order.orderCode }), {
      parse_mode: "HTML",
      reply_markup: notificationKb(lang),
    });
  } catch (err) {
    logger.error({ err }, `payment_verified DM failed for ${tgId}`);
  }

  const warranty = Math.max(...order.items.map((i) => i.warrantyDaysSnapshot), 30);
  try {
    await api.sendMessage(
      tgId,
      coreT("order.delivered_credentials", lang, {
        code: order.orderCode,
        credentials: buildCredentialsBlob(order.items, lang),
        warranty,
      }),
      { parse_mode: "HTML", reply_markup: notificationKb(lang) },
    );
  } catch (err) {
    logger.error({ err }, `credentials DM failed for order ${order.orderCode}`);
  }

  // Turn the payment-instructions bubble into a success message in place.
  if (order.paymentMsgChatId != null && order.paymentMsgId != null) {
    try {
      await api.editMessageText(
        Number(order.paymentMsgChatId),
        order.paymentMsgId,
        coreT("checkout.internal_paid", lang, { code: order.orderCode }),
        { parse_mode: "HTML", reply_markup: notificationKb(lang) },
      );
    } catch {
      /* bubble may be gone/uneditable — the credential DM already informed the buyer */
    }
  }
}

async function alertAdmins(api: Api, text: string): Promise<void> {
  for (const adminId of config.ADMIN_IDS) {
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
  if (!isBinanceInternalEnabled()) return;
  if (Date.now() < backoffUntil) return;

  let txs: BinanceTx[];
  try {
    txs = await fetchIncomingTransfers();
  } catch (err) {
    if (err instanceof RateLimitedError) {
      backoffUntil = Date.now() + 60_000;
      logger.warn("Binance rate-limited — backing off 60s");
    } else {
      logger.error({ err }, "Binance transfer fetch failed");
    }
    // Heartbeat so the web ops panel shows the poller is alive (and backing off).
    await recordBinancePollHealth(prisma, { lastTxCount: 0, backoffUntil: backoffUntil || null }).catch(() => undefined);
    return;
  }

  const now = new Date();
  const orders = await listPendingInternalOrders(prisma, now);
  if (txs.length) logger.info(`Binance poll: ${txs.length} tx fetched, ${orders.length} pending order(s)`);
  await recordBinancePollHealth(prisma, { lastTxCount: txs.length, backoffUntil: null }).catch(() => undefined);

  const byRef = new Map<string, PendingOrder>();
  for (const o of orders) if (o.paymentRef) byRef.set(o.paymentRef.toLowerCase(), o);

  for (const tx of txs) {
    const order = byRef.get(tx.note.trim().toLowerCase());
    if (!order) {
      if (await recordUnmatchedTx(prisma, { binanceTxId: tx.txId, amount: tx.amount })) {
        logger.info(`Unmatched transfer tx=${tx.txId} note=${tx.note} amount=${tx.amount}`);
      }
      continue;
    }

    const cls = classifyTx(tx, order);
    if (cls === "underpaid") {
      if (await markUnderpaid(prisma, { orderId: order.id, binanceTxId: tx.txId, amount: tx.amount })) {
        logger.warn(`Underpaid order ${order.orderCode}: got ${tx.amount}, expected ${order.totalAmount}`);
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
          logger.info(`Match → delivered order ${order.orderCode} (tx ${tx.txId})`);
          await onDelivered(api, r.order);
        } else if (r.status === "stale") {
          logger.warn(`Matched tx ${tx.txId} but order ${order.orderCode} no longer PENDING`);
          await alertAdmins(api, `⚠️ Transfer matched <code>${order.orderCode}</code> but it was no longer pending (tx ${esc(tx.txId)}).`);
        }
      } catch (err) {
        logger.error({ err }, `Delivery failed for order ${order.orderCode} tx ${tx.txId}`);
        await alertAdmins(api, `⚠️ Paid but delivery FAILED for <code>${order.orderCode}</code> (out of stock?) tx ${esc(tx.txId)}. Manual action needed.`);
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
  if (!isBinanceInternalEnabled()) {
    logger.info("Binance Internal Transfer disabled (no UID/API creds) — poller not started");
    return;
  }
  stopped = false;
  const intervalMs = config.POLL_INTERVAL_SECONDS * 1000;
  const tick = async () => {
    if (stopped) return;
    if (!isRunning) {
      isRunning = true;
      try {
        await pollOnce(api);
      } catch (err) {
        logger.error({ err }, "Binance poll cycle error");
      } finally {
        isRunning = false;
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  logger.info(`Binance Internal Transfer poller started (every ${config.POLL_INTERVAL_SECONDS}s)`);
  timer = setTimeout(tick, intervalMs);
}

export function stopPolling(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
