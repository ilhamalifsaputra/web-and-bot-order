/**
 * Refund domain — record-keeping + workflow state machine layered on top of
 * this repo's existing wallet-credit refund path (Trustance Master
 * Architecture Task 8b, following Task 8a's schema-only `Refund`/
 * `RefundItem` models).
 *
 * SCOPE: this file builds create/list/transition/per-item-invariant plumbing
 * for the Refund domain, and nothing here independently moves money.
 * Transitioning a Refund to COMPLETED via `transitionRefundStatus` is a pure
 * record-state change — it does NOT call `adjustWallet` or any other payout
 * mechanism. The one payout path this task wires up is the existing,
 * already-tested `refundUnderpaidOrder` (packages/db/src/crud/
 * binance_internal.ts), which already credits the buyer's wallet; that
 * function now ALSO writes a `Refund` row (pre-COMPLETED, no
 * `transitionRefundStatus` call — see its own comment for why) to make that
 * concrete payout show up in Refund history. A general-purpose "approve this
 * arbitrary refund and pay it out" flow is future work, once an admin UI
 * exists to decide amount/method for a refund that didn't arise from one of
 * the specific existing payout paths — building that now would be a
 * significant, un-requested expansion of scope.
 */
import { RefundStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { Decimal } from "@app/core/money";
import type { Prisma, Refund, RefundItem } from "@prisma/client";
import type { Db } from "./_types";
import { logAdminAction } from "./audit";

/**
 * Legal Refund.status transitions — mirrors `LEGAL_TRANSITIONS` in
 * orderStatus.ts's shape (a lookup table `transitionRefundStatus` validates
 * against before attempting the atomic claim). PENDING -> PROCESSING ->
 * COMPLETED | FAILED is the normal review-then-resolve path; CANCELLED is
 * reachable from PENDING or PROCESSING only (an admin can call off a refund
 * request any time before it's actually resolved, but not after). COMPLETED,
 * FAILED, and CANCELLED are all terminal — no outgoing edges.
 */
export const REFUND_LEGAL_TRANSITIONS: Record<string, readonly string[]> = {
  [RefundStatus.PENDING]: [RefundStatus.PROCESSING, RefundStatus.CANCELLED],
  [RefundStatus.PROCESSING]: [RefundStatus.COMPLETED, RefundStatus.FAILED, RefundStatus.CANCELLED],
  [RefundStatus.COMPLETED]: [],
  [RefundStatus.FAILED]: [],
  [RefundStatus.CANCELLED]: [],
};

const TERMINAL_REFUND_STATUSES: readonly string[] = [
  RefundStatus.COMPLETED,
  RefundStatus.FAILED,
  RefundStatus.CANCELLED,
];

/**
 * Terminal Refund statuses that never moved money: a CANCELLED or FAILED
 * Refund's RefundItem rows must NOT count against an OrderItem's refund
 * budget (see `createRefundItem`'s doc comment). Deliberately a subset of
 * `TERMINAL_REFUND_STATUSES` — COMPLETED is also terminal but DID pay out,
 * so it must keep counting against the budget.
 */
const REFUND_STATUSES_THAT_DID_NOT_CONSUME_BUDGET: readonly string[] = [
  RefundStatus.CANCELLED,
  RefundStatus.FAILED,
];

/**
 * Create a new Refund request record. Validates that `currency` matches the
 * referenced Order's own currency (a refund must stay pinned to the currency
 * the original payment was made in — see Refund.currency's schema doc
 * comment) and snapshots it onto the row, same as every other order-adjacent
 * financial snapshot in this schema.
 *
 * This does NOT move money — it only records that a refund is requested/
 * decided, starting in PENDING (the schema default). See this file's module
 * comment for the money-movement scope boundary.
 */
export async function createRefund(
  db: Db,
  args: {
    orderId: number;
    amount: Decimal.Value;
    currency: string;
    reason?: string | null;
    externalReference?: string | null;
  },
): Promise<Refund> {
  const order = await db.order.findUnique({ where: { id: args.orderId }, select: { id: true, currency: true } });
  if (!order) throw new ValidationError("error.order_not_found");
  if (args.currency !== order.currency) {
    throw new ValidationError("error.refund_currency_mismatch", {
      refundCurrency: args.currency,
      orderCurrency: order.currency,
    });
  }

  return db.refund.create({
    data: {
      orderId: args.orderId,
      amount: new Decimal(args.amount),
      currency: args.currency,
      reason: args.reason ?? null,
      externalReference: args.externalReference ?? null,
    },
  });
}

export interface RefundFilter {
  orderId?: number;
  status?: string;
}

/** Refunds (newest first), each with its RefundItem children. */
export function listRefunds(
  db: Db,
  opts: RefundFilter & { limit?: number; offset?: number } = {},
) {
  const where: Prisma.RefundWhereInput = {};
  if (opts.orderId != null) where.orderId = opts.orderId;
  if (opts.status) where.status = opts.status;
  return db.refund.findMany({
    where,
    include: { items: true },
    orderBy: { createdAt: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 100,
  });
}

/**
 * Move a Refund from `from` to `to`: validates the shape against
 * `REFUND_LEGAL_TRANSITIONS`, atomically claims the row (`updateMany` with
 * the expected current status in the WHERE clause — same pattern as
 * `transitionOrderStatus`/orderStatus.ts) so a stale/duplicate caller fails
 * safely instead of overwriting a Refund that already moved on, stamps
 * `processedAt` the moment the row reaches a terminal status, and audits the
 * move via `logAdminAction` with a natural-language sentence
 * (docs/LOGGING.md).
 *
 * Does NOT trigger any wallet credit or other payout — see this file's
 * module comment for why that is out of scope for the general-purpose
 * Refund workflow this function belongs to.
 */
export async function transitionRefundStatus(
  db: Db,
  args: { refundId: number; from: string; to: string; adminId: number; meta?: string | null },
): Promise<Refund> {
  const { refundId, from, to, adminId, meta } = args;

  if (!REFUND_LEGAL_TRANSITIONS[from]?.includes(to)) {
    throw new ValidationError("error.illegal_refund_status_transition", { from, to });
  }

  const claim = await db.refund.updateMany({
    where: { id: refundId, status: from },
    data: {
      status: to,
      ...(TERMINAL_REFUND_STATUSES.includes(to) ? { processedAt: new Date() } : {}),
    },
  });
  if (claim.count !== 1) {
    // Either the refund doesn't exist, or its actual current status no
    // longer matches `from` (race/staleness) — same error either way, since
    // both mean "this transition cannot be applied as requested" (mirrors
    // transitionOrderStatus's own reasoning).
    throw new ValidationError("error.illegal_refund_status_transition", { from, to });
  }

  const refund = await db.refund.findUniqueOrThrow({ where: { id: refundId } });
  const order = await db.order.findUnique({ where: { id: refund.orderId }, select: { orderCode: true } });

  await logAdminAction(db, {
    adminId,
    action: "refund_status_change",
    targetType: "refund",
    targetId: refundId,
    details: `Refund #${refundId} for order ${order?.orderCode ?? refund.orderId} moved from ${from} to ${to}${meta ? ` (${meta})` : ""}.`,
  });

  return refund;
}

/**
 * Create a per-line RefundItem, enforcing the cross-row sum invariant that
 * RefundItem's own schema doc comment defers to the application layer: the
 * sum of every RefundItem.amount already recorded against this OrderItem,
 * plus this new amount, must never exceed the OrderItem's own subtotal
 * (`unitPrice * quantity`). Reads every sibling RefundItem row for this
 * `orderItemId` (across ALL Refunds, not just the current one) to compute
 * that sum — a partial refund history can span more than one Refund request
 * over time (e.g. buy 3, one turns out dead now and another later).
 *
 * Only RefundItem rows whose parent Refund is PENDING, PROCESSING, or
 * COMPLETED count against the budget — those are the only statuses where the
 * refund plausibly has (or still could) move money. A CANCELLED or FAILED
 * Refund never paid out anything, so its RefundItem rows must NOT keep
 * counting against the OrderItem's subtotal — otherwise cancelling/failing a
 * refund would permanently burn that item's refund budget with no recovery
 * path short of a raw DB edit. This is why the exclusion set is specifically
 * `{CANCELLED, FAILED}` and not the full `TERMINAL_REFUND_STATUSES` (which
 * also includes COMPLETED — a COMPLETED refund DID move money and must keep
 * counting).
 *
 * `currency` is NOT accepted as a parameter — it is always copied from the
 * parent Refund's own currency (which is itself already validated against
 * the Order's currency by `createRefund`), matching RefundItem's own schema
 * doc comment ("same snapshot-at-creation-time reasoning as Refund.currency
 * ... copied ... not derived by joining back on read"). This also removes
 * any way for a caller to pass a RefundItem currency that disagrees with its
 * own parent Refund.
 *
 * Also checks the OrderItem actually belongs to the Refund's own Order —
 * without that, this invariant check would still run, but the row would
 * (silently, wrongly) attribute another order's item to this refund.
 *
 * NOTE on concurrency: the sum-then-insert here is not wrapped in its own
 * atomic claim (unlike transitionRefundStatus's updateMany-with-guard
 * pattern) because there is no single row to gate the claim on — the
 * invariant is a cross-row aggregate over sibling RefundItem rows. Callers
 * that need this to be airtight under concurrent writers should call this
 * inside one `$transaction`: this database is single-writer SQLite, so a
 * conflicting concurrent write is serialized (or, in the rare interactive-
 * transaction race, thrown as a busy/snapshot error) rather than silently
 * violating the invariant — it fails closed, never open.
 */
export async function createRefundItem(
  db: Db,
  args: { refundId: number; orderItemId: number; amount: Decimal.Value; reason?: string | null },
): Promise<RefundItem> {
  const refund = await db.refund.findUnique({ where: { id: args.refundId } });
  if (!refund) throw new ValidationError("error.refund_not_found");

  const orderItem = await db.orderItem.findUnique({ where: { id: args.orderItemId } });
  if (!orderItem) throw new ValidationError("error.order_item_not_found");
  if (orderItem.orderId !== refund.orderId) {
    throw new ValidationError("error.refund_item_order_mismatch");
  }

  const amount = new Decimal(args.amount);
  const subtotal = new Decimal(orderItem.unitPrice).times(orderItem.quantity);

  const existing = await db.refundItem.aggregate({
    where: {
      orderItemId: args.orderItemId,
      refund: { status: { notIn: [...REFUND_STATUSES_THAT_DID_NOT_CONSUME_BUDGET] } },
    },
    _sum: { amount: true },
  });
  const alreadyRefunded = new Decimal(existing._sum?.amount ?? 0);
  const projected = alreadyRefunded.plus(amount);

  if (projected.greaterThan(subtotal)) {
    throw new ValidationError("error.refund_exceeds_item_subtotal", {
      subtotal: subtotal.toString(),
      currency: refund.currency,
      alreadyRefunded: alreadyRefunded.toString(),
      attempted: amount.toString(),
    });
  }

  return db.refundItem.create({
    data: {
      refundId: args.refundId,
      orderItemId: args.orderItemId,
      amount,
      currency: refund.currency,
      reason: args.reason ?? null,
    },
  });
}
