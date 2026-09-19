/**
 * Refund domain — the workflow state machine (Trustance Master Architecture
 * Task 8b, following Task 8a's schema-only `Refund`/`RefundItem` models) plus
 * the general-purpose payout that settles it (`executeRefund`, Financial
 * Ledger M4).
 *
 * SCOPE, and the one distinction to hold on to when reading this file: the
 * workflow functions move RECORDS, `executeRefund` moves MONEY.
 * `createRefund`, `createRefundItem` and `transitionRefundStatus` never touch a
 * balance — reaching COMPLETED through `transitionRefundStatus` is a pure
 * record-state change, which is why it demands an explicit
 * `acknowledgeNoPayout` (see its own doc comment). `executeRefund` is the
 * function that actually pays a buyer back: it credits their wallet or records
 * a manual transfer out, writes the `RefundExecution` row that IS the payout,
 * posts the double-entry ledger event for it, and only then walks the Refund to
 * COMPLETED through that same state machine.
 *
 * It is not the only payout path in the codebase. `refundUnderpaidOrder`
 * (crud/binance_internal.ts) predates it and stays separate and untouched: it
 * resolves one specific case (a crypto deposit that fell short of an order's
 * price), credits the wallet itself, and writes its own already-COMPLETED
 * `Refund` row directly without the state machine — see its comment for why
 * fabricating PENDING/PROCESSING states for it would be wrong. `executeRefund`
 * is the general case: any refund an admin decided on, in either payout method,
 * against any order.
 */
import {
  OrderStatus,
  RefundExecutionMethod,
  RefundExecutionStatus,
  RefundStatus,
} from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { quantizeMoney } from "@app/core/formatters";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";
import type { Prisma, Refund, RefundExecution, RefundItem } from "@prisma/client";
import type { Db } from "./_types";
import { logAdminAction } from "./audit";
import { postRefundExecutionPosting } from "./ledgerPostings";
import { transitionOrderStatus } from "./orderStatus";
import { adjustWallet } from "./users";

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
 * Parse+validate a `Decimal.Value` refund amount: must be a well-formed,
 * finite, strictly-positive number. Converts a raw `[DecimalError] Invalid
 * argument` (malformed string) into the same clean `ValidationError` as the
 * range checks, so no raw Decimal exception ever escapes `createRefund`/
 * `createRefundItem` — a future route wrapping either would otherwise return
 * an unhandled 500 instead of a clean 422. Same idiom as
 * `parseMinAmount`/`_minAmount.ts` and the rate check in `pricing.ts`'s
 * `refreshUsdIdrRate`, except here an invalid amount is a hard reject
 * (`throw`), not a silent `null` — this is money actually being recorded on
 * a Refund/RefundItem row, not a free-text display-only setting.
 */
function parseRefundAmount(raw: Decimal.Value): Decimal {
  let amount: Decimal;
  try {
    amount = new Decimal(raw);
  } catch {
    throw new ValidationError("error.refund_amount_invalid");
  }
  if (!amount.isFinite() || !amount.greaterThan(0)) {
    throw new ValidationError("error.refund_amount_invalid");
  }
  return amount;
}

/**
 * Create a new Refund request record. Validates that `currency` matches the
 * referenced Order's own currency (a refund must stay pinned to the currency
 * the original payment was made in — see Refund.currency's schema doc
 * comment) and snapshots it onto the row, same as every other order-adjacent
 * financial snapshot in this schema. `amount` is validated finite/positive by
 * `parseRefundAmount` (a zero/negative/malformed amount would create a
 * nonsense financial record).
 *
 * This does NOT move money — it only records that a refund is requested/
 * decided, starting in PENDING (the schema default). See this file's module
 * comment for the money-movement scope boundary.
 *
 * Audits the creation via `logAdminAction` (`refund_created`), same pattern
 * `transitionRefundStatus` uses for status moves — every Refund-domain state
 * change carries the acting admin's id (CLAUDE.md: "Audit every state
 * change").
 */
export async function createRefund(
  db: Db,
  args: {
    orderId: number;
    amount: Decimal.Value;
    currency: string;
    reason?: string | null;
    externalReference?: string | null;
    adminId: number;
  },
): Promise<Refund> {
  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: { id: true, currency: true, orderCode: true },
  });
  if (!order) throw new ValidationError("error.order_not_found");
  if (args.currency !== order.currency) {
    throw new ValidationError("error.refund_currency_mismatch", {
      refundCurrency: args.currency,
      orderCurrency: order.currency,
    });
  }
  const amount = parseRefundAmount(args.amount);

  const refund = await db.refund.create({
    data: {
      orderId: args.orderId,
      amount,
      currency: args.currency,
      reason: args.reason ?? null,
      externalReference: args.externalReference ?? null,
    },
  });

  await logAdminAction(db, {
    adminId: args.adminId,
    action: "refund_created",
    targetType: "refund",
    targetId: refund.id,
    details: `Created a ${refund.status} refund of ${amount.toString()} ${refund.currency} for order ${order.orderCode}.`,
  });

  // The start of a refund's life, and the counterpart to the payout line
  // `executeRefund` writes at the end of it — between the two, a refund that
  // was requested but never paid out is visible in the logs as a request with
  // no payout, rather than as nothing at all. `reason` is deliberately left out
  // of the sentence: it is free admin-written text of unbounded length, and the
  // audit line above already carries the admin-facing account of this refund.
  logger.info(
    { refundId: refund.id, orderId: order.id },
    `Opened refund #${refund.id} for ${amount.toString()} ${refund.currency} against order ${order.orderCode}, requested by admin ${args.adminId} and starting in ${refund.status}. No money has moved yet — a refund only pays out when an admin executes it.`,
  );

  return refund;
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
  args: {
    refundId: number;
    from: string;
    to: string;
    adminId: number;
    meta?: string | null;
    /** Required (must be `true`) when `to` is COMPLETED. This generic path
     * NEVER moves money — see this file's module comment. Forcing an
     * explicit, named acknowledgment here (rather than silently allowing
     * COMPLETED) is what stops a future caller from mistaking this for a
     * payout-triggering completion. A refund that should actually pay the
     * buyer must go through a dedicated payout function instead:
     * `executeRefund` below for the general case, or `refundUnderpaidOrder`
     * (binance_internal.ts) for the crypto-shortfall case, which writes its own
     * COMPLETED Refund row directly and never calls this function.
     *
     * `executeRefund` DOES call this, with the flag set, and that is correct
     * rather than a loophole: by the time it does, it has already moved the
     * money in the same transaction, so the claim the flag makes — "this
     * transition alone pays nobody" — is still exactly true of the transition.
     * The AUDIT LINE, whose reader is a shop admin rather than a caller, does
     * not repeat that distinction blindly: it checks for a recorded payout and
     * says which of the two happened (see the `paidOut` lookup below). */
    acknowledgeNoPayout?: boolean;
  },
): Promise<Refund> {
  const { refundId, from, to, adminId, meta } = args;

  if (!REFUND_LEGAL_TRANSITIONS[from]?.includes(to)) {
    throw new ValidationError("error.illegal_refund_status_transition", { from, to });
  }
  if (to === RefundStatus.COMPLETED && !args.acknowledgeNoPayout) {
    throw new ValidationError("error.refund_completed_requires_payout_acknowledgement");
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

  // What the COMPLETED sentence may claim depends on whether a payout actually
  // happened, and the RefundExecution rows are the only honest answer. This
  // transition never pays anybody — that part was always true — but saying
  // "record-keeping only" beside a real payout reads to the shop admin as "the
  // buyer has NOT been paid", which is the opposite of the truth on the
  // `executeRefund` path (it credits the wallet, writes the execution, and only
  // then calls this to close the record). `executeRefund` writes its row BEFORE
  // this call and in the same transaction, so it is already visible here.
  const paidOut =
    to === RefundStatus.COMPLETED
      ? await db.refundExecution.findFirst({
          where: { refundId, status: RefundExecutionStatus.COMPLETED },
          orderBy: { id: "asc" },
          select: { id: true },
        })
      : null;

  const details =
    `Refund #${refundId} for order ${order?.orderCode ?? refund.orderId} moved from ${from} to ${to}${meta ? ` (${meta})` : ""}.` +
    (to !== RefundStatus.COMPLETED
      ? ""
      : paidOut
        ? ` The buyer has been paid — that was recorded separately as refund execution #${paidOut.id}; this transition only closed the refund record.`
        : " Record-keeping only — no payout was triggered by this transition, and none has been recorded against this refund.");
  await logAdminAction(db, { adminId, action: "refund_status_change", targetType: "refund", targetId: refundId, details });

  if (to === RefundStatus.FAILED) {
    // The one transition worth a developer's attention on its own: a buyer was
    // judged owed money and is not going to get it through this refund. The
    // other moves (PENDING → PROCESSING, → COMPLETED, → CANCELLED) are either
    // routine workflow or already carried by `executeRefund`'s own payout line.
    logger.warn(
      { refundId, orderId: refund.orderId },
      `Refund #${refundId} for order ${order?.orderCode ?? refund.orderId} was marked FAILED by admin ${adminId}${meta ? ` (${meta})` : ""} — its ${refund.amount.toString()} ${refund.currency} will not be paid out under this refund, so if the buyer is genuinely owed that money somebody has to open a new one. A refund that fails repeatedly on the same order usually means the payout route itself is broken, not the request.`,
    );
  }

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
 * Also enforces a SECOND, narrower invariant scoped to this one refund only
 * (Refund.amount's own schema doc comment): the sum of every RefundItem row
 * already attached to THIS refund, plus this new amount, must never exceed
 * the parent Refund's own quoted `amount`. This is unrelated to the
 * cross-refund subtotal check above — that one sums across every non-terminal
 * Refund touching a given OrderItem; this one is a promise a single Refund
 * made about itself. Both checks run and either can independently reject the
 * insert.
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
 *
 * Rejects attaching a new item to a Refund that is already terminal
 * (`TERMINAL_REFUND_STATUSES` — COMPLETED, FAILED, or CANCELLED): a COMPLETED
 * Refund is an already-settled financial record, and retroactively adding a
 * RefundItem to it would silently change what that settled record claims to
 * have refunded, with no audit trail for the mutation. A CANCELLED/FAILED
 * Refund is dead — items belong on a new Refund request, not resurrected onto
 * one that never (or no longer) applies. `amount` is validated finite/
 * positive by `parseRefundAmount`, for the same reasons `createRefund`
 * validates it (see that function's doc comment) — a negative amount here
 * would additionally corrupt the sum invariant below (shrinking
 * `alreadyRefunded` and letting a later item silently overrun the subtotal).
 *
 * Audits the creation via `logAdminAction` (`refund_item_created`), same
 * pattern as `createRefund`/`transitionRefundStatus`.
 */
export async function createRefundItem(
  db: Db,
  args: {
    refundId: number;
    orderItemId: number;
    amount: Decimal.Value;
    reason?: string | null;
    adminId: number;
  },
): Promise<RefundItem> {
  const refund = await db.refund.findUnique({ where: { id: args.refundId } });
  if (!refund) throw new ValidationError("error.refund_not_found");
  if (TERMINAL_REFUND_STATUSES.includes(refund.status)) {
    throw new ValidationError("error.refund_item_on_terminal_refund", { status: refund.status });
  }

  const orderItem = await db.orderItem.findUnique({ where: { id: args.orderItemId } });
  if (!orderItem) throw new ValidationError("error.order_item_not_found");
  if (orderItem.orderId !== refund.orderId) {
    throw new ValidationError("error.refund_item_order_mismatch");
  }

  const amount = parseRefundAmount(args.amount);
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

  // Refund.amount invariant (Refund.amount's own schema doc comment flags
  // this as a previously-open gap): the sum of every RefundItem row already
  // attached to THIS refund, plus this new amount, must never exceed the
  // parent Refund's own quoted total. Scoped to refundId only — unlike the
  // cross-refund subtotal check above (which sums across every non-terminal
  // Refund touching this OrderItem), Refund.amount is a promise this ONE
  // refund made about itself, unrelated to any other Refund's items.
  const refundTotal = await db.refundItem.aggregate({
    where: { refundId: args.refundId },
    _sum: { amount: true },
  });
  const alreadyOnRefund = new Decimal(refundTotal._sum?.amount ?? 0);
  const projectedOnRefund = alreadyOnRefund.plus(amount);
  if (projectedOnRefund.greaterThan(refund.amount)) {
    throw new ValidationError("error.refund_item_exceeds_refund_amount", {
      refundAmount: refund.amount.toString(),
      currency: refund.currency,
      alreadyOnRefund: alreadyOnRefund.toString(),
      attempted: amount.toString(),
    });
  }

  const refundItem = await db.refundItem.create({
    data: {
      refundId: args.refundId,
      orderItemId: args.orderItemId,
      amount,
      currency: refund.currency,
      reason: args.reason ?? null,
    },
  });

  await logAdminAction(db, {
    adminId: args.adminId,
    action: "refund_item_created",
    targetType: "refund_item",
    targetId: refundItem.id,
    details: `Added a refund item of ${amount.toString()} ${refund.currency} for order item ${args.orderItemId} to refund #${args.refundId}.`,
  });

  return refundItem;
}

/** This repo's 4-decimal money quantization, spelled once for the reads below. */
const q4 = (value: Decimal.Value | null | undefined): Decimal =>
  quantizeMoney(new Decimal(value ?? 0), 4);

/** The two payout methods `executeRefund` knows how to carry out. */
const REFUND_EXECUTION_METHODS: readonly string[] = [
  RefundExecutionMethod.WALLET,
  RefundExecutionMethod.MANUAL_TRANSFER,
];

/** What an order has already given back, broken out by the path that did it. */
interface RefundableAmountForOrder {
  /** `orderTotal` minus `alreadyPaidOut`; can be zero, never assumed positive. */
  refundable: Decimal;
  /** The sum of all three components below — the ceiling's whole deduction. */
  alreadyPaidOut: Decimal;
  /** COMPLETED `RefundExecution` amounts (`executeRefund`). */
  byExecutions: Decimal;
  /** COMPLETED `Refund` rows with no execution at all (`refundUnderpaidOrder`). */
  byLegacyRefunds: Decimal;
  /** `unfulfilled_credit` wallet movements (`creditOrderToBalance`). */
  byBalanceCredit: Decimal;
}

/**
 * How much of an order's value is still refundable: its own `totalAmount` minus
 * everything already given back to the buyer against it, by ANY path.
 *
 * "Any path" is the whole point, and it is where this used to be wrong (fixed per
 * the whole-branch review's decision D4). There are three ways money goes back to
 * a buyer for one order, they were built at different times, and only the first
 * writes the rows this check originally read:
 *
 * 1. **COMPLETED `RefundExecution` rows** — `executeRefund`, the general payout.
 *    PENDING executions are excluded because they have not paid anyone yet, and
 *    FAILED ones because they never will: a bounced bank transfer must not
 *    permanently burn refund budget, the same reasoning `createRefundItem`
 *    applies to CANCELLED/FAILED refunds.
 * 2. **COMPLETED `Refund` rows with NO `RefundExecution` at all** —
 *    `refundUnderpaidOrder` (crud/binance_internal.ts), which predates the
 *    execution model: it credits the buyer's wallet itself and writes its
 *    already-COMPLETED `Refund` row directly, deliberately bypassing the state
 *    machine (see its own doc comment). That row IS the payout record for that
 *    path, so its amount has to count. Identified by the ABSENCE of executions
 *    rather than by a reason code, which it does not carry — and that absence is
 *    also what keeps this from double-counting case 1, whose refunds always have
 *    one.
 * 3. **`unfulfilled_credit` wallet movements** — `creditOrderToBalance`
 *    (crud/orders.ts), an order the shop cannot fulfil, handed back as wallet
 *    credit. It writes no `Refund` row at all, so neither of the two reads above
 *    can see it, and it leaves the order CANCELLED rather than REFUNDED — a state
 *    nothing stops a later payout being attempted against.
 *
 * With only case 1 counted, an order refunded through case 2 or 3 could be paid
 * out AGAIN for its full value: a buyer whose underpayment was returned, or whose
 * unfulfillable order was credited, would keep that money and be paid the whole
 * total on top of it. That is not reachable through the routes shipped today —
 * `executeRefund`'s only production caller is `refundInsteadOfReplace`
 * (crud/stockReplacement.ts), which requires a DELIVERED order, and cases 2 and 3
 * both leave the order UNDERPAID-resolved or CANCELLED. The guard is fixed anyway,
 * because "unreachable" here means "no route calls it yet", and a generic admin
 * refund route is exactly the kind of thing that gets added without re-deriving
 * this ceiling.
 *
 * This is an ORDER-level ceiling, and it is deliberately separate from — and
 * additional to — `createRefundItem`'s per-`OrderItem` subtotal invariant. That
 * one stops any single line being over-refunded; this one stops an order being
 * refunded for more than the buyer ever paid for it, which nothing else checks:
 * a `Refund` needs no `RefundItem` rows at all (`refundUnderpaidOrder` writes
 * none), so the per-item check can be silently absent for a whole refund.
 *
 * Every component is read as ONE aggregate, and case 3 is scoped to the order's
 * own `currency`: `wallet_transactions` carries its own currency and IDR and USDT
 * are unconvertible here, so summing across them would produce a meaningless
 * deduction rather than a conservative one.
 *
 * Known limitation, deliberate for this milestone: `Order.totalAmount` is what
 * the buyer owed EXTERNALLY and is already net of `Order.walletUsed`, so an
 * order partly paid with wallet credit has a refundable ceiling below what the
 * buyer really handed over. That fails CLOSED (it refuses too much, never pays
 * too much), which is the right direction for a payout guard to err in, and the
 * wallet-paid portion is released by `releaseOrderHolds` on the paths that undo
 * such an order rather than by a refund.
 */
async function refundableAmountForOrder(
  db: Db,
  orderId: number,
  orderTotal: Decimal,
  currency: string,
): Promise<RefundableAmountForOrder> {
  const [executed, legacy, credited] = await Promise.all([
    db.refundExecution.aggregate({
      where: { status: RefundExecutionStatus.COMPLETED, refund: { orderId } },
      _sum: { amount: true },
    }),
    db.refund.aggregate({
      where: { orderId, status: RefundStatus.COMPLETED, executions: { none: {} } },
      _sum: { amount: true },
    }),
    db.walletTransaction.aggregate({
      where: { orderId, reason: "unfulfilled_credit", currency },
      _sum: { delta: true },
    }),
  ]);

  const byExecutions = q4(executed._sum?.amount ?? 0);
  const byLegacyRefunds = q4(legacy._sum?.amount ?? 0);
  // `unfulfilled_credit` is only ever written as a credit to the buyer, but the
  // sum is floored at zero so a hand-written negative row cannot RAISE the
  // ceiling — a guard against over-refunding must never be loosened by the rows
  // it reads.
  const byBalanceCredit = Decimal.max(new Decimal(0), q4(credited._sum?.delta ?? 0));

  const alreadyPaidOut = q4(byExecutions.plus(byLegacyRefunds).plus(byBalanceCredit));
  return {
    refundable: orderTotal.minus(alreadyPaidOut),
    alreadyPaidOut,
    byExecutions,
    byLegacyRefunds,
    byBalanceCredit,
  };
}

/**
 * Pay a refund out, and record that it was paid: the money movement the rest of
 * this file deliberately does not do (Financial Ledger M4).
 *
 * Everything below happens in ONE transaction — the wallet credit, the
 * `RefundExecution` row, the ledger posting, the Refund's move to COMPLETED and
 * the order's own status — so a failure anywhere leaves no trace of a payout
 * that did not fully happen. That is also why there is no "mark this attempt
 * FAILED" path here: a mid-flight error rolls the attempt away entirely, and a
 * FAILED `RefundExecution` row means something different and more deliberate —
 * an admin recording after the fact that a transfer which really was attempted
 * bounced. Nothing stops such a row being written later; this function just
 * never writes one itself.
 *
 * The caller is responsible for getting the `Refund` to PROCESSING first (via
 * `transitionRefundStatus`), which is the review step: this function pays a
 * refund, it does not decide whether to. A Refund in any other status is
 * rejected, which also makes double-paying one impossible — the first call
 * leaves it COMPLETED, and a second call finds it there.
 *
 * ## The two payout methods
 *
 * `WALLET` credits the buyer's balance through `adjustWallet`, with **no
 * `orderId` on the wallet movement**, and that omission is load-bearing rather
 * than an oversight. `wallet_transactions` is UNIQUE on `(orderId, reason)` —
 * "one wallet movement per order per reason" — and every other reason that sets
 * `orderId` can only fire once per order because a state machine gates it
 * (`order_payment`, `wallet_topup`, `underpaid_refund`, `unfulfilled_credit`,
 * `order_refund`). Refunds break that assumption outright: one order can
 * legitimately be refunded twice (a second dead account found a week later, or a
 * bounced transfer retried), and with an `orderId` set the SECOND such payout
 * would die on a unique violation — a real customer, genuinely owed money, not
 * getting paid. `adjustWallet`'s own doc comment spells out the escape:
 * "callers with no order (`orderId` null) are unconstrained." Nothing is lost
 * from the audit trail, because the linkage lives on richer rows anyway: the
 * `RefundExecution` points at its `Refund`, which points at the `Order`, and
 * `RefundExecution.reference` records the id of the `WalletTransaction` this
 * created (unless the caller supplied a reference of their own, which wins —
 * theirs names something outside this system that a reconciliation cannot
 * rediscover).
 *
 * `MANUAL_TRANSFER` moves no wallet money at all; the admin already sent it out
 * of band, and `proofFileId` is the evidence. It is required for this method,
 * stored verbatim as the Telegram `file_id` convention this codebase uses
 * everywhere else (`Order.paymentProofFileId`), and NEVER logged — payment-proof
 * file_ids are on CLAUDE.md's "never log secrets" list, so it appears in no
 * audit line, no ledger description and no pino message. Such an execution is
 * COMPLETED the moment it is recorded: there is no "payout queued" state in any
 * UI yet, so a two-phase PENDING→COMPLETED workflow would model a step no admin
 * can see or act on.
 *
 * ## What else moves
 *
 * The ledger posting is `postRefundExecutionPosting`'s job (crud/
 * ledgerPostings.ts owns every account mapping) and is made inside this same
 * transaction. `Order.status` moves DELIVERED → REFUNDED only when THIS payout
 * brings the order's total refunded amount up to `Order.totalAmount` exactly:
 * a partial refund leaves the order DELIVERED, because it still has a delivered,
 * partly-paid-for sale behind it. An order in any other status is left alone
 * without an error — a full refund of, say, a `PARTIALLY_DELIVERED` order is a
 * legitimate payout, and `orderStatus.ts` deliberately gives that status no
 * outgoing edge to REFUNDED yet; refusing the payout over the status of a row
 * that is not the money would be the wrong failure.
 */
export async function executeRefund(
  db: Db,
  args: {
    refundId: number;
    /** `RefundExecutionMethod` (@app/core/enums): WALLET | MANUAL_TRANSFER. */
    method: string;
    amount: Decimal.Value;
    /** An identifier for the payout outside this system (a bank transfer
     *  reference, a support ticket). Left unset on a WALLET payout, the created
     *  `WalletTransaction`'s id is recorded instead. */
    reference?: string | null;
    /** Required for MANUAL_TRANSFER, ignored for WALLET. Never logged. */
    proofFileId?: string | null;
    /** The admin performing the payout. A payout is always attributable. */
    executedBy: number;
    notes?: string | null;
  },
): Promise<RefundExecution> {
  // Validated before opening a transaction: these three are pure checks on the
  // arguments, so there is nothing to roll back if one rejects.
  if (!REFUND_EXECUTION_METHODS.includes(args.method)) {
    throw new ValidationError("error.refund_execution_method_invalid", { method: args.method });
  }
  // Quantized to the same 4 decimal places `adjustWallet` applies to a balance
  // and `crud/ledger.ts` stores an entry at, so the amount on the
  // `RefundExecution` row, the amount the buyer's balance moves by and the
  // amount in the books are one number rather than three roundings of it. Then
  // re-checked for positivity, because an amount small enough to quantize away
  // (0.00001) passes `parseRefundAmount` and would otherwise record a payout of
  // zero as COMPLETED.
  const amount = quantizeMoney(parseRefundAmount(args.amount), 4);
  if (!amount.greaterThan(0)) throw new ValidationError("error.refund_amount_invalid");
  const proofFileId = args.proofFileId?.trim() || null;
  if (args.method === RefundExecutionMethod.MANUAL_TRANSFER && !proofFileId) {
    throw new ValidationError("error.refund_execution_proof_required");
  }
  const reference = args.reference?.trim() || null;

  const payOut = async (tx: Db) => {
    const refund = await tx.refund.findUnique({ where: { id: args.refundId } });
    if (!refund) throw new ValidationError("error.refund_not_found");
    if (refund.status !== RefundStatus.PROCESSING) {
      // A refund already sitting at COMPLETED is the interesting shape here:
      // something asked to pay out a refund that has already been paid, so this
      // guard is the only thing standing between a buyer and a second payout.
      // Warned rather than errored because it worked — nothing was paid twice —
      // but unlike a ledger replay this is NOT an expected race: no rail retries
      // a payout on its own, so a repeat means an admin double-submitted or a
      // caller lost track of what it had already done, and it is worth finding
      // out which.
      logger.warn(
        { refundId: refund.id, status: refund.status },
        refund.status === RefundStatus.COMPLETED
          ? `Paid nothing out for refund #${refund.id}, because it has already been paid and settled — this second payout request was refused, so the buyer keeps exactly the one refund they were owed. Whatever asked for it believes an unpaid refund is outstanding when none is, which is worth tracing back.`
          : `Paid nothing out for refund #${refund.id}, because a refund can only be paid while it is PROCESSING and this one is ${refund.status} — an admin has to review and move it to PROCESSING first. Nothing was paid and nothing was recorded.`,
      );
      throw new ValidationError("error.refund_not_processing", { status: refund.status });
    }

    // Hold the ORDER row for the rest of this transaction, before the
    // refundable-budget sum below reads anything.
    //
    // That sum is a read-then-write over rows this function is about to add to,
    // and unlike the rest of the Refund domain there IS a single row to gate it
    // on. Without the lock, two admins paying out two different Refunds on the
    // same order at the same instant both read the same "already paid out"
    // total, both pass their own budget check, and both commit — refunding more
    // than the order was ever worth, which is the one thing this check exists to
    // prevent. (Two payouts on the SAME Refund are already impossible:
    // `transitionRefundStatus`' atomic claim below lets exactly one of them
    // reach COMPLETED.) Same lock-then-read shape and reasoning as
    // `adjustWallet`'s own `SELECT ... FOR UPDATE` on the user row.
    //
    // Lock order is order-then-user here, while `refundUnderpaidOrder` takes
    // user-then-order, so those two could in principle deadlock on one
    // order+buyer. Postgres detects that and aborts one transaction, which for a
    // payout is the harmless direction: nothing is paid and nothing is recorded,
    // versus a buyer paid twice.
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${refund.orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: refund.orderId },
      select: { id: true, orderCode: true, currency: true, totalAmount: true, status: true, userId: true },
    });
    // Unreachable in practice — `Refund.order` is a required FK with
    // onDelete: Restrict — but a payout must never proceed on an order it could
    // not read, since every figure below comes from that row.
    if (!order) throw new ValidationError("error.order_not_found");
    // `createRefund` already pins a Refund to its order's currency, so this can
    // only differ on a row written directly. Checked anyway because the budget
    // check below compares this payout against `order.totalAmount`: two
    // currencies in that comparison is a meaningless number, not a large one.
    if (refund.currency !== order.currency) {
      throw new ValidationError("error.refund_currency_mismatch", {
        refundCurrency: refund.currency,
        orderCurrency: order.currency,
      });
    }

    const orderTotal = quantizeMoney(new Decimal(order.totalAmount), 4);
    const budget = await refundableAmountForOrder(tx, order.id, orderTotal, order.currency);
    const { refundable, alreadyPaidOut } = budget;
    if (amount.greaterThan(refundable)) {
      // Logged as well as thrown, and the components are spelled out, because the
      // two newer deductions are the ones nobody expects: a refusal that only said
      // "already paid out 5000" against an order with no `RefundExecution` rows at
      // all reads as a bug in this guard rather than as a refund that already
      // happened somewhere else.
      logger.warn(
        { refundId: refund.id, orderId: order.id },
        `Paid nothing out for refund #${refund.id} on order ${order.orderCode}, because the ${amount.toString()} ${refund.currency} requested is more than the ${refundable.toString()} ${refund.currency} still refundable on it. Of the order's ${orderTotal.toString()} ${refund.currency} total, ${alreadyPaidOut.toString()} has already gone back to the buyer: ${budget.byExecutions.toString()} through recorded refund payouts, ${budget.byLegacyRefunds.toString()} through the underpaid-order refund path, and ${budget.byBalanceCredit.toString()} as wallet credit for an order the shop could not fulfil. Nothing was paid and nothing was recorded.`,
      );
      throw new ValidationError("error.refund_exceeds_refundable_amount", {
        refundable: refundable.toString(),
        currency: refund.currency,
        alreadyPaidOut: alreadyPaidOut.toString(),
        attempted: amount.toString(),
      });
    }

    // The payout itself, first: everything after this only describes it, and
    // nothing may claim a payout that has not already succeeded.
    let walletTransactionId: number | null = null;
    if (args.method === RefundExecutionMethod.WALLET) {
      const movement = await adjustWallet(tx, order.userId, amount, {
        reason: "refund_execution",
        currency: refund.currency as "IDR" | "USDT",
        // Deliberately null — see this function's doc comment. With an orderId
        // here, a second legitimate refund on this order dies on
        // `wallet_transactions`' UNIQUE (orderId, reason).
        orderId: null,
        adminId: args.executedBy,
        note: `Refund #${refund.id} for order ${order.orderCode}`,
      });
      walletTransactionId = movement.transactionId;
    }

    const executedAt = new Date();
    const execution = await tx.refundExecution.create({
      data: {
        refundId: refund.id,
        method: args.method,
        amount,
        // Snapshotted from the Refund (itself pinned to the order's currency),
        // never re-derived on read — same reasoning as Refund.currency's own.
        currency: refund.currency,
        // Written COMPLETED in one insert rather than PENDING-then-updated: the
        // payout above has already happened by this line, and if anything after
        // it throws, this row goes away with the transaction. A PENDING row
        // would only be observable in a transaction nobody else can read.
        status: RefundExecutionStatus.COMPLETED,
        reference: reference ?? (walletTransactionId !== null ? String(walletTransactionId) : null),
        proofFileId: args.method === RefundExecutionMethod.MANUAL_TRANSFER ? proofFileId : null,
        executedBy: args.executedBy,
        executedAt,
        notes: args.notes ?? null,
      },
    });

    await postRefundExecutionPosting(tx, {
      refundExecutionId: execution.id,
      orderId: order.id,
      orderCode: order.orderCode,
      occurredAt: executedAt,
    });

    await transitionRefundStatus(tx, {
      refundId: refund.id,
      from: RefundStatus.PROCESSING,
      to: RefundStatus.COMPLETED,
      adminId: args.executedBy,
      // True as stated: the money moved a few lines above, in this transaction,
      // not in the transition. The RefundExecution row created above is already
      // visible to `transitionRefundStatus`, so the sentence it appends for
      // COMPLETED says the buyer HAS been paid and names that row, rather than
      // the bare "record-keeping only" it uses for a refund nobody paid.
      acknowledgeNoPayout: true,
      meta: `payout already made: refund execution #${execution.id} paid ${amount.toString()} ${refund.currency} by ${args.method}`,
    });

    const fullyRefunded = alreadyPaidOut.plus(amount).equals(orderTotal);
    const closesOrder = fullyRefunded && order.status === OrderStatus.DELIVERED;
    if (closesOrder) {
      await transitionOrderStatus(tx, {
        orderId: order.id,
        from: OrderStatus.DELIVERED,
        to: OrderStatus.REFUNDED,
        meta: `fully refunded by admin_id=${args.executedBy} (refund execution #${execution.id})`,
      });
    }

    const paidHow =
      args.method === RefundExecutionMethod.WALLET
        ? "as credit on their wallet balance"
        : "by a manual transfer";
    await logAdminAction(tx, {
      adminId: args.executedBy,
      action: "refund_executed",
      targetType: "refund_execution",
      targetId: execution.id,
      details:
        `Paid back ${amount.toString()} ${refund.currency} to the buyer of order ${order.orderCode} ${paidHow}, settling refund #${refund.id}.` +
        (closesOrder ? " The whole order has now been refunded, so it is marked REFUNDED." : ""),
    });

    return { execution, orderCode: order.orderCode, closesOrder };
  };

  // A `Tx` has no `$transaction` (Prisma strips it from the interactive
  // transaction client), so its presence is what distinguishes the bare client
  // from a caller-owned transaction — same idiom as `adjustWallet`.
  const ownsTransaction = "$transaction" in db && typeof db.$transaction === "function";
  const { execution, orderCode, closesOrder } = ownsTransaction
    ? await db.$transaction(payOut)
    : await payOut(db);

  // Logged after the commit, never inside it: a line claiming a buyer was paid
  // must not survive a transaction that rolled the payment back.
  logger.info(
    { refundExecutionId: execution.id, refundId: execution.refundId },
    `Paid a refund of ${execution.amount.toString()} ${execution.currency} to the buyer of order ${orderCode} by ${execution.method}, recorded as refund execution ${execution.id} by admin ${args.executedBy}.` +
      (closesOrder ? " That settles the order's whole value, so the order is now REFUNDED." : ""),
  );

  return execution;
}
