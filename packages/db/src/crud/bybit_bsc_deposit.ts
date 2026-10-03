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
 * An amount that's neither a clean (at-or-above-total) match nor uniquely
 * attributable as underpaid to one pending order is "unmatched" and left for
 * manual review (M-14, backend audit 2026-07-31 — see markUnderpaidBybitBsc).
 *
 * Idempotency: shares the SAME `processed_bybit_tx` ledger as Internal
 * Transfer. This is safe because the two methods' txId formats never
 * collide — Internal Transfer ids are short numeric ledger ids, on-chain
 * BEP20 ids are 0x-prefixed 64-hex-char transaction hashes.
 */
import { config } from "@app/core/config";
import { OrderStatus, OrderCurrency, OrderKind, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import { PaymentLogEvent } from "@app/core/payments/logEvents";
import type { ProcessedBybitTx } from "@prisma/client";
import type { PrismaClient, Tx } from "../client";
import type { ServiceChannel } from "@app/core/services";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, createOrderDirect, settlePaidOrder, applyUsdtWalletToOrder } from "./orders";
import { transitionOrderStatus, tryTransitionOrderStatus } from "./orderStatus";
import { enqueueOrderPipelineFailed, enqueueAdminOverpaid } from "./notifications";
import { getSetting, getDecryptedSetting, setSetting } from "./settings";
import { finalizeOrderPayment } from "./pricing";
import { BYBIT_API_KEY_KEY, BYBIT_API_SECRET_KEY } from "./bybit_deposit";
import { parseMinAmount, BYBIT_BSC_MIN_AMOUNT_KEY } from "./_minAmount";
import { settleWalletTopup, isLateSettleableWalletTopup } from "./wallet_topup";
import { POLL_HEALTH_KEYS, getPollHealth, recordPollHealth, type PollHealth } from "./poll_health";
import { AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES } from "./binance_internal";
import { getPendingPaymentAttempt, confirmPaymentAttempt } from "./payments";

// ---------------------------------------------------------------------------
// Resolved config (web-admin Settings win; .env is the bootstrap/recovery
// fallback, plan.md §16). Read per-request/per-poll so an edit in /settings
// takes effect on the next cycle without a restart (like TokoPay).
// ---------------------------------------------------------------------------

export const BYBIT_BSC_DEPOSIT_ADDRESS_KEY = "bybit_bsc_deposit_address";
// On/off toggle (web admin), independent of Internal Transfer's. Default ON:
// only the literal "false" disables.
export const BYBIT_BSC_ENABLED_KEY = "bybit_bsc_enabled";
// Declared in ./_minAmount (the leaf module that also parses it) so
// orderMinimums.ts can read all six rails' keys without importing this
// file — see that module's own comment for the import cycle that avoids.
export { BYBIT_BSC_MIN_AMOUNT_KEY } from "./_minAmount";

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
    getDecryptedSetting(db, BYBIT_API_KEY_KEY),
    getDecryptedSetting(db, BYBIT_API_SECRET_KEY),
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
    getDecryptedSetting(db, BSCSCAN_API_KEY_KEY),
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
 * the central-IDR total converts once at `rate` (rounded up to the next 0.01) + unique
 * cents, with the BSC auto-confirm payment window. No transfer note (BEP20
 * carries none).
 */
export async function createBybitBscOrder(
  db: Db,
  args: {
    user: { id: number; role: string };
    /** Bot or website — forwarded to createOrderDirect's service guard. */
    channel: ServiceChannel;
    productId: number;
    quantity: number;
    voucherCode?: string | null;
    /** Rupiah per 1 USDT (usd_idr_rate) — required for the USDT path. */
    rate: Decimal.Value;
    /** Optional USDT credit balance to spend on this order (clamped to total). */
    walletAmount?: Decimal.Value;
    /** Stringified JSON of the buyer's manual_with_info answers (validated by
     * the caller). Forwarded verbatim to createOrderDirect; null otherwise. */
    customerData?: string | null;
    /** Client-minted checkout attempt id (A1) — forwarded verbatim to
     * createOrderDirect via the `...baseArgs` spread below; see
     * {@link DuplicateCheckoutIntentError} in orders.ts for the collision
     * contract this enforces. */
    checkoutIntentId?: string | null;
  },
) {
  const { walletAmount, rate, ...baseArgs } = args;
  const created = await createOrderDirect(db, baseArgs);
  if (!created) return null;
  const finalized = await finalizeOrderPayment(db, created.id, {
    currency: OrderCurrency.USDT,
    rate,
    method: PaymentMethod.BYBIT_BSC,
    // The credit this order is about to spend, so the rail-minimum guard inside
    // judges what the gateway will really be asked for rather than the total
    // before the credit (whole-branch review D6). Passed unclamped; the spend
    // itself is still `applyUsdtWalletToOrder`'s, two lines down.
    walletAmount,
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
 * tracker needs its language to render/push the live tracking bubble).
 *
 * `orderBy: { id: "asc" }` is load-bearing, not cosmetic: bybitBscConfirmationTracker.ts's
 * `createRotatingCursor()` indexes into this array by position across
 * successive `pollOnce` calls, assuming the same order each time so its
 * rotating window covers every tracked order over ceil(n / MAX_ORDERS_PER_CYCLE)
 * cycles instead of re-visiting (or skipping) rows. SQLite's default
 * unindexed scan order happened to match insertion order, which made this
 * work without an explicit `orderBy` pre-migration; Postgres gives no such
 * guarantee, so it must be explicit here. */
export function listTrackedBybitBscOrders(db: Db) {
  return db.order.findMany({
    where: {
      paymentMethod: PaymentMethod.BYBIT_BSC,
      status: { in: [OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING] },
      bybitTxid: { not: null },
    },
    include: { user: true },
    orderBy: { id: "asc" },
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
 * Also clears `trackingStaleAt` (M-11 fix, backend audit 2026-07-31): a
 * successful lookup here means the explorer recovered, so any earlier
 * "tracking is stale" flag from `recordBybitBscTrackingStale` no longer
 * applies.
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
    // A successful lookup also clears any previously-set `trackingStaleAt` —
    // the explorer recovered, so a future degradation gets its own fresh
    // admin alert instead of staying silently suppressed by the old flag.
    data: { confirmations: args.confirmations, requiredConfirmations: args.requiredConfirmations, trackingStaleAt: null },
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
 * Flag a tracked order's on-chain tracking as stale/uncertain once the
 * tracker's in-memory lookup-failure grace period is exhausted (the tx
 * genuinely seems to have vanished/reorged off-chain, or a flaky free-tier
 * explorer API key, not just a one-off hiccup). Deliberately *non-terminal*
 * (M-11 fix, backend audit 2026-07-31) — previously this escalated the order
 * straight to FAILED, but FAILED is not in `PRE_DELIVERY_STATUSES`, so a later
 * genuine Bybit "Success" report could never auto-deliver it again. Setting
 * `trackingStaleAt` instead leaves the order in PAYMENT_DETECTED/CONFIRMING
 * (still inside `PRE_DELIVERY_STATUSES`), so `deliverPaidBybitBscOrder` can
 * still claim and deliver it whenever Bybit's own report comes in.
 *
 * Idempotent by design: returns false (no-op) both when the order already
 * left PAYMENT_DETECTED/CONFIRMING (e.g. delivered on the same cycle by the
 * deposit poller) AND when `trackingStaleAt` was already set from an earlier
 * cycle — the caller uses the return value to fire its admin alert exactly
 * once per staleness episode, not on every subsequent poll tick.
 */
export async function recordBybitBscTrackingStale(db: Db, args: { orderId: number; reason: string }): Promise<boolean> {
  const order = await getOrder(db, args.orderId);
  if (!order) return false;
  if (order.status !== OrderStatus.PAYMENT_DETECTED && order.status !== OrderStatus.CONFIRMING) return false;
  if (order.trackingStaleAt != null) return false;
  const res = await db.order.updateMany({
    where: {
      id: args.orderId,
      status: { in: [OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING] },
      trackingStaleAt: null,
    },
    data: { trackingStaleAt: new Date() },
  });
  return res.count === 1;
}

export type BybitBscDeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
  | { status: "processing"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>> }
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
  // 1. Claim the tx id. A duplicate normally means another cycle already
  //    handled it — UNLESS the prior claim's outcome is in
  //    AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES (today just "delivery_failed"):
  //    that never actually delivered anything, so the tx id must stay
  //    re-claimable, or the buyer's payment is silently lost forever behind a
  //    stuck idempotency row (Task 16 — this rail previously had NO re-claim
  //    at all, the only deliverPaid*Order that didn't). "unmatched" is
  //    deliberately NOT re-claimable on this rail: this deposit is matched to
  //    a pending order purely by amount, with no memo — see
  //    AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES's doc-comment
  //    (binance_internal.ts) for the money-loss scenario that excluding it
  //    fixes (an old stray "unmatched" deposit auto-matching a later,
  //    unrelated order that happens to share its total). The reclaim is a
  //    compare-and-swap, not a transaction: read the row, then gate a single
  //    `updateMany` on the exact values that read returned. `count === 1`
  //    therefore PROVES the row was still in that state at the instant of
  //    the write, so the captured prior values are trustworthy;
  //    `count === 0` means a racer got there first and already_processed is
  //    the right answer.
  //
  //    An interactive $transaction would be worse here, not better — see
  //    deliverPaidInternalOrder (binance_internal.ts) step 1 for the full
  //    reasoning (WAL + Prisma's deferred-BEGIN interactive transactions make
  //    two racing reclaims collide with SQLITE_BUSY_SNAPSHOT instead of
  //    degrading gracefully).
  //
  //    `reclaimedFrom` remembers exactly what the reclaim overwrote
  //    (outcome/orderId/amount) so step 2 can put it back if this turns out
  //    to be a stale match — this rail's amount-matching means a reclaim can
  //    land on the WRONG order, and unlike Binance there is no
  //    manualMatchTx/dismissUnmatchedTx equivalent for Bybit at all, so an
  //    unreverted stale reclaim would strand the row with no recovery path,
  //    automatic or manual.
  let reclaimedFrom: Pick<ProcessedBybitTx, "outcome" | "orderId" | "amount"> | null = null;
  try {
    await db.processedBybitTx.create({
      data: { bybitTxId: args.bybitTxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const prior = await db.processedBybitTx.findUnique({ where: { bybitTxId: args.bybitTxId } });
    if (!prior || !(AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES as readonly string[]).includes(prior.outcome)) {
      logger.info(
        {
          event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
          orderId: args.orderId,
          provider: PaymentMethod.BYBIT_BSC,
          providerPaymentId: args.bybitTxId,
          status: "already_processed",
        },
        `Skipped settling Bybit BSC transaction ${args.bybitTxId} for order ${args.orderId} because it had already been processed — its ledger row is in a terminal outcome that may not be reclaimed, so nothing was delivered or credited twice`,
      );
      return { status: "already_processed" };
    }
    const reclaimed = await db.processedBybitTx.updateMany({
      where: { bybitTxId: args.bybitTxId, outcome: prior.outcome, orderId: prior.orderId },
      data: { orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
    if (reclaimed.count === 0) {
      logger.info(
        {
          event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
          orderId: args.orderId,
          provider: PaymentMethod.BYBIT_BSC,
          providerPaymentId: args.bybitTxId,
          status: "already_processed",
        },
        `Skipped settling Bybit BSC transaction ${args.bybitTxId} for order ${args.orderId} because it had already been processed — another path won the race to reclaim its ledger row, so nothing was delivered or credited twice`,
      );
      return { status: "already_processed" };
    }
    reclaimedFrom = { outcome: prior.outcome, orderId: prior.orderId, amount: prior.amount };
  }

  // 2. Deliver. On failure, flag the ledger row so we don't silently retry
  //    forever (e.g. paid but out of stock) and let the caller alert an admin.
  try {
    return await db.$transaction(async (tx: Tx) => {
      const order = await getOrder(tx, args.orderId);
      // A cancelled WALLET_TOPUP is still payable (isLateSettleableWalletTopup):
      // the deposit arrived after the window closed, and a top-up reserves
      // nothing that cancelling gave away. A cancelled PRODUCT order is NOT —
      // its stock went back to the pool — so it keeps falling through to
      // "stale". CANCELLED stays OUT of PRE_DELIVERY_STATUSES itself, which
      // is what keeps the status normalization below from swallowing it.
      if (!order || (!PRE_DELIVERY_STATUSES.includes(order.status) && !isLateSettleableWalletTopup(order))) {
        // If step 1 re-claimed this row from a non-delivering outcome, undo
        // that claim — restore the outcome/orderId/amount it overwrote —
        // instead of leaving the row "matched" against an order that never
        // got delivered. Left as "matched", the deposit would become
        // permanently unreachable: "matched" is excluded from
        // AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES, so it can never be re-claimed
        // again, and
        // there is no manual-match tool for Bybit either. A fresh claim
        // (reclaimedFrom === null) has nothing to undo — that row simply
        // stays "matched" against this now-stale order, the same
        // pre-existing behavior as before this fix.
        if (reclaimedFrom) {
          await tx.processedBybitTx.update({
            where: { bybitTxId: args.bybitTxId },
            data: { outcome: reclaimedFrom.outcome, orderId: reclaimedFrom.orderId, amount: reclaimedFrom.amount },
          });
          logger.warn(
            `Bybit BSC deposit ${args.bybitTxId} was amount-matched to order ${args.orderId}, but that order is no longer awaiting payment — the ledger row was returned to "${reclaimedFrom.outcome}" so a later poller pass can still re-claim it. This usually means the amount-matching heuristic picked the wrong order, or the order was delivered/expired/failed by another path first.`,
          );
        }
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.BYBIT_BSC,
            providerPaymentId: args.bybitTxId,
            status: "stale",
          },
          `Did not settle Bybit BSC transaction ${args.bybitTxId} because order ${args.orderId} is no longer payable — it was cancelled, already settled, or is not a Bybit BSC order, so the ledger row is marked stale and a human decides what the payment was for`,
        );
        return { status: "stale" as const };
      }
      // Trustance Phase A Task A2b: look up this order's own PENDING Payment
      // ledger row (if any) BEFORE settling, so both branches below can
      // confirm it once delivery actually succeeds. May legitimately be null
      // — orders created before this ledger was wired up, or a rail change
      // that left no PENDING row — and that is never treated as an error.
      const pendingPayment = await getPendingPaymentAttempt(tx, args.orderId).catch((err) => {
        logger.warn({ err }, `Could not look up the Payment ledger row for order ${args.orderId} — this only keeps a benign miss from stopping the settlement; a genuine database error here still aborts this whole transaction, exactly as it would without this lookup`);
        return null;
      });
      if (order.kind === OrderKind.WALLET_TOPUP) {
        // settleWalletTopup's own idempotency claim only matches
        // status === PENDING_PAYMENT (same idiom as approveOrder's claim).
        // But unlike the other 5 gateways, a Bybit BSC deposit is on-chain and
        // legitimately passes through PAYMENT_DETECTED/CONFIRMING/CONFIRMED
        // (the confirmation tracker, kind-agnostic — see PRE_DELIVERY_STATUSES
        // above) before Bybit reports status 3 ("Success") and this function
        // ever runs — so `order.status` here is very often NOT PENDING_PAYMENT
        // by delivery time. The PRE_DELIVERY_STATUSES check above already
        // established this is a legitimate pre-delivery state (not stale), so
        // it's safe to normalize back to PENDING_PAYMENT here, inside the SAME
        // transaction settleWalletTopup's own claim runs in — the transient
        // state is never externally observable (no separate commit, and
        // settleWalletTopup writes no OrderStatusHistory row for this
        // transition either, mirroring approveOrder's claim idiom).
        //
        // Scoped to PRE_DELIVERY_STATUSES on purpose: a CANCELLED top-up also
        // reaches this line now (a late-arriving deposit on a window that had
        // already closed), and settleWalletTopup claims CANCELLED directly —
        // normalizing that one away would erase the very fact it needs in
        // order to log that a top-up was credited past its window.
        if (order.status !== OrderStatus.PENDING_PAYMENT && PRE_DELIVERY_STATUSES.includes(order.status)) {
          await tx.order.update({ where: { id: args.orderId }, data: { status: OrderStatus.PENDING_PAYMENT } });
        }
        const { order: settled } = await settleWalletTopup(tx, args.orderId, { amount: args.amount });
        if (pendingPayment) {
          // Best-effort: swallows the benign race where a concurrent
          // poller/webhook already confirmed this same Payment row
          // (ValidationError, count!==1) — expected and harmless. A genuine
          // database error here still aborts this whole transaction
          // regardless of this .catch, since Postgres poisons an
          // interactive transaction on any failed statement; this call
          // cannot rescue the settlement from that, it only prevents the
          // benign race from doing so.
          //
          // Financial Ledger M3: the confirmation also captures the on-chain
          // transaction hash, which is what `Payment.providerTransactionId` is
          // reconciled against when a provider settlement report is matched. No
          // `fee`/`netAmount` are passed: a BSC deposit reports no gateway cut
          // at all (the gas the SENDER paid is not deducted from what reaches
          // this shop), so both columns stay null — Payment.fee's documented
          // "not known" (prisma/schema.prisma), which is deliberately NOT the
          // same statement as a fee of zero.
          await confirmPaymentAttempt(tx, {
            paymentId: pendingPayment.id,
            providerTransactionId: args.bybitTxId,
          }).catch((err) =>
            logger.warn({ err }, `Could not confirm the Payment ledger row for order ${settled.orderCode} — that row is left stuck PENDING and needs manual reconciliation. Whether the settlement itself survived depends on which failure this was, and this line cannot tell them apart: the benign race this catch exists for (another poller or webhook confirmed the same row first) leaves the order settled, but a real database error — a unique violation on providerTransactionId, say — has already aborted this interactive transaction in Postgres, so the settlement rolls back with it. Check whether the order actually reached its settled status before treating this as harmless`),
          );
        }
        // settleWalletTopup (packages/db/src/crud/wallet_topup.ts) already
        // enqueued the buyer's WALLET_TOPUP_CREDITED_DM outbox row, one frame
        // deeper on the line above, behind its own atomic claim — that single
        // call site is shared by all six top-up-capable rails, this one
        // included, so nothing here may enqueue it again or DM the buyer
        // directly. `onDelivered` (apps/order-bot/src/payments/
        // bybitBscDeposit.ts) no longer sends a DM for a WALLET_TOPUP order
        // either; it only nudges the outbox dispatcher and updates the
        // payment bubble.
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.BYBIT_BSC,
            providerPaymentId: args.bybitTxId,
            status: "delivered",
          },
        `Settled Bybit BSC wallet top-up order ${settled.orderCode} for transaction ${args.bybitTxId} — the buyer's balance was credited and their notification queued`,
        );
        return { status: "delivered" as const, order: settled, credentials: [] };
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
      const result = await settlePaidOrder(tx, args.orderId, { adminId: 0 });
      if (pendingPayment) {
        // See the WALLET_TOPUP branch above for what this .catch actually
        // protects against, and for why no fee figures are captured here.
        await confirmPaymentAttempt(tx, {
          paymentId: pendingPayment.id,
          providerTransactionId: args.bybitTxId,
        }).catch((err) =>
          logger.warn({ err }, `Could not confirm the Payment ledger row for order ${result.order.orderCode} — that row is left stuck PENDING and needs manual reconciliation. Whether the settlement itself survived depends on which failure this was, and this line cannot tell them apart: the benign race this catch exists for (another poller or webhook confirmed the same row first) leaves the order settled, but a real database error — a unique violation on providerTransactionId, say — has already aborted this interactive transaction in Postgres, so the settlement rolls back with it. Check whether the order actually reached its settled status before treating this as harmless`),
        );
      }
      // Overpayment: the buyer sent more USDT on-chain than the order total.
      // Still deliver (handled above) but flag the ledger row and alert admins
      // so the excess can be refunded/credited manually — never
      // auto-refunded. Identical shape to bybit_deposit.ts's own branch and to
      // binance_internal.ts's (M-13, backend audit 2026-07-31); this rail and
      // Internal Transfer were the last two of the six that delivered an
      // overpayment and surfaced the excess to nobody. Unconditional with
      // respect to delivery type — a buyer can overpay regardless of whether
      // the SKU auto-delivers or is fulfilled by hand.
      //
      // "overpaid" is as terminal as the "matched" it replaces on the SHARED
      // `processed_bybit_tx` ledger this rail uses with Internal Transfer:
      // AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES holds only "delivery_failed", so
      // neither rail's re-claim behaviour changes (see that constant's
      // doc-comment in binance_internal.ts), and the `catch` below still
      // overwrites this row with "delivery_failed" if the transaction throws
      // after this point.
      const paidAmount = new Decimal(args.amount);
      const excess = paidAmount.minus(order.totalAmount);
      if (excess.greaterThan(0)) {
        await tx.processedBybitTx.update({ where: { bybitTxId: args.bybitTxId }, data: { outcome: "overpaid" } });
        await enqueueAdminOverpaid(tx, {
          orderId: result.order.id,
          orderCode: result.order.orderCode,
          paid: paidAmount,
          expected: order.totalAmount,
          excess,
          currency: order.currency,
        });
        logger.warn(
          `Bybit BSC order ${result.order.orderCode} was overpaid — got ${paidAmount.toString()}, expected ${order.totalAmount.toString()} (excess ${excess.toString()} ${order.currency}) — flagged for manual refund/credit, an admin alert was enqueued`,
        );
      }
      if (result.kind === "delivered") {
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.BYBIT_BSC,
            providerPaymentId: args.bybitTxId,
            status: "delivered",
          },
        `Auto-delivered Bybit BSC order ${result.order.orderCode} for transaction ${args.bybitTxId}`,
        );
        return { status: "delivered" as const, order: result.order, credentials: result.credentials };
      }
      logger.info(
        {
          event: PaymentLogEvent.PAYMENT_CONFIRMED,
          orderId: args.orderId,
          provider: PaymentMethod.BYBIT_BSC,
          providerPaymentId: args.bybitTxId,
          status: "processing",
        },
      `Bybit BSC order ${result.order.orderCode} paid — queued for manual fulfilment (transaction ${args.bybitTxId})`,
      );
      return { status: "processing" as const, order: result.order };
    }, { timeout: 15000 });
  } catch (e) {
    await db.processedBybitTx
      .update({ where: { bybitTxId: args.bybitTxId }, data: { outcome: "delivery_failed" } })
      .catch(() => undefined);
    // Reflect this on the order too (the transaction above rolled back, so
    // the order's actual current status is whatever it was before this
    // attempt) and alert admins durably via the outbox — this crud layer has
    // no Bot API handle for a direct send, and a FAILED transition needs a
    // retryable alert regardless of which caller's context it originated
    // from. Once per delivery ATTEMPT, not once per deposit: before Task 16
    // a retry on the same bybitTxId could never reach this catch again,
    // because the ledger claim rejected it as "already_processed" first. Now
    // that a "delivery_failed" row is re-claimable, a later cycle can match
    // the same deposit to a DIFFERENT pending order and fail again — so one
    // deposit can produce more than one alert over time. That is intended:
    // each alert names the order it actually failed against, and an admin
    // needs to see each one.
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

/**
 * A deposit uniquely attributable to one pending order but short of its total
 * beyond tolerance (M-14, backend audit 2026-07-31): flag UNDERPAID for admin
 * review (idempotent), mirroring `markUnderpaidBybit` (Internal Transfer) /
 * `markUnderpaid` (Binance Internal). There is no memo here to confirm
 * intent, so the caller only reaches this once its own amount-only search
 * (`matchUnderpaidByAmount`) found exactly one pending order pricier than the
 * received amount (and within the underpaid floor) — the same ambiguity
 * guard as the matched path, just on the short side. Only ever called for a
 * Bybit-status-3 ("Success") deposit — a still-confirming one isn't judged
 * on amount yet, same as the matched path.
 *
 * Same two-phase idempotency shape as `deliverPaidBybitBscOrder`: the ledger
 * claim (UNIQUE gate on `bybitTxId`) happens first and is NOT rolled back on
 * a later failure; the order mutation (bybitTxid/adminNote + the UNDERPAID
 * transition) is wrapped in its own `$transaction` so a partial failure
 * can't leave the order half-updated. If the transaction throws, the ledger
 * row is tagged `underpaid_flag_failed` for ops visibility instead of
 * staying claimed with no trace. Uses `tryTransitionOrderStatus` (not the
 * throwing variant) so losing a status race to another poller/tracker is a
 * benign, reported "did not apply" — and the return value reflects that:
 * `false` whenever the order wasn't actually flagged, never a blind `true`.
 */
export async function markUnderpaidBybitBsc(
  db: PrismaClient,
  args: { orderId: number; bybitTxId: string; amount: Decimal.Value },
): Promise<boolean> {
  try {
    await db.processedBybitTx.create({
      data: { bybitTxId: args.bybitTxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "underpaid" },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }

  try {
    return await db.$transaction(async (tx: Tx) => {
      const order = await getOrder(tx, args.orderId);
      if (!order || order.status !== OrderStatus.PENDING_PAYMENT) return false; // stale — moved on already
      await tx.order.update({
        where: { id: args.orderId },
        data: {
          bybitTxid: args.bybitTxId,
          adminNote: `[underpaid] received ${new Decimal(args.amount).toString()} via tx ${args.bybitTxId}`,
        },
      });
      return tryTransitionOrderStatus(tx, {
        orderId: args.orderId,
        from: OrderStatus.PENDING_PAYMENT,
        to: OrderStatus.UNDERPAID,
        meta: `bybitTxId=${args.bybitTxId}`,
      });
    }, { timeout: 15000 });
  } catch (e) {
    await db.processedBybitTx
      .update({ where: { bybitTxId: args.bybitTxId }, data: { outcome: "underpaid_flag_failed" } })
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
// network congestion vs. an API outage). Delegates to the generic per-rail
// store (packages/db/src/crud/poll_health.ts, Task 10) — see that module for
// the JSON-parse / sticky-field / consecutive-failure rules this used to
// carry directly, including why a rate-limit hit neither increments nor
// resets `consecutiveFailures`.

/** Single settings key holding the Bybit BSC poller's last-cycle heartbeat as JSON. */
export const BYBIT_BSC_POLL_HEALTH_KEY = POLL_HEALTH_KEYS.bybitBsc;

/** Alias of the generic `PollHealth` shape — byte-identical to the old
 * standalone interface, kept as a named type so existing imports resolve
 * unchanged. */
export type BybitBscPollHealth = PollHealth;

/** Read the Bybit BSC poller heartbeat; all-null when it has never run. */
export function getBybitBscPollHealth(db: Db): Promise<BybitBscPollHealth> {
  return getPollHealth(db, "bybitBsc");
}

/** Record one Bybit BSC poll cycle's heartbeat. Called by the poller each tick. */
export function recordBybitBscPollHealth(
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
  return recordPollHealth(db, "bybitBsc", args);
}
