/**
 * CRUD for the TokoPay (IDR / QRIS / VA) payment path — plan.md §15.5.
 *
 * Mirrors crud/binance_internal.ts: no row lock is needed, so the
 * `processed_tokopay_tx.trx_id` UNIQUE constraint is the idempotency gate.
 * TokoPay retries callbacks; claiming the trx id is an atomic insert and a
 * duplicate insert means "already handled" — an order can never double-deliver.
 *
 * The HTTP/webhook side (signature check, API calls) lives in
 * packages/core/src/payments/tokopay.ts; this module only mutates the DB.
 */
import {
  TOKOPAY_MERCHANT_KEY,
  TOKOPAY_SECRET_KEY,
  TOKOPAY_ENABLED_KEY,
  TOKOPAY_CHANNEL_KEY,
  type TokopayCreds,
  type TokopayOrderInfo,
} from "@app/core/payments/tokopay";
import { expectedTokopayCharge, readTokopayCharge } from "@app/core/payments/tokopayCharge";
import { OrderStatus, OrderKind, PaymentMethod, NotificationEvent, langCode } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import { PaymentLogEvent } from "@app/core/payments/logEvents";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, settlePaidOrder, commitGatewayResult } from "./orders";
import { transitionOrderStatus } from "./orderStatus";
import { enqueueNotification, enqueueAdminOverpaid } from "./notifications";
import { getSetting, getDecryptedSetting } from "./settings";
import { parseMinAmount, TOKOPAY_MIN_AMOUNT_KEY } from "./_minAmount";
import { settleWalletTopup, isLateSettleableWalletTopup, flagWalletTopupOverpayment, preservePaidWalletCreditFailure } from "./wallet_topup";
import { QRIS_RECLAIMABLE_OUTCOMES } from "./binance_internal";
import { getPendingPaymentAttempt, confirmPaymentAttempt } from "./payments";
import { reclaimStaleMatchedClaim } from "./_staleClaim";
import { undoFailedManualQrisClaim } from "./_manualQrisClaim";
import { ValidationError } from "@app/core/errors";

// Declared in ./_minAmount (the leaf module that also parses it) so
// orderMinimums.ts can read all six rails' keys without importing this
// file — see that module's own comment for the import cycle that avoids.
export { TOKOPAY_MIN_AMOUNT_KEY } from "./_minAmount";

/** Read TokoPay gateway credentials from Settings; null = the IDR/QRIS path is off. */
export async function getTokopayCreds(db: Db): Promise<(TokopayCreds & { minAmount: Decimal | null }) | null> {
  const [merchantId, secret, enabled, channel, minAmountSetting] = await Promise.all([
    getSetting(db, TOKOPAY_MERCHANT_KEY),
    getDecryptedSetting(db, TOKOPAY_SECRET_KEY),
    getSetting(db, TOKOPAY_ENABLED_KEY),
    getSetting(db, TOKOPAY_CHANNEL_KEY),
    getSetting(db, TOKOPAY_MIN_AMOUNT_KEY),
  ]);
  if (!merchantId || !secret) return null;
  if ((enabled ?? "").trim().toLowerCase() === "false") return null;
  return {
    merchantId,
    secret,
    channel: (channel ?? "QRIS").trim() || "QRIS",
    minAmount: parseMinAmount(minAmountSetting),
  };
}

/** TokoPay created a transaction but did not report a usable total for the
 *  buyer to pay (`readTokopayCharge`), so no payment instructions may be shown. */
export class TokopayChargeUnavailableError extends Error {}

/** How many characters of TokoPay's reported total an error message quotes. */
const REPORTED_TOTAL_QUOTE_LIMIT = 40;

/** TokoPay's `total_bayar` as an error message quotes it, so a format mismatch
 *  can be diagnosed from the log. It is not a secret; it is quoted (so blanks
 *  and stray characters stay visible) and capped, with its full length stated
 *  when it is cut. */
function describeReportedTotal(totalBayar: string): string {
  if (totalBayar.length <= REPORTED_TOTAL_QUOTE_LIMIT) return JSON.stringify(totalBayar);
  return `${JSON.stringify(totalBayar.slice(0, REPORTED_TOTAL_QUOTE_LIMIT))} (the first ${REPORTED_TOTAL_QUOTE_LIMIT} of ${totalBayar.length} characters)`;
}

/**
 * Cache a freshly created TokoPay transaction on its order AND record what
 * TokoPay says the buyer must pay — the figure every later paid-amount check
 * reads (`expectedTokopayCharge`). The three places that create a TokoPay
 * transaction (storefront pay page, bot checkout, bot wallet top-up) all go
 * through here, so none of them can cache a transaction without its charge.
 *
 * Returns that charge for the caller to print beside the QR. Throws
 * `TokopayChargeUnavailableError`, storing nothing, when TokoPay's total is
 * missing or implausible: without it the payment could not be verified later,
 * so the caller must treat this exactly like a failed transaction creation.
 */
export async function commitTokopayGateway(
  db: Db,
  args: {
    order: { id: number; orderCode: string; totalAmount: Decimal.Value };
    sentinel: string;
    gateway: TokopayOrderInfo;
  },
): Promise<{ committed: boolean; charge: Decimal }> {
  const reading = readTokopayCharge(args.order.totalAmount, args.gateway.totalBayar);
  if (reading.kind !== "ok") {
    throw new TokopayChargeUnavailableError(
      reading.kind === "missing"
        ? `TokoPay created a transaction for order ${args.order.orderCode} without reporting the total the buyer must pay, so no payment instructions were shown — the payment could not have been verified against anything`
        : `TokoPay reported an implausible total for order ${args.order.orderCode}: it sent ${describeReportedTotal(args.gateway.totalBayar ?? "")} against an order total of ${new Decimal(args.order.totalAmount).toString()}, so no payment instructions were shown — check the transaction in the TokoPay dashboard`,
    );
  }
  const committed = await commitGatewayResult(
    db,
    args.order.id,
    args.sentinel,
    { gateway: "tokopay", ...args.gateway },
    reading.charge,
  );
  return { committed, charge: reading.charge };
}

/** PENDING, not-yet-expired TokoPay orders the reconcile poller should check,
 * oldest first (closest to auto-cancelling). `limit`, when given, caps how
 * many rows come back — the reconcile poller passes MAX_ORDERS_PER_CYCLE so
 * one cycle's gateway round-trips stay bounded regardless of backlog size
 * (Task 11); omitted, every other caller keeps today's unbounded behavior. */
export function listPendingTokopayOrders(db: Db, now: Date, limit?: number) {
  return db.order.findMany({
    where: {
      OR: [{ walletCreditState: null }, { walletCreditState: { not: "NEEDS_REVIEW" } }],
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.TOKOPAY,
      expiresAt: { gt: now },
    },
    include: { user: true },
    orderBy: { createdAt: "asc" },
    ...(limit != null ? { take: limit } : {}),
  });
}

export type TokopayDeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
  | { status: "processing"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>> }
  | { status: "already_processed" }
  | { status: "stale" };

/** Reclaim a crash-stuck "matched" TokoPay claim for `orderId` (Task B2). */
async function recoverStaleTokopayClaim(db: PrismaClient, trxId: string, orderId: number, amount: Decimal): Promise<boolean> {
  const prior = await db.processedTokopayTx.findUnique({ where: { trxId } });
  if (!prior) return false;
  return reclaimStaleMatchedClaim(db, {
    rail: "TokoPay",
    txId: trxId,
    prior,
    forOrderId: orderId,
    cas: (guard) =>
      db.processedTokopayTx.updateMany({ where: { trxId, ...guard }, data: { amount, outcome: "matched", updatedAt: new Date() } }),
  });
}

/**
 * Idempotently confirm + deliver a TokoPay-paid order. Claims the callback's
 * trx id (UNIQUE gate), then runs the normal approve/deliver path in one
 * transaction. The buyer is notified through the OUTBOX (ORDER_DELIVERED_DM —
 * order code + shop link, never credentials); the web never sends Telegram.
 */
export async function deliverPaidTokopayOrder(
  db: PrismaClient,
  args: { orderId: number; trxId: string; amount: Decimal.Value; shopUrl?: string | null; manual?: { adminId: number } },
): Promise<TokopayDeliverResult> {
  // 1. Claim the trx id. A duplicate normally means another callback already
  //    handled it — UNLESS the prior claim's outcome is one of
  //    QRIS_RECLAIMABLE_OUTCOMES ("delivery_failed" or "unmatched"): neither
  //    of those ever actually delivered anything, so the trx id must stay
  //    re-claimable, or the buyer's payment is silently lost forever behind a
  //    stuck idempotency row (delivery_failed: H-3, backend audit
  //    2026-07-31; unmatched: Task 15 — TokoPay hands back a trxId scoped to
  //    THIS order's orderCode, so "unmatched" here can only mean this trxId's
  //    own order was temporarily un-matchable, never a guess at some other
  //    order — see QRIS_RECLAIMABLE_OUTCOMES's doc-comment in
  //    binance_internal.ts for why that is NOT true on the amount-matched
  //    crypto rails, which use a narrower set). Re-claiming is a single
  //    atomic UPDATE gated on that outcome set — the database applies the
  //    two updates one after the other, so if two retries race, exactly one
  //    `updateMany` sees count=1 and
  //    proceeds; the other sees count=0 and correctly reports
  //    already_processed.
  // Manual mode (an admin matching an "unmatched" ledger row to an order,
  // manualMatchLedgerTx in crud/manualMatch.ts) claims differently from a
  // callback: ONLY from "unmatched" — never "delivery_failed", which belongs
  // to a delivery attempt for some order already — and as a compare-and-swap
  // on the exact orderId it read, so `manualPrior` is exactly what the claim
  // overwrote. A stale order or a delivery that throws puts the row back to
  // that state below, so the payment stays in the manual-match queue instead
  // of being stamped "stale"/"delivery_failed" against an order the admin
  // merely tried. No row is created here: an admin can only match a row that
  // already exists.
  let manualPrior: { orderId: number | null; amount: Decimal | null } | null = null;
  if (args.manual) {
    const prior = await db.processedTokopayTx.findUnique({ where: { trxId: args.trxId } });
    let claimedCount = 0;
    if (prior && prior.outcome === "unmatched") {
      claimedCount = (
        await db.processedTokopayTx.updateMany({
          where: { trxId: args.trxId, outcome: "unmatched", orderId: prior.orderId },
          data: { orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
        })
      ).count;
    } else if (prior && prior.outcome === "matched" && prior.orderId === args.orderId) {
      // An earlier manual match of this same row to this same order crashed
      // between its claim and its delivery, leaving the row "matched" with
      // nothing delivered. An admin repeating that exact match recovers it
      // through the same guarded stale-claim reclaim the callbacks use
      // (crud/_staleClaim.ts: same order only, claim older than
      // STALE_MATCHED_CLAIM_MS, order still payable) — never for a different
      // order, and never a claim young enough to still be in flight.
      claimedCount = (await recoverStaleTokopayClaim(db, args.trxId, args.orderId, new Decimal(args.amount))) ? 1 : 0;
    }
    if (!prior || claimedCount === 0) {
      logger.info(
        {
          event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
          orderId: args.orderId,
          provider: PaymentMethod.TOKOPAY,
          providerPaymentId: args.trxId,
          status: "already_processed",
        },
        `Did not manually match TokoPay transaction ${args.trxId} to order ${args.orderId} because its ledger row is no longer unmatched — another admin or the gateway's own callback claimed it first, so nothing was delivered or credited`,
      );
      return { status: "already_processed" };
    }
    // A recovered stranded claim was itself made from an "unmatched" row, so
    // undoing it means "unmatched" with no order.
    manualPrior = { orderId: prior.outcome === "unmatched" ? prior.orderId : null, amount: prior.amount };
  } else {
    try {
      await db.processedTokopayTx.create({
        data: { trxId: args.trxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const reclaimed = await db.processedTokopayTx.updateMany({
        where: { trxId: args.trxId, outcome: { in: [...QRIS_RECLAIMABLE_OUTCOMES] } },
        data: { orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
      });
      // Task B2: a "matched" row whose delivery crashed before finishing is
      // recoverable too — see crud/_staleClaim.ts for exactly when.
      const recovered =
        reclaimed.count === 1 ||
        (await recoverStaleTokopayClaim(db, args.trxId, args.orderId, new Decimal(args.amount)));
      if (!recovered) {
        // The idempotency gate working, not a fault: this payment was already
        // settled by whichever of the webhook or the reconcile poller got here
        // first. Logged at info for exactly that reason — see PaymentLogEvent
        // (@app/core/payments/logEvents) on why an expected race is never a warning.
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.TOKOPAY,
            providerPaymentId: args.trxId,
            status: "already_processed",
          },
          `Skipped settling TokoPay transaction ${args.trxId} for order ${args.orderId} because it had already been processed — the ledger claim was lost to whichever path confirmed this payment first, so nothing was delivered or credited twice`,
        );
        return { status: "already_processed" };
      }
    }
  }

  let verifiedWalletPayment = false;
  // Set when the error came from inside the delivery transaction's callback,
  // which means Prisma rolled it back — see crud/_manualQrisClaim.ts.
  let settleCallbackThrew = false;
  // 2. Deliver. On failure, flag the ledger row (e.g. paid but out of stock)
  //    so we never retry silently — the caller alerts via logs/admin.
  try {
    return await db.$transaction(async (tx: Tx) => {
      try {
        const order = await getOrder(tx, args.orderId);
        // A cancelled WALLET_TOPUP is still payable (isLateSettleableWalletTopup):
        // the buyer paid after the window closed, and a top-up reserves nothing
        // that cancelling gave away. A cancelled PRODUCT order is NOT — its
        // stock went back to the pool — so it keeps falling through to "stale".
        if (
          !order ||
          (order.status !== OrderStatus.PENDING_PAYMENT && !isLateSettleableWalletTopup(order)) ||
          order.paymentMethod !== PaymentMethod.TOKOPAY
        ) {
          // Correct the audit row: the trx matched an order that's no longer payable.
          // Use `tx` (not the outer `db`) — we're still inside db.$transaction, and a
          // second connection writing the same row here would wait on the row lock
          // the surrounding transaction already holds until it times out.
          if (manualPrior) {
            // Manual mode: the order stopped being payable after the admin's
            // checks ran. Put the row back exactly as the claim found it.
            await tx.processedTokopayTx.update({
              where: { trxId: args.trxId },
              data: { outcome: "unmatched", orderId: manualPrior.orderId, amount: manualPrior.amount },
            });
          } else {
            await tx.processedTokopayTx
              .update({ where: { trxId: args.trxId }, data: { outcome: "stale" } })
              .catch(() => undefined);
          }
          logger.info(
            {
              event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
              orderId: args.orderId,
              provider: PaymentMethod.TOKOPAY,
              providerPaymentId: args.trxId,
              status: "stale",
            },
            manualPrior
              ? `Did not settle TokoPay transaction ${args.trxId} on an admin's manual match because order ${args.orderId} is no longer payable — it was cancelled, already settled, or is not a TokoPay order, so the ledger row was returned to unmatched for the admin to decide again`
              : `Did not settle TokoPay transaction ${args.trxId} because order ${args.orderId} is no longer payable — it was cancelled, already settled, or is not a TokoPay order, so the ledger row is marked stale and a human decides what the payment was for`,
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
        // What this buyer was asked to pay: TokoPay's own figure, stored on the
        // order when its transaction was created (`expectedTokopayCharge`). The
        // buyer-side surcharge is the difference to the order total.
        const expectedCharge = expectedTokopayCharge(order);
        const gatewayFee = expectedCharge.minus(order.totalAmount);
        if (order.kind === OrderKind.WALLET_TOPUP) {
          verifiedWalletPayment = order.paymentMethod === PaymentMethod.TOKOPAY;
          // Buyer DM (WALLET_TOPUP_CREDITED_DM) is enqueued inside
          // settleWalletTopup itself — the ONE call site for that event across
          // all six top-up rails, behind its own atomic claim. This webhook
          // (running in the web process, which must never send Telegram
          // itself) must not enqueue it again here, or the buyer would be
          // notified twice.
          const { order: settled, credited } = await settleWalletTopup(tx, args.orderId, { amount: args.amount });
          // Manual mode: a zero credit means the top-up's own payment settled it
          // between this transaction's read and settleWalletTopup's claim. Never
          // report that as this payment's match — fail, so the claim is undone
          // and the row goes back to the manual-match queue.
          if (args.manual && !credited.greaterThan(0)) throw new ValidationError("error.order_not_pending");
          // Overpayment: same flag + admin alert the product branch below raises,
          // without changing what was credited (see flagWalletTopupOverpayment).
          // TokoPay bills its surcharge on top of the total, so the comparison
          // is against what TokoPay said this buyer must pay (`expectedCharge`
          // above), exactly like the product branch. No tolerance is added.
          await flagWalletTopupOverpayment(tx, {
            order: settled,
            credited,
            paid: args.amount,
            expected: expectedCharge,
            rail: "TokoPay",
            markLedgerOverpaid: () =>
              tx.processedTokopayTx.update({ where: { trxId: args.trxId }, data: { outcome: "overpaid" } }),
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
            // Financial Ledger M3: the confirmation also captures what this rail
            // knows about the money that arrived — TokoPay's own `trxId` (the id
            // that will appear on its settlement report, which is what
            // `Payment.providerTransactionId` is reconciled on), plus the only
            // fee-shaped figures this shop has for any of its six rails.
            //
            // `fee` is the surcharge the buyer pays ON TOP of the order total —
            // the order's stored gateway charge minus its total — so
            // `netAmount` is the total itself, not `amount - fee`. The
            // surcharge never becomes this shop's money; the total IS what the
            // shop nets.
            //
            // Captured as DATA only — no `FEE` ledger posting is made from it.
            // It is the BUYER-side surcharge, not a cut TokoPay reported having
            // deducted from the shop, and the `ORDER_PAYMENT` posting that
            // settling this order already made (crud/ledgerPostings.ts) books
            // `order.totalAmount` — the net receipt — so booking the surcharge
            // separately would double-count. `payment_fee.idr` and
            // `FinancialTransactionType.FEE` stay unused until a rail reports a
            // real merchant fee. Pinned by a test in crud/tokopay.test.ts.
            await confirmPaymentAttempt(tx, {
              paymentId: pendingPayment.id,
              providerTransactionId: args.trxId,
              fee: gatewayFee,
              netAmount: order.totalAmount,
            }).catch((err) =>
              logger.warn({ err }, `Could not confirm the Payment ledger row for order ${settled.orderCode} — that row is left stuck PENDING and needs manual reconciliation. Whether the settlement itself survived depends on which failure this was, and this line cannot tell them apart: the benign race this catch exists for (another poller or webhook confirmed the same row first) leaves the order settled, but a real database error — a unique violation on providerTransactionId, say — has already aborted this interactive transaction in Postgres, so the settlement rolls back with it. Check whether the order actually reached its settled status before treating this as harmless`),
            );
          }
          logger.info(
          {
            event: PaymentLogEvent.PAYMENT_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.TOKOPAY,
            providerPaymentId: args.trxId,
            status: "delivered",
          },
          `Settled TokoPay wallet top-up order ${settled.orderCode} for transaction ${args.trxId} — the buyer's balance was credited and their notification queued`,
          );
          return { status: "delivered" as const, order: settled, credentials: [] };
        }
        await tx.order.update({
          where: { id: args.orderId },
          data: { binanceTxid: null, paidAt: new Date() },
        });
        await transitionOrderStatus(tx, {
          orderId: args.orderId,
          from: OrderStatus.PENDING_PAYMENT,
          to: OrderStatus.PENDING_VERIFICATION,
          meta: args.manual ? `manual_match trxId=${args.trxId} by admin_id=${args.manual.adminId}` : `trxId=${args.trxId}`,
        });
        const result = await settlePaidOrder(tx, args.orderId, { adminId: args.manual?.adminId ?? 0 });
        if (pendingPayment) {
          // See the WALLET_TOPUP branch above for what this .catch actually
          // protects against, and for why the fee figures are captured as data
          // with no `FEE` ledger posting behind them.
          await confirmPaymentAttempt(tx, {
            paymentId: pendingPayment.id,
            providerTransactionId: args.trxId,
            fee: gatewayFee,
            netAmount: order.totalAmount,
          }).catch((err) =>
            logger.warn({ err }, `Could not confirm the Payment ledger row for order ${result.order.orderCode} — that row is left stuck PENDING and needs manual reconciliation. Whether the settlement itself survived depends on which failure this was, and this line cannot tell them apart: the benign race this catch exists for (another poller or webhook confirmed the same row first) leaves the order settled, but a real database error — a unique violation on providerTransactionId, say — has already aborted this interactive transaction in Postgres, so the settlement rolls back with it. Check whether the order actually reached its settled status before treating this as harmless`),
          );
        }
        // Buyer DM via the outbox — only if the buyer has a Telegram account.
        // Web-only buyers (telegramId=null) have no chat to DM; they see their
        // order on the storefront instead. Link only — the outbox payload is
        // visible in the admin /outbox panel, never put credentials in it.
        // Skipped for a "processing" result — settlePaidOrder already enqueued
        // the buyer's ORDER_PROCESSING_DM for manual-fulfilment SKUs.
        if (result.kind === "delivered" && result.order.user.telegramId != null) {
          await enqueueNotification(tx, NotificationEvent.ORDER_DELIVERED_DM, result.order.id, {
            chat_id: Number(result.order.user.telegramId),
            order_code: result.order.orderCode,
            order_url: args.shopUrl ? `${args.shopUrl.replace(/\/+$/, "")}/account/orders/${result.order.orderCode}` : null,
            buyer_language: langCode(result.order.user.language),
          });
        }
        // Overpayment: the buyer paid more than the order total. Still deliver
        // (handled above) but flag the ledger row and alert admins so the
        // excess can be refunded/credited manually — never auto-refunded. This
        // stays unconditional — a buyer can overpay regardless of delivery type.
        const paidAmount = new Decimal(args.amount);
        const excess = paidAmount.minus(expectedCharge);
        if (excess.greaterThan(0)) {
          await tx.processedTokopayTx.update({ where: { trxId: args.trxId }, data: { outcome: "overpaid" } });
          await enqueueAdminOverpaid(tx, {
            orderId: result.order.id,
            orderCode: result.order.orderCode,
            paid: paidAmount,
            expected: expectedCharge,
            excess,
            currency: order.currency,
          });
          logger.warn(
            `TokoPay order ${result.order.orderCode} was overpaid — got ${paidAmount.toString()}, expected ${expectedCharge.toString()} (excess ${excess.toString()} ${order.currency}) — flagged for manual refund/credit, an admin alert was enqueued`,
          );
        }
        if (result.kind === "delivered") {
          logger.info(
          {
            event: PaymentLogEvent.PAYMENT_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.TOKOPAY,
            providerPaymentId: args.trxId,
            status: "delivered",
          },
          `Auto-delivered TokoPay order ${result.order.orderCode} for transaction ${args.trxId}`,
          );
          return { status: "delivered" as const, order: result.order, credentials: result.credentials };
        }
        logger.info(
        {
          event: PaymentLogEvent.PAYMENT_CONFIRMED,
          orderId: args.orderId,
          provider: PaymentMethod.TOKOPAY,
          providerPaymentId: args.trxId,
          status: "processing",
        },
        `TokoPay order ${result.order.orderCode} paid — queued for manual fulfilment (transaction ${args.trxId})`,
        );
        return { status: "processing" as const, order: result.order };
      } catch (inner) {
        // Thrown inside the callback: Prisma rolls this transaction back.
        settleCallbackThrew = true;
        throw inner;
      }
    }, { timeout: 15000 });
  } catch (e) {
    if (manualPrior) {
      // Manual mode: the delivery transaction rolled back, so nothing was
      // delivered or credited. Undo the claim too (all-or-nothing, like
      // manualMatchTx) so the admin sees the error and the row stays
      // matchable, rather than leaving a "delivery_failed" row that would
      // count as proof this order was paid. No wallet preservation either:
      // the gateway never confirmed this payment as this order's.
      // An error from inside the transaction callback is a certain rollback,
      // so the claim is always undone — whatever the order's status now (it
      // has often moved on precisely because another path settled or
      // cancelled it). Only an error that may have come after COMMIT is
      // checked first, under a lock, for proof this match settled the order:
      // reopening a row whose settlement committed would let the same money
      // settle a second order. See crud/_manualQrisClaim.ts.
      const prior = manualPrior;
      await undoFailedManualQrisClaim(db, {
        rail: "TokoPay",
        trxId: args.trxId,
        orderId: args.orderId,
        certainRollback: settleCallbackThrew,
        revert: (tx) =>
          tx.processedTokopayTx.updateMany({
            where: { trxId: args.trxId, orderId: args.orderId, outcome: "matched" },
            data: { outcome: "unmatched", orderId: prior.orderId, amount: prior.amount },
          }),
      });
      throw e;
    }
    if (verifiedWalletPayment) {
      await preservePaidWalletCreditFailure(db, { orderId: args.orderId, method: PaymentMethod.TOKOPAY, providerTransactionId: args.trxId, amount: args.amount })
        .catch((err) => logger.error({ err, orderId: args.orderId }, "Could not persist the confirmed wallet payment after credit failure"));
    }
    await db.processedTokopayTx
      .update({ where: { trxId: args.trxId }, data: { outcome: "delivery_failed" } })
      .catch(() => undefined);
    throw e;
  }
}

/** A callback that matched no payable order — record once for manual review.
 *  `suggestedOrderId` is the order the callback named when it had one but
 *  could not settle it (short-paid, unverified amount, wrong method/currency).
 *  It is a display-only hint for the Payments ledger and is deliberately NOT
 *  written to `orderId`: an `unmatched` row linked by `orderId` counts as
 *  proof of a full payment (`orderHasIncomingLedgerPayment`,
 *  `consumeIncomingLedgerPayment`), and this row may be short or zero. */
export async function recordUnmatchedTokopayTx(
  db: Db,
  args: { trxId: string; amount: Decimal.Value; suggestedOrderId?: number | null },
): Promise<boolean> {
  try {
    await db.processedTokopayTx.create({
      data: {
        trxId: args.trxId,
        amount: new Decimal(args.amount),
        outcome: "unmatched",
        suggestedOrderId: args.suggestedOrderId ?? null,
      },
    });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}
