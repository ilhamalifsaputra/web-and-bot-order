/**
 * CRUD for the Bybit BSC on-chain (BEP20) deposit payment method — a second,
 * separate Bybit rail alongside bybit_deposit.ts's Internal Transfer.
 *
 * Unlike Internal Transfer (Bybit account → Bybit account only), this is a
 * normal blockchain transfer to a Bybit-custodied BSC address, so it accepts
 * a deposit from any BEP20 wallet/exchange (including a Binance withdrawal).
 * It needs on-chain confirmation (~1-2 min), so it's slower than Internal
 * Transfer, but reaches buyers Internal Transfer can't.
 *
 * BEP20 carries NO memo either, so matching is by unique total amount only
 * (same as Internal Transfer) — USE_UNIQUE_CENTS keeps every order distinct.
 * There is therefore no underpaid auto-path — an amount that matches no
 * order is "unmatched" and left for manual review.
 *
 * Idempotency: shares the SAME `processed_bybit_tx` ledger as Internal
 * Transfer. This is safe because the two methods' txId formats never
 * collide — Internal Transfer ids are short numeric ledger ids, on-chain
 * BEP20 ids are 0x-prefixed 64-hex-char transaction hashes.
 */
import { config } from "@app/core/config";
import { OrderStatus, OrderCurrency, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, createOrderDirect, approveOrder, applyUsdtWalletToOrder } from "./orders";
import { getSetting, setSetting } from "./settings";
import { finalizeOrderPayment } from "./pricing";
import { BYBIT_API_KEY_KEY, BYBIT_API_SECRET_KEY } from "./bybit_deposit";
import { parseMinAmount } from "./_minAmount";

// ---------------------------------------------------------------------------
// Resolved config (web-admin Settings win; .env is the bootstrap/recovery
// fallback, plan.md §16). Read per-request/per-poll so an edit in /settings
// takes effect on the next cycle without a restart (like TokoPay).
// ---------------------------------------------------------------------------

export const BYBIT_BSC_DEPOSIT_ADDRESS_KEY = "bybit_bsc_deposit_address";
// On/off toggle (web admin), independent of Internal Transfer's. Default ON:
// only the literal "false" disables.
export const BYBIT_BSC_ENABLED_KEY = "bybit_bsc_enabled";
// Minimum-payment-amount note shown at checkout (USDT) — blank = no note.
export const BYBIT_BSC_MIN_AMOUNT_KEY = "bybit_bsc_min_amount";

export interface BybitBscConfig {
  /** True only when depositAddress + apiKey + apiSecret are all present. */
  enabled: boolean;
  depositAddress: string;
  /** On-chain network filter for incoming deposits (e.g. "BSC"). */
  chain: string;
  /** Shared with Internal Transfer — same exchange account, same credentials. */
  apiKey: string;
  apiSecret: string;
  apiBase: string;
  windowMinutes: number;
  minAmount: Decimal | null;
}

/** First non-empty (trimmed) value, else "". DB value wins over the env fallback. */
function pick(dbVal: string | null, envVal?: string): string {
  const a = (dbVal ?? "").trim();
  if (a) return a;
  return (envVal ?? "").trim();
}

/**
 * Resolve the Bybit BSC on-chain config from Settings (with .env fallback).
 * `enabled` gates the poller, the watchdog, and the checkout option. The API
 * key/secret are shared with Internal Transfer (same exchange account); only
 * the deposit address is specific to this method.
 */
export async function resolveBybitBscConfig(db: Db): Promise<BybitBscConfig> {
  const [addressSetting, key, secret, flag, minAmountSetting] = await Promise.all([
    getSetting(db, BYBIT_BSC_DEPOSIT_ADDRESS_KEY),
    getSetting(db, BYBIT_API_KEY_KEY),
    getSetting(db, BYBIT_API_SECRET_KEY),
    getSetting(db, BYBIT_BSC_ENABLED_KEY),
    getSetting(db, BYBIT_BSC_MIN_AMOUNT_KEY),
  ]);
  const depositAddress = pick(addressSetting, config.BYBIT_DEPOSIT_ADDRESS);
  const apiKey = pick(key, config.BYBIT_API_KEY);
  const apiSecret = pick(secret, config.BYBIT_API_SECRET);
  return {
    // Default ON: an unset/empty flag means enabled; only the literal "false"
    // (trimmed, case-insensitive) disables the method without touching creds.
    enabled: Boolean(depositAddress && apiKey && apiSecret) && (flag ?? "").trim().toLowerCase() !== "false",
    depositAddress,
    chain: config.BYBIT_DEPOSIT_CHAIN,
    apiKey,
    apiSecret,
    apiBase: config.BYBIT_API_BASE,
    windowMinutes: config.BYBIT_BSC_PAYMENT_WINDOW_MINUTES,
    minAmount: parseMinAmount(minAmountSetting),
  };
}

/**
 * Create a direct order, then stamp it as a USDT/Bybit BSC deposit payment:
 * the central-IDR total converts once at `rate` (rounded 0.1) + unique
 * cents, with the BSC auto-confirm payment window. No transfer note (BEP20
 * carries none).
 */
export async function createBybitBscOrder(
  db: Db,
  args: {
    user: { id: number; role: string };
    productId: number;
    quantity: number;
    voucherCode?: string | null;
    /** Rupiah per 1 USDT (usd_idr_rate) — required for the USDT path. */
    rate: Decimal.Value;
    /** Optional USDT credit balance to spend on this order (clamped to total). */
    walletAmount?: Decimal.Value;
  },
) {
  const created = await createOrderDirect(db, args);
  if (!created) return null;
  const finalized = await finalizeOrderPayment(db, created.id, {
    currency: OrderCurrency.USDT,
    rate: args.rate,
    method: PaymentMethod.BYBIT_BSC,
  });
  // Spend the USDT credit balance against the finalized USDT total (no-op when
  // walletAmount is unset). Re-read so callers see the updated walletUsed/total.
  await applyUsdtWalletToOrder(db, created.id, args.walletAmount);
  return args.walletAmount != null ? getOrder(db, created.id) : finalized;
}

/** PENDING, not-yet-expired Bybit BSC orders the deposit poller should match against. */
export function listPendingBybitBscOrders(db: Db, now: Date) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.BYBIT_BSC,
      expiresAt: { gt: now },
    },
    include: { user: true },
  });
}

export type BybitBscDeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
  | { status: "already_processed" }
  | { status: "stale" };

/**
 * Idempotently confirm + deliver a matched Bybit BSC deposit. Shares the
 * SAME `processed_bybit_tx` ledger as Internal Transfer (see module
 * doc-comment for the non-collision reasoning) — claims the on-chain txID
 * (UNIQUE gate) then runs the normal approve/deliver path. Returns
 * "already_processed" if the tx was seen before, "stale" if the order is no
 * longer awaiting payment (delivered/expired elsewhere).
 */
export async function deliverPaidBybitBscOrder(
  db: PrismaClient,
  args: { orderId: number; bybitTxId: string; amount: Decimal.Value },
): Promise<BybitBscDeliverResult> {
  // 1. Claim the tx id. A duplicate means another cycle already handled it.
  try {
    await db.processedBybitTx.create({
      data: { bybitTxId: args.bybitTxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { status: "already_processed" };
    throw e;
  }

  // 2. Deliver. On failure, flag the ledger row so we don't silently retry
  //    forever (e.g. paid but out of stock) and let the caller alert an admin.
  try {
    return await db.$transaction(async (tx: Tx) => {
      const order = await getOrder(tx, args.orderId);
      if (!order || order.status !== OrderStatus.PENDING_PAYMENT) {
        return { status: "stale" as const };
      }
      await tx.order.update({
        where: { id: args.orderId },
        data: { status: OrderStatus.PENDING_VERIFICATION, bybitTxid: args.bybitTxId, paidAt: new Date() },
      });
      const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: 0 });
      logger.info(`Auto-delivered Bybit BSC order ${delivered.orderCode} for transaction ${args.bybitTxId}`);
      return { status: "delivered" as const, order: delivered, credentials };
    });
  } catch (e) {
    await db.processedBybitTx
      .update({ where: { bybitTxId: args.bybitTxId }, data: { outcome: "delivery_failed" } })
      .catch(() => undefined);
    throw e;
  }
}

/** A deposit that matched no PENDING order — record once for manual review. */
export async function recordUnmatchedBybitBscTx(db: Db, args: { bybitTxId: string; amount: Decimal.Value }): Promise<boolean> {
  try {
    await db.processedBybitTx.create({
      data: { bybitTxId: args.bybitTxId, amount: new Decimal(args.amount), outcome: "unmatched" },
    });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

// ---- Poller heartbeat (written by the order-bot poller, read by the web) ----
// Independent from Internal Transfer's heartbeat so the two pollers' health
// is diagnosable separately — they can fail for unrelated reasons (on-chain
// network congestion vs. an API outage).

/** Single settings key holding the Bybit BSC poller's last-cycle heartbeat as JSON. */
export const BYBIT_BSC_POLL_HEALTH_KEY = "bybit_bsc_poll_health";

export interface BybitBscPollHealth {
  lastRun: string | null;
  /** Last cycle that completed WITHOUT error (0 new deposits still counts). */
  lastSuccessAt: string | null;
  lastTxCount: number | null;
  backoffUntil: string | null;
  /** Current consecutive rate-limit hit streak (0 when healthy). */
  consecutiveRateLimitHits: number | null;
  /** Sticky — last time a rate-limit hit occurred, even after recovery. */
  lastRateLimitAt: string | null;
  /** Consecutive non-rate-limit failures (network/HTTP errors); 0 when
   * healthy. Tracked separately from rate limits, which already have their
   * own backoff/counter above — `lastRun` alone can't surface this, since it
   * advances on every cycle whether that cycle succeeded or failed. */
  consecutiveFailures: number | null;
  /** Sticky — last error message seen (any failure type), for diagnostics. */
  lastError: string | null;
}

const EMPTY_BYBIT_BSC_HEALTH: BybitBscPollHealth = {
  lastRun: null,
  lastSuccessAt: null,
  lastTxCount: null,
  backoffUntil: null,
  consecutiveRateLimitHits: null,
  lastRateLimitAt: null,
  consecutiveFailures: null,
  lastError: null,
};

/** Read the Bybit BSC poller heartbeat; all-null when it has never run. */
export async function getBybitBscPollHealth(db: Db): Promise<BybitBscPollHealth> {
  const raw = await getSetting(db, BYBIT_BSC_POLL_HEALTH_KEY);
  if (!raw) return EMPTY_BYBIT_BSC_HEALTH;
  try {
    const p = JSON.parse(raw) as Partial<BybitBscPollHealth>;
    return {
      lastRun: p.lastRun ?? null,
      lastSuccessAt: p.lastSuccessAt ?? null,
      lastTxCount: typeof p.lastTxCount === "number" ? p.lastTxCount : null,
      backoffUntil: p.backoffUntil ?? null,
      consecutiveRateLimitHits: typeof p.consecutiveRateLimitHits === "number" ? p.consecutiveRateLimitHits : null,
      lastRateLimitAt: p.lastRateLimitAt ?? null,
      consecutiveFailures: typeof p.consecutiveFailures === "number" ? p.consecutiveFailures : null,
      lastError: p.lastError ?? null,
    };
  } catch {
    return EMPTY_BYBIT_BSC_HEALTH;
  }
}

/** Record one Bybit BSC poll cycle's heartbeat. Called by the poller each tick.
 * `lastRateLimitAt`/`lastError` are sticky (carried forward from the prior
 * heartbeat) so a rare hit stays visible after the poller recovers.
 * `consecutiveFailures` counts non-rate-limit failures only — a rate-limit
 * hit neither increments nor resets it, since that streak already has its own
 * dedicated counter/backoff above. */
export async function recordBybitBscPollHealth(
  db: Db,
  args: {
    lastTxCount: number;
    backoffUntil?: number | null;
    consecutiveRateLimitHits?: number;
    rateLimited?: boolean;
    success: boolean;
    error?: string | null;
  },
): Promise<void> {
  const prev = await getBybitBscPollHealth(db);
  const lastRateLimitAt = args.rateLimited ? new Date().toISOString() : prev.lastRateLimitAt;
  const consecutiveFailures = args.success
    ? 0
    : args.rateLimited
      ? prev.consecutiveFailures ?? 0
      : (prev.consecutiveFailures ?? 0) + 1;
  const nowIso = new Date().toISOString();
  await setSetting(
    db,
    BYBIT_BSC_POLL_HEALTH_KEY,
    JSON.stringify({
      lastRun: nowIso,
      lastSuccessAt: args.success ? nowIso : prev.lastSuccessAt,
      lastTxCount: args.lastTxCount,
      backoffUntil: args.backoffUntil ? new Date(args.backoffUntil).toISOString() : null,
      consecutiveRateLimitHits: args.consecutiveRateLimitHits ?? 0,
      lastRateLimitAt,
      consecutiveFailures,
      lastError: args.success ? prev.lastError : (args.error ?? prev.lastError) ?? null,
    } satisfies BybitBscPollHealth),
  );
}
