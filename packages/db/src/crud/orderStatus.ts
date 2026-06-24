/**
 * Centralized Order.status transition helper + the append-only
 * OrderStatusHistory audit trail it writes alongside every move.
 *
 * This table only encodes whether a FROM->TO shape is structurally sensible
 * (e.g. nothing leaves a terminal state). Finer business rules — like "a
 * customer can't self-cancel once payment proof is under review" — stay in
 * the calling crud function, checked BEFORE it calls transitionOrderStatus,
 * so this helper stays a dumb, reusable state machine rather than a place
 * where every caller's policy accumulates.
 *
 * PAYMENT_DETECTED/CONFIRMING/CONFIRMED are written ONLY by the Bybit BSC
 * deposit poller (bybitBscDeposit.ts) and confirmation tracker
 * (bybitBscConfirmationTracker.ts) — every other payment method's deliver
 * functions never pass those as `to`.
 */
import { OrderStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import type { Db } from "./_types";

export const LEGAL_TRANSITIONS: Record<string, readonly string[]> = {
  [OrderStatus.PENDING_PAYMENT]: [
    OrderStatus.PAYMENT_DETECTED,
    OrderStatus.PENDING_VERIFICATION,
    OrderStatus.PAID,
    OrderStatus.UNDERPAID,
    OrderStatus.CANCELLED,
    OrderStatus.REJECTED,
    OrderStatus.FAILED,
  ],
  [OrderStatus.PAYMENT_DETECTED]: [
    OrderStatus.CONFIRMING,
    OrderStatus.PENDING_VERIFICATION,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ],
  [OrderStatus.CONFIRMING]: [
    OrderStatus.CONFIRMED,
    OrderStatus.PENDING_VERIFICATION,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ],
  [OrderStatus.CONFIRMED]: [
    OrderStatus.PENDING_VERIFICATION,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ],
  [OrderStatus.PENDING_VERIFICATION]: [
    OrderStatus.DELIVERED,
    OrderStatus.REJECTED,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ],
  // Legacy/transitional value — kept for any historical or edge writer.
  [OrderStatus.PAID]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED, OrderStatus.REFUNDED],
  [OrderStatus.UNDERPAID]: [
    OrderStatus.PENDING_VERIFICATION,
    OrderStatus.REFUNDED,
    OrderStatus.CANCELLED,
  ],
  // Terminal states — no outgoing transitions.
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.REJECTED]: [],
  [OrderStatus.REFUNDED]: [],
  [OrderStatus.FAILED]: [OrderStatus.CANCELLED, OrderStatus.REFUNDED],
};

/**
 * Move an order from `from` to `to`: validates the shape against
 * LEGAL_TRANSITIONS, atomically claims the row (`updateMany` with the
 * expected current status in the WHERE clause — same pattern as
 * approveOrder's own claim) so a stale/duplicate caller fails safely instead
 * of overwriting an order that already moved on, then writes exactly one
 * OrderStatusHistory row in the same call.
 *
 * NOT used by approveOrder's own PENDING_VERIFICATION->DELIVERED claim
 * (packages/db/src/crud/orders.ts) — that keeps its own `updateMany` (it
 * also sets paidAt/deliveredAt in the same write, and the stock-allocation
 * race it guards against predates this helper) and just adds its own
 * `orderStatusHistory.create()` right after a successful claim instead of
 * routing through this function.
 *
 * Does NOT set paidAt/deliveredAt/firstDetectedAt/confirmedAt — those stay
 * the calling function's responsibility, since only it knows their exact
 * semantics (e.g. whether a timestamp should only be stamped the first time
 * a status is reached).
 */
export async function transitionOrderStatus(
  db: Db,
  args: { orderId: number; from: string; to: string; meta?: string | null },
): Promise<void> {
  const { orderId, from, to, meta } = args;

  if (!LEGAL_TRANSITIONS[from]?.includes(to)) {
    throw new ValidationError("error.illegal_status_transition", { from, to });
  }

  const claim = await db.order.updateMany({
    where: { id: orderId, status: from },
    data: { status: to },
  });
  if (claim.count !== 1) {
    // Either the order doesn't exist, or its actual current status no
    // longer matches `from` (race/staleness) — same error either way, since
    // both mean "this transition cannot be applied as requested".
    throw new ValidationError("error.illegal_status_transition", { from, to });
  }

  await db.orderStatusHistory.create({
    data: { orderId, status: to, meta: meta ?? null },
  });
}

/**
 * Like `transitionOrderStatus`, but a lost race (the order's actual status no
 * longer matches `from`) is a benign no-op instead of a thrown error.
 * For callers where "another poller already moved this order past this
 * point" is an expected, harmless outcome — e.g. the Bybit BSC deposit
 * poller and confirmation tracker both touching the same order on
 * independent timers — not a bug to surface. Returns whether the
 * transition actually applied.
 */
export async function tryTransitionOrderStatus(
  db: Db,
  args: { orderId: number; from: string; to: string; meta?: string | null },
): Promise<boolean> {
  try {
    await transitionOrderStatus(db, args);
    return true;
  } catch (e) {
    if (e instanceof ValidationError && e.key === "error.illegal_status_transition") return false;
    throw e;
  }
}
