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
import { Decimal } from "@app/core/money";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { wakeFulfillmentMessage } from "./fulfillmentMessages";

/** Statuses after which the buyer's Telegram progress message shows its last text. */
const FINAL_ORDER_STATUSES: ReadonlySet<string> = new Set([
  OrderStatus.DELIVERED,
  OrderStatus.PARTIALLY_DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED,
  OrderStatus.REFUNDED,
  OrderStatus.FAILED,
]);

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
    // Manual-delivery SKUs branch here (settlePaidOrder): payment is confirmed
    // but the order awaits hand-fulfilment instead of an instant stock deliver.
    OrderStatus.PROCESSING,
    OrderStatus.REJECTED,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
    // Legal in shape only — nothing reaches it yet. `recomputeOrderStatus`
    // (orders.ts) is the sole writer, and it can only derive
    // PARTIALLY_DELIVERED from an order whose items ended with a split
    // outcome, which no current code path can produce. Listed so the future
    // plan that does produce one is not blocked by this table. See
    // OrderStatus.PARTIALLY_DELIVERED in @app/core/enums.
    OrderStatus.PARTIALLY_DELIVERED,
  ],
  // Manual fulfilment queue: an admin either delivers the typed content
  // (fulfillManualOrder → DELIVERED) or rejects/cancels the order.
  [OrderStatus.PROCESSING]: [
    OrderStatus.DELIVERED,
    OrderStatus.REJECTED,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
    // Same "shape-legal, unreachable today" note as above.
    OrderStatus.PARTIALLY_DELIVERED,
  ],
  // Legacy/transitional value — kept for any historical or edge writer.
  [OrderStatus.PAID]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED, OrderStatus.REFUNDED],
  [OrderStatus.UNDERPAID]: [
    OrderStatus.PENDING_VERIFICATION,
    OrderStatus.REFUNDED,
    OrderStatus.CANCELLED,
  ],
  // A delivered order is otherwise terminal, but it can still be refunded:
  // the buyer got the goods and the money is then given back (a dead account,
  // a goodwill refund). REFUNDED is the only outgoing edge — nothing un-delivers
  // an order. Added by the Financial Ledger milestone, which introduces
  // RefundExecution (the row that records an actual payout); before it, no code
  // path could pay a delivered order's buyer back, so the edge had no caller.
  [OrderStatus.DELIVERED]: [OrderStatus.REFUNDED],
  // Still terminal, unlike DELIVERED above: the order's lines have all reached
  // an outcome, some good and some not. What a buyer is owed for the failed
  // half is a partial-refund question — how much of a part-delivered order to
  // give back is a per-item calculation over RefundItem, not the whole-order
  // refund DELIVERED now allows — and that path has no caller yet, so the
  // outgoing edge stays unlisted until one exists.
  [OrderStatus.PARTIALLY_DELIVERED]: [],
  // Terminal states — no outgoing transitions.
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
  // A final status ends the buyer's progress message promptly; a manual
  // order's static WAITING line is not polled, so this is what moves it on.
  if (FINAL_ORDER_STATUSES.has(to)) await wakeFulfillmentMessage(db, orderId);
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

/**
 * Flag a QRIS/IDR order UNDERPAID (idempotent) — the shared counterpart of
 * the three crypto rails' own `markUnderpaid`/`markUnderpaidBybit`/
 * `markUnderpaidBybitBsc` (packages/db/src/crud/binance_internal.ts and its
 * Bybit siblings), used by tokopayReconcile.ts, paydisiniReconcile.ts, and
 * nowpaymentsReconcile.ts.
 *
 * Unlike the crypto rails, which scan a blockchain and need a separate
 * per-gateway ledger table (`processed_binance_tx` etc.) to dedupe deposits
 * with no natural "already handled" marker, each of these three pollers
 * re-checks the SAME `order.id` every cycle via its gateway's
 * `checkTransaction`-equivalent — so the order's own status IS the natural
 * idempotency guard, and this function needs no ledger table to dedupe with.
 * The `tryTransitionOrderStatus` call below IS that guard: once the order has
 * left PENDING_PAYMENT (this call already flagged it, or a webhook/another
 * poller settled it first), it returns false and this function is a no-op —
 * exactly how the crypto rails already treat their own idempotent-`false`
 * case.
 *
 * It nevertheless writes one `QrisUnderpaidTx` row per applied flag, for a
 * different reason than dedup: the amount that actually arrived has to be
 * readable later. Every path that pays an underpaid buyer back what they sent
 * (`refundUnderpaidOrder`, `creditUnderpaidTopupAnyway`) resolves it through
 * `findUnderpaidReceived` (crud/orders.ts), which reads structured ledger
 * rows — so while the received amount lived only in the `adminNote` free text
 * below, a QRIS-flagged order read back as "received 0" and the buyer got
 * nothing. The row is written only on the applied path, never on the
 * idempotent no-op, so a poller re-checking the same order cannot append a
 * second, conflicting record of what arrived.
 *
 * The transition, the `adminNote` write and the ledger row run as one
 * `$transaction` so a crash or thrown error between them can never leave a
 * torn state, mirroring `markUnderpaid`'s own transaction shape.
 */
export async function markOrderUnderpaid(
  db: PrismaClient,
  args: { orderId: number; gateway: string; receivedAmount: Decimal.Value; expectedAmount: Decimal.Value },
): Promise<boolean> {
  return db.$transaction(async (tx: Tx) => {
    const applied = await tryTransitionOrderStatus(tx, {
      orderId: args.orderId,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.UNDERPAID,
      meta: `gateway=${args.gateway}`,
    });
    if (!applied) return false;

    await tx.order.update({
      where: { id: args.orderId },
      data: {
        adminNote: `[underpaid] received ${new Decimal(args.receivedAmount).toString()} via ${args.gateway}, expected ${new Decimal(args.expectedAmount).toString()}`,
      },
    });
    await tx.qrisUnderpaidTx.create({
      data: {
        orderId: args.orderId,
        gateway: args.gateway,
        receivedAmount: new Decimal(args.receivedAmount),
        expectedAmount: new Decimal(args.expectedAmount),
      },
    });
    return true;
  }, { timeout: 15000 });
}
