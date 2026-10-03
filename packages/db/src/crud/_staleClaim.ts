/**
 * Recovery for a crash-stuck "matched" idempotency claim (backend audit,
 * Task B2), shared by all six auto-confirm rails (TokoPay, PayDisini,
 * NOWPayments, Binance internal, Bybit internal, Bybit BSC).
 *
 * Every rail claims its provider transaction id by committing a
 * `processed_*_tx` row with outcome "matched" BEFORE — and outside — the
 * delivery transaction, and tags it "delivery_failed" in a catch if delivery
 * throws. A crash in between (process killed, connection dropped before the
 * catch ran) left the row "matched" forever, and "matched" is terminal: every
 * later webhook retry or reconcile pass answered already_processed, so a paid
 * order was never delivered.
 *
 * "matched" is also the outcome a SUCCESSFUL delivery leaves behind, so age
 * alone cannot tell the two apart. The order can: delivery moves the order out
 * of PENDING_PAYMENT inside the same transaction that would have committed it,
 * so a claim whose order is still awaiting payment never delivered. A claim is
 * therefore reclaimable only when ALL of these hold:
 *   - outcome is "matched";
 *   - it is being reclaimed for the same order it was claimed for (a stuck
 *     claim is that order's payment; never hand it to a different one);
 *   - `updatedAt` is older than STALE_MATCHED_CLAIM_MS, so a delivery still in
 *     flight is never raced (a delivery transaction finishes in seconds);
 *   - its order is still payable (PENDING_PAYMENT, or a cancelled wallet
 *     top-up, which the rails settle late on purpose).
 * The reclaim itself is a compare-and-swap on `updatedAt` (which Prisma bumps
 * on every write), so two racing retries cannot both win. Delivery stays
 * idempotent behind that regardless: the order status transition it runs is
 * itself a guarded single-row update.
 */
import { OrderStatus } from "@app/core/enums";
import { logger } from "@app/core/logger";
import type { Db } from "./_types";
import { isLateSettleableWalletTopup } from "./wallet_topup";

/** A "matched" claim untouched for longer than this is no longer in flight. */
export const STALE_MATCHED_CLAIM_MS = 10 * 60_000;

/** The compare-and-swap guard a rail adds to its own `updateMany` where-clause. */
export type StaleClaimGuard = { outcome: "matched"; orderId: number; updatedAt: Date };

/**
 * Reclaim `prior` for `forOrderId` if it is a crash-stuck "matched" claim (see
 * the module comment for the exact conditions). `cas` runs the rail's own
 * guarded `updateMany` on its own ledger table and must spread `guard` into
 * its where-clause. Returns true only when this call won the reclaim.
 */
export async function reclaimStaleMatchedClaim(
  db: Db,
  args: {
    rail: string;
    txId: string;
    prior: { outcome: string; orderId: number | null; updatedAt: Date };
    forOrderId: number;
    cas: (guard: StaleClaimGuard) => Promise<{ count: number }>;
    now?: Date;
  },
): Promise<boolean> {
  const { prior, forOrderId } = args;
  const now = args.now ?? new Date();
  if (prior.outcome !== "matched" || prior.orderId == null || prior.orderId !== forOrderId) return false;
  if (prior.updatedAt.getTime() > now.getTime() - STALE_MATCHED_CLAIM_MS) return false;
  const order = await db.order.findUnique({ where: { id: prior.orderId }, select: { status: true, kind: true } });
  if (!order) return false;
  if (order.status !== OrderStatus.PENDING_PAYMENT && !isLateSettleableWalletTopup(order)) return false;

  const res = await args.cas({ outcome: "matched", orderId: prior.orderId, updatedAt: prior.updatedAt });
  if (res.count !== 1) return false;
  logger.warn(
    { rail: args.rail, orderId: forOrderId, providerPaymentId: args.txId },
    `Reclaimed a stuck ${args.rail} payment claim for order ${forOrderId}: it was marked matched more than ${Math.round(STALE_MATCHED_CLAIM_MS / 60_000)} minutes ago but the order is still awaiting payment, so the earlier delivery attempt must have crashed before finishing — retrying the delivery now`,
  );
  return true;
}
