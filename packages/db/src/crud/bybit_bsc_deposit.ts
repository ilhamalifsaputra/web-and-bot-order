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
import { transitionOrderStatus, tryTransitionOrderStatus } from "./orderStatus";
import { enqueueOrderPipelineFailed } from "./notifications";
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

// ---------------------------------------------------------------------------
// Confirmation tracker config — a separate, display-only concern from the
// deposit-matching config above (no depositAddress/apiSecret needed here;
// the explorer lookup is public/read-only and unrelated to Bybit's own API).
// ---------------------------------------------------------------------------

export const BSCSCAN_API_KEY_KEY = "bscscan_api_key";
export const BYBIT_BSC_REQUIRED_CONFIRMATIONS_KEY = "bybit_bsc_required_confirmations";

export interface BybitBscTrackerConfig {
  apiBase: string;
  /** Optional — BscScan's free tier works without one at a lower rate limit. */
  apiKey: string;
  requiredConfirmations: number;
}

/** Resolve the confirmation tracker's config from Settings (with .env
 * fallback) — same Setting-wins pattern as `resolveBybitBscConfig`. */
export async function resolveBybitBscTrackerConfig(db: Db): Promise<BybitBscTrackerConfig> {
  const [keySetting, confirmSetting] = await Promise.all([
    getSetting(db, BSCSCAN_API_KEY_KEY),
    getSetting(db, BYBIT_BSC_REQUIRED_CONFIRMATIONS_KEY),
  ]);
  const apiKey = pick(keySetting, config.BSCSCAN_API_KEY);
  const parsed = confirmSetting != null ? Number(confirmSetting) : NaN;
  const requiredConfirmations =
    Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : config.BYBIT_BSC_REQUIRED_CONFIRMATIONS;
  return {
    apiBase: config.BSCSCAN_API_BASE,
    apiKey,
    requiredConfirmations,
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
  const { walletAmount, rate, ...baseArgs } = args;
  const created = await createOrderDirect(db, baseArgs);
  if (!created) return null;
  const finalized = await finalizeOrderPayment(db, created.id, {
    currency: OrderCurrency.USDT,
    rate,
    method: PaymentMethod.BYBIT_BSC,
  });
  // Spend the USDT credit balance against the finalized USDT total (no-op when
  // walletAmount is unset). Re-read so callers see the updated walletUsed/total.
  await applyUsdtWalletToOrder(db, created.id, walletAmount);
  return walletAmount != null ? getOrder(db, created.id) : finalized;
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

/**
 * Every Bybit BSC order still in flight — PENDING_PAYMENT (no deposit seen
 * yet) PLUS the two states a still-confirming deposit can already occupy
 * (PAYMENT_DETECTED/CONFIRMING). Used to re-match a deposit that was already
 * tied to an order on a previous poll cycle by its own txid, instead of
 * falling through to amount-matching (which only `listPendingBybitBscOrders`
 * — PENDING_PAYMENT only — should ever be used for, since amount-matching a
 * deposit that's already claimed by an order would be redundant at best and
 * a confused-deputy risk at worst).
 */
export function listInFlightBybitBscOrders(db: Db, now: Date) {
  return db.order.findMany({
    where: {
      status: { in: [OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING] },
      paymentMethod: PaymentMethod.BYBIT_BSC,
      expiresAt: { gt: now },
    },
    include: { user: true },
  });
}

/**
 * Record that a still-confirming on-chain deposit (Bybit status 1/2, not yet
 * its own "Success") has been matched to an order. Display-only — does NOT
 * claim the `processed_bybit_tx` ledger (that stays exclusively
 * `deliverPaidBybitBscOrder`'s job, gated on Bybit status 3) and does NOT
 * gate delivery in any way.
 *
 * Safe to call every poll cycle for the same still-confirming deposit: it
 * no-ops once the order has moved past PENDING_PAYMENT (either because a
 * previous cycle already recorded it, or because the confirmation tracker —
 * a separate poller — advanced it further in the meantime). The race
 * between this check and the transition itself is closed by
 * `transitionOrderStatus`'s own atomic claim, not by this read; a lost race
 * there is swallowed as the same benign no-op.
 *
 * Returns whether the transition actually applied THIS call — the caller
 * (bybitBscDeposit.ts) uses this to decide whether to push a live bubble
 * edit, so a deposit still sitting at PAYMENT_DETECTED on cycle 2/3 doesn't
 * keep re-editing the bubble back to "just detected" after the confirmation
 * tracker has already moved it on to CONFIRMING.
 */
export async function recordBybitBscPaymentDetected(
  db: Db,
  args: { orderId: number; bybitTxId: string; network: string },
): Promise<boolean> {
  const order = await getOrder(db, args.orderId);
  if (!order || order.status !== OrderStatus.PENDING_PAYMENT) return false;
  await db.order.update({
    where: { id: args.orderId },
    data: {
      bybitTxid: args.bybitTxId,
      network: args.network,
      firstDetectedAt: order.firstDetectedAt ?? new Date(),
    },
  });
  return tryTransitionOrderStatus(db, {
    orderId: args.orderId,
    from: OrderStatus.PENDING_PAYMENT,
    to: OrderStatus.PAYMENT_DETECTED,
    meta: `bybitTxId=${args.bybitTxId}`,
  });
}

/** Orders the confirmation tracker should poll: a Bybit BSC deposit already
 * matched (bybitTxid set) but not yet Bybit-confirmed. Includes `user` (the
 * tracker needs its language to render/push the live tracking bubble). */
export function listTrackedBybitBscOrders(db: Db) {
  return db.order.findMany({
    where: {
      paymentMethod: PaymentMethod.BYBIT_BSC,
      status: { in: [OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING] },
      bybitTxid: { not: null },
    },
    include: { user: true },
  });
}

/**
 * Record one confirmation-count observation from the block-explorer tracker.
 * Always bumps `confirmations`/`requiredConfirmations` (a plain field
 * update — no history row; writing one per confirmation tick would mean up
 * to `requiredConfirmations` rows per order for no analytical value, unlike
 * an actual status change). Transitions PAYMENT_DETECTED -> CONFIRMING on
 * the first confirmation seen, then CONFIRMING -> CONFIRMED once
 * `confirmations` reaches `requiredConfirmations` (stamping `confirmedAt`
 * the first time only). Display-only: NEVER transitions toward
 * PENDING_VERIFICATION/DELIVERED — that stays exclusively
 * `deliverPaidBybitBscOrder`'s job, gated on Bybit's own status-3 report.
 *
 * Returns the order's status AFTER this call (so the caller can push a live
 * bubble update with the right content even when a status transition
 * happened mid-call), or `null` if it no-op'd because the order had already
 * left PAYMENT_DETECTED/CONFIRMING by the time this ran (e.g. the deposit
 * poller already delivered it on the same cycle) — `tryTransitionOrderStatus`
 * makes the race-loss path safe, this guard just also avoids writing a stale
 * confirmation count over a delivered order.
 */
export async function recordBybitBscConfirmationProgress(
  db: Db,
  args: { orderId: number; confirmations: number; requiredConfirmations: number },
): Promise<string | null> {
  const order = await getOrder(db, args.orderId);
  if (!order) return null;
  if (order.status !== OrderStatus.PAYMENT_DETECTED && order.status !== OrderStatus.CONFIRMING) return null;

  await db.order.update({
    where: { id: args.orderId },
    data: { confirmations: args.confirmations, requiredConfirmations: args.requiredConfirmations },
  });

  let currentStatus: string = order.status;

  if (currentStatus === OrderStatus.PAYMENT_DETECTED && args.confirmations >= 1) {
    const moved = await tryTransitionOrderStatus(db, {
      orderId: args.orderId,
      from: OrderStatus.PAYMENT_DETECTED,
      to: OrderStatus.CONFIRMING,
      meta: `confirmations=${args.confirmations}/${args.requiredConfirmations}`,
    });
    if (moved) currentStatus = OrderStatus.CONFIRMING;
  }

  if (currentStatus === OrderStatus.CONFIRMING && args.confirmations >= args.requiredConfirmations) {
    await db.order.update({ where: { id: args.orderId }, data: { confirmedAt: new Date() } });
    const moved = await tryTransitionOrderStatus(db, {
      orderId: args.orderId,
      from: OrderStatus.CONFIRMING,
      to: OrderStatus.CONFIRMED,
      meta: `confirmations=${args.confirmations}/${args.requiredConfirmations}`,
    });
    if (moved) currentStatus = OrderStatus.CONFIRMED;
  }

  return currentStatus;
}

/**
 * Escalate a tracked order to FAILED after the tracker's in-memory lookup-
 * failure grace period is exhausted (the tx genuinely seems to have
 * vanished/reorged off-chain, not just a transient explorer hiccup). Returns
 * whether the transition actually applied (false if the order already left
 * PAYMENT_DETECTED/CONFIRMING by the time this runs — e.g. delivered on the
 * same cycle by the deposit poller).
 */
export async function recordBybitBscTrackingFailed(db: Db, args: { orderId: number; reason: string }): Promise<boolean> {
  const order = await getOrder(db, args.orderId);
  if (!order) return false;
  if (order.status !== OrderStatus.PAYMENT_DETECTED && order.status !== OrderStatus.CONFIRMING) return false;
  return tryTransitionOrderStatus(db, {
    orderId: args.orderId,
    from: order.status,
    to: OrderStatus.FAILED,
    meta: args.reason,
  });
}

export type BybitBscDeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
  | { status: "already_processed" }
  | { status: "stale" };

/** Every pre-delivery state a Bybit BSC order can sit in before Bybit's own
 * "Success" report — the confirmation tracker may have already advanced it
 * through some of these; delivery accepts all of them (gap #2 fix). */
const PRE_DELIVERY_STATUSES: string[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAYMENT_DETECTED,
  OrderStatus.CONFIRMING,
  OrderStatus.CONFIRMED,
];

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
      if (!order || !PRE_DELIVERY_STATUSES.includes(order.status)) {
        return { status: "stale" as const };
      }
      await tx.order.update({
        where: { id: args.orderId },
        data: { bybitTxid: args.bybitTxId, paidAt: new Date() },
      });
      await transitionOrderStatus(tx, {
        orderId: args.orderId,
        from: order.status,
        to: OrderStatus.PENDING_VERIFICATION,
        meta: `bybitTxId=${args.bybitTxId}`,
      });
      const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: 0 });
      logger.info(`Auto-delivered Bybit BSC order ${delivered.orderCode} for transaction ${args.bybitTxId}`);
      return { status: "delivered" as const, order: delivered, credentials };
    });
  } catch (e) {
    await db.processedBybitTx
      .update({ where: { bybitTxId: args.bybitTxId }, data: { outcome: "delivery_failed" } })
      .catch(() => undefined);
    // Reflect this on the order too (the transaction above rolled back, so
    // the order's actual current status is whatever it was before this
    // attempt) and alert admins durably via the outbox — this crud layer has
    // no Bot API handle for a direct send, and a FAILED transition needs a
    // retryable alert regardless of which caller's context it originated
    // from. Only enqueues once: a retry on the SAME bybitTxId never reaches
    // this catch again (the ledger claim above already failed it as
    // "already_processed" before this transaction even starts).
    const order = await getOrder(db, args.orderId).catch(() => null);
    if (order) {
      const moved = await tryTransitionOrderStatus(db, {
        orderId: args.orderId,
        from: order.status,
        to: OrderStatus.FAILED,
        meta: `delivery_failed: ${String(e).slice(0, 200)}`,
      });
      if (moved) {
        await enqueueOrderPipelineFailed(db, {
          orderId: args.orderId,
          orderCode: order.orderCode,
          reason: `Delivery failed after payment was detected: ${String(e).slice(0, 200)}`,
        }).catch(() => undefined);
      }
    }
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
