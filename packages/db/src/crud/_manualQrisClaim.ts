/**
 * Undoing a failed admin manual match on the TokoPay / PayDisini ledgers.
 *
 * In manual mode (`deliverPaidTokopayOrder` / `deliverPaidPaydisiniOrder`
 * with `manual`, driven by `manualMatchLedgerTx` in ./manualMatch) the
 * "unmatched" ledger row is claimed for the order BEFORE — and outside — the
 * delivery transaction. When that transaction fails, the claim must be put
 * back so the payment returns to the manual-match queue, but ONLY when the
 * settlement certainly did not commit: reopening a row whose settlement did
 * commit would let the same money settle a second order.
 *
 *  - An error thrown inside the transaction callback (a guarded transition
 *    losing its race, out of stock, a top-up credited by another path, ...)
 *    means Prisma rolled the transaction back: nothing was delivered or
 *    credited, so the claim is always undone. The order's current status says
 *    nothing here — it may well have moved on because ANOTHER path settled or
 *    cancelled it, which is exactly why the transition failed.
 *  - An error raised outside the callback (connection lost, transaction
 *    closed, a failed COMMIT, an unknown driver error) is ambiguous: the
 *    COMMIT may or may not have landed. That case is decided in one short
 *    transaction that first locks the order row (`FOR UPDATE`), so a COMMIT
 *    still in flight on the server is waited for, then looks for proof that
 *    THIS match settled the order:
 *      - still PENDING_PAYMENT (or a CANCELLED top-up) → it did not;
 *      - a product order → the status-history row the settlement writes, whose
 *        meta names this transaction id (`manual_match trxId=<id> by ...`);
 *      - a settled top-up → no such proof exists (`settleWalletTopup` writes no
 *        history row), so the row is left matched and an admin is told.
 */
import { OrderKind, OrderStatus } from "@app/core/enums";
import { logger } from "@app/core/logger";
import type { PrismaClient, Tx } from "../client";

type SettledByThisMatch = "settled" | "not_settled" | "unknown";

async function settledByThisMatch(tx: Tx, orderId: number, trxId: string): Promise<SettledByThisMatch> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, kind: true } });
  if (!order) return "unknown";
  if (order.status === OrderStatus.PENDING_PAYMENT) return "not_settled";
  if (order.kind === OrderKind.WALLET_TOPUP) return order.status === OrderStatus.CANCELLED ? "not_settled" : "unknown";
  const ours = await tx.orderStatusHistory.findFirst({
    where: { orderId, meta: { startsWith: `manual_match trxId=${trxId} ` } },
    select: { id: true },
  });
  return ours ? "settled" : "not_settled";
}

/**
 * Put a failed manual claim back (see the module comment for exactly when).
 * `revert` runs the rail's own guarded `updateMany` on its ledger table.
 * Never throws: the caller rethrows the original error either way.
 */
export async function undoFailedManualQrisClaim(
  db: PrismaClient,
  args: {
    rail: "TokoPay" | "PayDisini";
    trxId: string;
    orderId: number;
    /** True when the error came from inside the transaction callback. */
    certainRollback: boolean;
    revert: (tx: Tx) => Promise<{ count: number }>;
  },
): Promise<void> {
  const { rail, trxId, orderId } = args;
  try {
    await db.$transaction(
      async (tx: Tx) => {
        if (!args.certainRollback) {
          const verdict = await settledByThisMatch(tx, orderId, trxId);
          if (verdict === "settled") {
            logger.warn(
              { orderId, providerPaymentId: trxId },
              `A manual match of ${rail} transaction ${trxId} to order ${orderId} reported an error after its settlement had already committed, so the ledger row stays matched to that order; only the acknowledgement was lost and nothing needs undoing`,
            );
            return;
          }
          if (verdict === "unknown") {
            logger.error(
              { orderId, providerPaymentId: trxId },
              `A manual match of ${rail} transaction ${trxId} to order ${orderId} failed in a way that leaves it unclear whether the settlement committed, and the order has moved on, so the ledger row was left matched to it rather than reopened — an admin must check whether this payment actually settled the order`,
            );
            return;
          }
        }
        const reverted = await args.revert(tx);
        if (reverted.count === 0) {
          logger.error(
            { orderId, providerPaymentId: trxId },
            `A failed manual match of ${rail} transaction ${trxId} to order ${orderId} could not be undone because the ledger row had already changed — an admin must check what the row now points at`,
          );
        }
      },
      { timeout: 15000 },
    );
  } catch (err) {
    logger.error(
      { err, orderId, providerPaymentId: trxId },
      `Could not return ${rail} ledger row ${trxId} to unmatched after a failed manual match to order ${orderId} — the row is left claimed by that order although nothing may have been delivered, so an admin must check it`,
    );
  }
}
