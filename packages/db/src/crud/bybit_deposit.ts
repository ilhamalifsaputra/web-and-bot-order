/**
 * CRUD for the Bybit Internal Transfer (UID→UID, off-chain, instant) payment
 * method.
 *
 * Mirrors binance_internal.ts but simpler: internal transfers carry NO memo, so
 * an incoming deposit is matched to a PENDING order purely by its unique total
 * amount (USE_UNIQUE_CENTS keeps every order distinct). A deposit that's
 * neither a clean (at-or-above-total) match nor uniquely attributable as
 * underpaid to one pending order is "unmatched" and left for manual review
 * (M-14, backend audit 2026-07-31 — see markUnderpaidBybit).
 *
 * Idempotency without row locks: the `processed_bybit_tx.bybit_tx_id` UNIQUE constraint
 * is the concurrency gate — claiming the internal-deposit txID is an atomic
 * insert; a duplicate insert throws and is treated as "already processed", so
 * repeated poll cycles never double-deliver.
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
import { enqueueAdminOverpaid } from "./notifications";
import { getSetting, getDecryptedSetting, setSetting } from "./settings";
import { finalizeOrderPayment } from "./pricing";
import { parseMinAmount, BYBIT_MIN_AMOUNT_KEY } from "./_minAmount";
import { settleWalletTopup, isLateSettleableWalletTopup, flagWalletTopupOverpayment } from "./wallet_topup";
import { POLL_HEALTH_KEYS, getPollHealth, recordPollHealth, type PollHealth } from "./poll_health";
import { AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES } from "./binance_internal";
import { reclaimStaleMatchedClaim } from "./_staleClaim";
import { getPendingPaymentAttempt, confirmPaymentAttempt } from "./payments";

// ---------------------------------------------------------------------------
// Resolved config (web-admin Settings win; .env is the bootstrap/recovery
// fallback, plan.md §16). Read per-request/per-poll so an edit in /settings
// takes effect on the next cycle without a restart (like TokoPay).
// ---------------------------------------------------------------------------

export const BYBIT_UID_KEY = "bybit_uid";
export const BYBIT_API_KEY_KEY = "bybit_api_key";
export const BYBIT_API_SECRET_KEY = "bybit_api_secret";
// On/off toggle (web admin). Default ON: only the literal "false" disables.
export const BYBIT_ENABLED_KEY = "bybit_enabled";
// Declared in ./_minAmount (the leaf module that also parses it) so
// orderMinimums.ts can read all six rails' keys without importing this
// file — see that module's own comment for the import cycle that avoids.
export { BYBIT_MIN_AMOUNT_KEY } from "./_minAmount";

export interface BybitConfig {
  /** True only when uid + apiKey + apiSecret are all present. */
  enabled: boolean;
  uid: string;
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
 * Resolve the Bybit Internal Transfer config from Settings (with .env
 * fallback). `enabled` gates the poller, the watchdog, and the checkout
 * option. The API base and payment window stay env-only (rarely change);
 * only the UID and the API key/secret are web-editable.
 */
export async function resolveBybitConfig(db: Db): Promise<BybitConfig> {
  const [uidSetting, key, secret, flag, minAmountSetting] = await Promise.all([
    getSetting(db, BYBIT_UID_KEY),
    getDecryptedSetting(db, BYBIT_API_KEY_KEY),
    getDecryptedSetting(db, BYBIT_API_SECRET_KEY),
    getSetting(db, BYBIT_ENABLED_KEY),
    getSetting(db, BYBIT_MIN_AMOUNT_KEY),
  ]);
  const uid = pick(uidSetting, config.BYBIT_UID);
  const apiKey = pick(key, config.BYBIT_API_KEY);
  const apiSecret = pick(secret, config.BYBIT_API_SECRET);
  return {
    // Default ON: an unset/empty flag means enabled; only the literal "false"
    // (trimmed, case-insensitive) disables the method without touching creds.
    enabled: Boolean(uid && apiKey && apiSecret) && (flag ?? "").trim().toLowerCase() !== "false",
    uid,
    apiKey,
    apiSecret,
    apiBase: config.BYBIT_API_BASE,
    windowMinutes: config.BYBIT_PAYMENT_WINDOW_MINUTES,
    minAmount: parseMinAmount(minAmountSetting),
  };
}

/**
 * Create a direct order, then stamp it as a USDT/Bybit deposit payment: the
 * central-IDR total converts once at `rate` (rounded up to the next 0.01) + unique cents, with
 * the Bybit auto-confirm payment window. No transfer note (internal transfers
 * carry none).
 */
export async function createBybitOrder(
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
    method: PaymentMethod.BYBIT,
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

/** PENDING, not-yet-expired Bybit orders the deposit poller should match against. */
export function listPendingBybitOrders(db: Db, now: Date) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.BYBIT,
      expiresAt: { gt: now },
    },
    include: { user: true },
  });
}

export type BybitDeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
  | { status: "processing"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>> }
  | { status: "already_processed" }
  | { status: "stale" };

/**
 * Idempotently confirm + deliver a matched Bybit deposit.
 * Claims the on-chain txID (UNIQUE gate) then runs the normal approve/deliver
 * path. Returns "already_processed" if the tx was seen before, "stale" if the
 * order is no longer awaiting payment (delivered/expired elsewhere).
 */
export async function deliverPaidBybitOrder(
  db: PrismaClient,
  args: { orderId: number; bybitTxId: string; amount: Decimal.Value },
): Promise<BybitDeliverResult> {
  // 1. Claim the tx id. A duplicate normally means another cycle already
  //    handled it — UNLESS the prior claim's outcome is in
  //    AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES (today just "delivery_failed"):
  //    that never actually delivered anything, so the tx id must stay
  //    re-claimable, or the buyer's payment is silently lost forever behind a
  //    stuck idempotency row (H-3, backend audit 2026-07-31). "unmatched" is
  //    deliberately NOT re-claimable on this rail: this deposit is matched to
  //    a pending order purely by amount, with no memo — see
  //    AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES's doc-comment
  //    (binance_internal.ts) for the money-loss scenario that excluding it
  //    fixes (an old stray "unmatched" deposit auto-matching a later,
  //    unrelated order that happens to share its total). The reclaim is a
  //    compare-and-swap, not a transaction: read the row, then gate a single
  //    `updateMany` on the exact values that read returned. `count === 1`
  //    therefore PROVES the row was still in that state at the instant of
  //    the write, so the captured prior values are trustworthy; `count === 0`
  //    means a racer got there first and already_processed is the right
  //    answer.
  //
  //    An interactive $transaction would be worse here, not better — see
  //    deliverPaidInternalOrder (binance_internal.ts) step 1 for the full
  //    reasoning (a read-then-write inside one lets two racing reclaims both
  //    pass the check instead of degrading gracefully).
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
    // Task B2: a "matched" row whose delivery crashed before finishing is
    // recoverable for its own order — see crud/_staleClaim.ts for exactly
    // when. `reclaimedFrom` then holds "matched", so a stale outcome in step 2
    // puts the row back exactly as it was.
    const recovered =
      prior != null &&
      (await reclaimStaleMatchedClaim(db, {
        rail: "Bybit internal-transfer",
        txId: args.bybitTxId,
        prior,
        forOrderId: args.orderId,
        cas: (guard) =>
          db.processedBybitTx.updateMany({
            where: { bybitTxId: args.bybitTxId, ...guard },
            data: { amount: new Decimal(args.amount), outcome: "matched", updatedAt: new Date() },
          }),
      }));
    if (recovered) {
      reclaimedFrom = { outcome: prior.outcome, orderId: prior.orderId, amount: prior.amount };
    } else if (!prior || !(AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES as readonly string[]).includes(prior.outcome)) {
      logger.info(
        {
          event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
          orderId: args.orderId,
          provider: PaymentMethod.BYBIT,
          providerPaymentId: args.bybitTxId,
          status: "already_processed",
        },
        `Skipped settling Bybit transaction ${args.bybitTxId} for order ${args.orderId} because it had already been processed — its ledger row is in a terminal outcome that may not be reclaimed, so nothing was delivered or credited twice`,
      );
      return { status: "already_processed" };
    } else {
      const reclaimed = await db.processedBybitTx.updateMany({
        where: { bybitTxId: args.bybitTxId, outcome: prior.outcome, orderId: prior.orderId },
        data: { orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
      });
      if (reclaimed.count === 0) {
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.BYBIT,
            providerPaymentId: args.bybitTxId,
            status: "already_processed",
          },
          `Skipped settling Bybit transaction ${args.bybitTxId} for order ${args.orderId} because it had already been processed — another path won the race to reclaim its ledger row, so nothing was delivered or credited twice`,
        );
        return { status: "already_processed" };
      }
      reclaimedFrom = { outcome: prior.outcome, orderId: prior.orderId, amount: prior.amount };
    }
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
      // "stale".
      if (!order || (order.status !== OrderStatus.PENDING_PAYMENT && !isLateSettleableWalletTopup(order))) {
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
            `Bybit deposit ${args.bybitTxId} was amount-matched to order ${args.orderId}, but that order is no longer awaiting payment — the ledger row was returned to "${reclaimedFrom.outcome}" so a later poller pass can still re-claim it. This usually means the amount-matching heuristic picked the wrong order, or the order was delivered/expired by another path first.`,
          );
        }
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.BYBIT,
            providerPaymentId: args.bybitTxId,
            status: "stale",
          },
          `Did not settle Bybit transaction ${args.bybitTxId} because order ${args.orderId} is no longer payable — it was cancelled, already settled, or is not a Bybit order, so the ledger row is marked stale and a human decides what the payment was for`,
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
        const { order: settled, credited } = await settleWalletTopup(tx, args.orderId, { amount: args.amount });
        // Overpayment: same flag + admin alert the product branch below raises,
        // without changing what was credited (see flagWalletTopupOverpayment).
        await flagWalletTopupOverpayment(tx, {
          order: settled,
          credited,
          paid: args.amount,
          expected: order.totalAmount,
          rail: "Bybit",
          markLedgerOverpaid: () =>
            tx.processedBybitTx.update({ where: { bybitTxId: args.bybitTxId }, data: { outcome: "overpaid" } }),
        });
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
          // Financial Ledger M3: the confirmation also captures Bybit's own
          // deposit id, which is what `Payment.providerTransactionId` is
          // reconciled against when a provider settlement report is matched.
          // No `fee`/`netAmount` are passed: nothing in this rail's poller
          // payload reports a cut Bybit deducted, so both columns stay null —
          // Payment.fee's documented "not known" (prisma/schema.prisma), which
          // is deliberately NOT the same statement as a fee of zero.
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
        // bybitDeposit.ts) no longer sends a DM for a WALLET_TOPUP order
        // either; it only nudges the outbox dispatcher and updates the
        // payment bubble.
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.BYBIT,
            providerPaymentId: args.bybitTxId,
            status: "delivered",
          },
        `Settled Bybit wallet top-up order ${settled.orderCode} for transaction ${args.bybitTxId} — the buyer's balance was credited and their notification queued`,
        );
        return { status: "delivered" as const, order: settled, credentials: [] };
      }
      await tx.order.update({
        where: { id: args.orderId },
        data: { bybitTxid: args.bybitTxId, paidAt: new Date() },
      });
      await transitionOrderStatus(tx, {
        orderId: args.orderId,
        from: OrderStatus.PENDING_PAYMENT,
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
      // Overpayment: the buyer sent more USDT than the order total. Still
      // deliver (handled above) but flag the ledger row and alert admins so
      // the excess can be refunded/credited manually — never auto-refunded.
      // Identical shape to binance_internal.ts's own branch (M-13, backend
      // audit 2026-07-31) and to the three gateway rails': this rail's match
      // tolerance already let an overpaid deposit through to delivery, and
      // until now it left no ledger flag and no admin alert, so the excess
      // had no operational trail for a later refund request. Unconditional
      // with respect to delivery type — a buyer can overpay regardless of
      // whether the SKU auto-delivers or is fulfilled by hand.
      //
      // Writing "overpaid" here does not disturb this rail's re-claim
      // behaviour: AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES holds only
      // "delivery_failed", and "overpaid" is as terminal as the "matched" it
      // replaces (see that constant's doc-comment in binance_internal.ts —
      // both mean a delivery actually ran). It is already a member of
      // TX_OUTCOMES, so the ops panel lists it with no schema change.
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
          `Bybit order ${result.order.orderCode} was overpaid — got ${paidAmount.toString()}, expected ${order.totalAmount.toString()} (excess ${excess.toString()} ${order.currency}) — flagged for manual refund/credit, an admin alert was enqueued`,
        );
      }
      if (result.kind === "delivered") {
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.BYBIT,
            providerPaymentId: args.bybitTxId,
            status: "delivered",
          },
        `Auto-delivered Bybit order ${result.order.orderCode} for transaction ${args.bybitTxId}`,
        );
        return { status: "delivered" as const, order: result.order, credentials: result.credentials };
      }
      logger.info(
        {
          event: PaymentLogEvent.PAYMENT_CONFIRMED,
          orderId: args.orderId,
          provider: PaymentMethod.BYBIT,
          providerPaymentId: args.bybitTxId,
          status: "processing",
        },
      `Bybit order ${result.order.orderCode} paid — queued for manual fulfilment (transaction ${args.bybitTxId})`,
      );
      return { status: "processing" as const, order: result.order };
    }, { timeout: 15000 });
  } catch (e) {
    await db.processedBybitTx
      .update({ where: { bybitTxId: args.bybitTxId }, data: { outcome: "delivery_failed" } })
      .catch(() => undefined);
    throw e;
  }
}

/**
 * A deposit uniquely attributable to one pending order but short of its total
 * beyond tolerance (M-14, backend audit 2026-07-31): flag UNDERPAID for admin
 * review (idempotent), mirroring `markUnderpaid` in binance_internal.ts. There
 * is no memo here to confirm intent, so the caller only reaches this once its
 * own amount-only search (`matchUnderpaidByAmount`) found exactly one pending
 * order pricier than the received amount (and within the underpaid floor) —
 * the same ambiguity guard as the matched path, just on the short side.
 *
 * Same two-phase idempotency shape as `deliverPaidBybitOrder`: the ledger
 * claim (UNIQUE gate on `bybitTxId`) happens first and is NOT rolled back on
 * a later failure, so a retry never re-attempts a claim that already
 * succeeded; the order mutation (bybitTxid/adminNote + the UNDERPAID
 * transition) is wrapped in its own `$transaction` so a partial failure
 * there can't leave the order half-updated. If the transaction throws, the
 * ledger row is tagged `underpaid_flag_failed` (visible for ops diagnosis)
 * instead of staying claimed with no trace of what happened. Uses
 * `tryTransitionOrderStatus` (not the throwing variant) so losing a status
 * race to another poller/tracker is a benign, reported "did not apply"
 * rather than an uncaught exception — and the return value reflects that:
 * `false` whenever the order wasn't actually flagged, never a blind `true`.
 */
export async function markUnderpaidBybit(
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
export async function recordUnmatchedBybitTx(db: Db, args: { bybitTxId: string; amount: Decimal.Value }): Promise<boolean> {
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
// Delegates to the generic per-rail store (packages/db/src/crud/poll_health.ts,
// Task 10) — see that module for the JSON-parse / sticky-field /
// consecutive-failure rules this used to carry directly, including why a
// rate-limit hit neither increments nor resets `consecutiveFailures`.

/** Single settings key holding the Bybit poller's last-cycle heartbeat as JSON. */
export const BYBIT_POLL_HEALTH_KEY = POLL_HEALTH_KEYS.bybit;

/** Alias of the generic `PollHealth` shape — byte-identical to the old
 * standalone interface, kept as a named type so existing imports resolve
 * unchanged. */
export type BybitPollHealth = PollHealth;

/** Read the Bybit poller heartbeat; all-null when it has never run. */
export function getBybitPollHealth(db: Db): Promise<BybitPollHealth> {
  return getPollHealth(db, "bybit");
}

/** Record one Bybit poll cycle's heartbeat. Called by the poller each tick. */
export function recordBybitPollHealth(
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
  return recordPollHealth(db, "bybit", args);
}
