/**
 * Account/stock replacement (reissue) — the service that answers "the account
 * you sold me is dead" (Financial Ledger M19, on top of M18's schema-only
 * `StockReplacement` model).
 *
 * ONE UNIT, ONE REQUEST. A bulk purchase is stored as one `OrderItem` row per
 * unit (see `StockReplacement`'s own schema doc comment), so "unit #3 of 5 is
 * dead" is already addressable as a single `orderItemId` and nothing here needs
 * a quantity or an index.
 *
 * THE THREE MUTATORS BELOW ARE THE ONLY WRITERS of `stock_replacements`, the
 * same "one function owns this table" shape `adjustWallet` and
 * `transitionOrderStatus` have for theirs. Every status move they make goes
 * through `claimStockReplacementStatus`, which validates it against
 * `STOCK_REPLACEMENT_LEGAL_TRANSITIONS` and claims the row atomically, so a
 * status can never move by any other route:
 *
 *  - `replaceStockItem` opens a request and makes the first allocation attempt
 *    (REQUESTED → COMPLETED when a spare credential exists, → AWAITING_STOCK
 *    when none does).
 *  - `retryReplacementAllocation` is that same attempt again, for a request
 *    already parked at AWAITING_STOCK, once the SKU has been restocked
 *    (AWAITING_STOCK → COMPLETED, or a no-op that leaves it waiting). There is
 *    deliberately NO background poller doing this: an admin (or M20's admin UI)
 *    triggers it.
 *  - `refundInsteadOfReplace` is the admin's explicit decision to stop waiting
 *    and give the money back (AWAITING_STOCK → REFUNDED_INSTEAD).
 *
 * CANCELLED and FAILED are legal shapes in the table but have no mutator yet —
 * nothing in this milestone can withdraw or fail a request, and inventing an
 * admin action for it here would be a UI decision made in the wrong layer.
 *
 * ## The one narrow path allowed to kill a SOLD credential
 *
 * `markStockDead`/`bulkMarkStockDead` (crud/stock.ts) deliberately REFUSE to
 * touch a SOLD row — "a delivered credential is never altered" — and that
 * refusal is not loosened for this feature. `killDeliveredStockItem` below is
 * this feature's own narrow, audited path: it only ever fires against the exact
 * row a `StockReplacement` names, only inside that request's transaction, and
 * it stamps a note pointing back at the request that explains it. The history
 * of what was delivered stays intact and readable; the swap is described by the
 * `StockReplacement` row, which names both sides.
 *
 * ## Redelivery reuses the real delivery rail, not a second one
 *
 * There is exactly one way a buyer's credentials reach them: a
 * `notification_outbox` row that the dispatcher renders by reading the order's
 * CURRENT `OrderItem.stockItem` rows live at send time — the credential itself
 * never rides in the payload (CLAUDE.md). So repointing `OrderItem.stockItemId`
 * at the new row and enqueueing `enqueueOrderDeliveredDm` IS the redelivery,
 * byte for byte the same rail web-admin's "resend credentials" button uses. No
 * Telegram call is made from here (CLAUDE.md: never send Telegram from outside
 * the bot/dispatcher), and the caller is free to nudge the dispatcher after the
 * transaction commits, exactly as the resend route does.
 *
 * ## The refund fallback moves money through the existing path
 *
 * `refundInsteadOfReplace` is this codebase's FIRST production caller of
 * `createRefund`/`createRefundItem`. It adds no ledger posting of its own: it
 * builds the Refund records and then hands the payout to `executeRefund`
 * (crud/refunds.ts, M4), which credits the wallet, writes the
 * `RefundExecution`, posts the double-entry event and closes the Refund. If a
 * future edit finds itself calling a `post*Posting` function from this file,
 * that is the sign the payout stopped going through `executeRefund`.
 */
import {
  OrderStatus,
  RefundExecutionMethod,
  RefundStatus,
  StockReplacementStatus,
  StockStatus,
  TERMINAL_STOCK_REPLACEMENT_STATUSES,
} from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { quantizeMoney } from "@app/core/formatters";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";
import type { Refund, RefundExecution, StockItem, StockReplacement } from "@prisma/client";
import type { Db } from "./_types";
import { logAdminAction } from "./audit";
import { enqueueOrderDeliveredDm } from "./notifications";
import { createRefund, createRefundItem, executeRefund, transitionRefundStatus } from "./refunds";
import { allocateOneAvailableStock } from "./stock";

/**
 * Legal `StockReplacement.status` transitions — same lookup-table shape as
 * `REFUND_LEGAL_TRANSITIONS` (crud/refunds.ts) and `LEGAL_TRANSITIONS`
 * (crud/orderStatus.ts), validated before the atomic claim rather than
 * scattered through the mutators as ad-hoc `if`s.
 *
 * REQUESTED is where every request opens. It can resolve straight to COMPLETED
 * (a spare credential was there), park at AWAITING_STOCK (none was), or be
 * closed unresolved (CANCELLED/FAILED). It may NOT go straight to
 * REFUNDED_INSTEAD: refunding instead of replacing is a decision about a
 * request the shop has already failed to fill, so it is reachable only from
 * AWAITING_STOCK — a request that has not even tried to allocate yet must try
 * first, or the shop pays out money it never needed to.
 *
 * AWAITING_STOCK can still complete (a restock arrived, see
 * `retryReplacementAllocation`), be refunded instead, or be closed unresolved.
 *
 * COMPLETED, REFUNDED_INSTEAD, CANCELLED and FAILED are terminal, with no
 * outgoing edges — the four values `TERMINAL_STOCK_REPLACEMENT_STATUSES`
 * (@app/core/enums) already names, and each of them is what stamps
 * `resolvedAt`.
 */
export const STOCK_REPLACEMENT_LEGAL_TRANSITIONS: Record<string, readonly string[]> = {
  [StockReplacementStatus.REQUESTED]: [
    StockReplacementStatus.AWAITING_STOCK,
    StockReplacementStatus.COMPLETED,
    StockReplacementStatus.CANCELLED,
    StockReplacementStatus.FAILED,
  ],
  [StockReplacementStatus.AWAITING_STOCK]: [
    StockReplacementStatus.COMPLETED,
    StockReplacementStatus.REFUNDED_INSTEAD,
    StockReplacementStatus.CANCELLED,
    StockReplacementStatus.FAILED,
  ],
  [StockReplacementStatus.COMPLETED]: [],
  [StockReplacementStatus.REFUNDED_INSTEAD]: [],
  [StockReplacementStatus.CANCELLED]: [],
  [StockReplacementStatus.FAILED]: [],
};

/** What every mutator in this file hands back: the request row as it now
 *  stands, plus the credential handed over (null when none was issued). */
export interface StockReplacementOutcome {
  replacement: StockReplacement;
  replacementStockItem: StockItem | null;
}

/** `refundInsteadOfReplace`'s outcome — the request plus the money records it
 *  produced, so a caller can render the payout without re-reading them. */
export interface RefundInsteadOutcome {
  replacement: StockReplacement;
  refund: Refund;
  execution: RefundExecution;
}

/**
 * Move a `StockReplacement` from `from` to `to`: validates the shape against
 * `STOCK_REPLACEMENT_LEGAL_TRANSITIONS`, then claims the row atomically
 * (`updateMany` with the expected current status in the WHERE clause — the same
 * pattern `transitionRefundStatus`/`transitionOrderStatus` use) so a stale or
 * duplicated caller fails safely instead of overwriting a request that has
 * already moved on. Stamps `resolvedAt` the moment the row reaches a terminal
 * status, which is the only place that column is ever written.
 *
 * Not exported: a status move that did not come from one of this file's three
 * mutators has no audit line and no side effects behind it, so there is
 * deliberately no way to make one.
 */
async function claimStockReplacementStatus(
  db: Db,
  args: {
    stockReplacementId: number;
    from: string;
    to: string;
    /** Columns the resolution itself carries (`replacementStockItemId` on the
     *  replacement path, `refundId` on the refund fallback). */
    data?: { replacementStockItemId?: number; refundId?: number };
  },
): Promise<StockReplacement> {
  const { stockReplacementId, from, to } = args;
  if (!STOCK_REPLACEMENT_LEGAL_TRANSITIONS[from]?.includes(to)) {
    throw new ValidationError("error.illegal_stock_replacement_status_transition", { from, to });
  }

  const claim = await db.stockReplacement.updateMany({
    where: { id: stockReplacementId, status: from },
    data: {
      status: to,
      ...(TERMINAL_STOCK_REPLACEMENT_STATUSES.includes(to as StockReplacementStatus)
        ? { resolvedAt: new Date() }
        : {}),
      ...(args.data ?? {}),
    },
  });
  if (claim.count !== 1) {
    // Either the request doesn't exist or its real status no longer matches
    // `from` — the same error either way, since both mean "this transition
    // cannot be applied as requested" (mirrors transitionRefundStatus).
    throw new ValidationError("error.illegal_stock_replacement_status_transition", { from, to });
  }
  return db.stockReplacement.findUniqueOrThrow({ where: { id: stockReplacementId } });
}

/**
 * Mark the delivered (SOLD) credential this request names as DEAD — the narrow
 * exception described in this file's module comment, and the reason it is a
 * local `updateMany` rather than a call into `markStockDead` (which refuses a
 * SOLD row on purpose, and must keep refusing).
 *
 * Guarded on `status: SOLD` so it can only ever fire once for a given row, and
 * so it can never silently "kill" a row that some other path already moved.
 * The note names the request, which is where the buyer's own account of what
 * was wrong lives — the credential itself is never written into it.
 */
async function killDeliveredStockItem(
  db: Db,
  stockItemId: number,
  stockReplacementId: number,
): Promise<void> {
  const res = await db.stockItem.updateMany({
    where: { id: stockItemId, status: StockStatus.SOLD },
    data: {
      status: StockStatus.DEAD,
      note: `Reported bad by the buyer and taken out of use under stock replacement #${stockReplacementId}.`,
    },
  });
  if (res.count !== 1) {
    // Unreachable behind the caller's SOLD check plus the row lock, but a
    // replacement must never proceed having failed to retire the bad
    // credential — that would leave the shop's books claiming one sale is
    // covered by two live accounts.
    throw new ValidationError("error.stock_replacement_item_not_sold");
  }
}

/**
 * What one purchased UNIT is actually refundable for, in the ORDER's currency.
 *
 * Not simply `OrderItem.unitPrice`. Two corrections, both of which already have
 * a precedent in `crud/revenue.ts`'s `orderItemRevenueIdr` and are applied here
 * in the same order and the same arithmetic:
 *
 *  1. **Order-level discounts are prorated in.** `bulkDiscountAmount` and
 *     `discountAmount` (voucher) live only on the `Order` row and are NEVER
 *     applied to `OrderItem.unitPrice`, so paying a unit back at its raw
 *     unitPrice would refund a discounted buyer more than they paid for it.
 *     Split by this line's share of `subtotalAmount`, multiplying before
 *     dividing so the single division happens once against a full-precision
 *     numerator.
 *  2. **FX.** `OrderItem.unitPrice` is always the catalog's central-IDR price
 *     and does NOT follow `Order.currency` (revenue.ts spells out the bug that
 *     rule exists to prevent). `Refund.currency` is pinned to the ORDER's
 *     currency by `createRefund`, so a USDT order's unit has to come back
 *     through that order's own `fxRate` snapshot — never a live rate, the same
 *     rule `idrToBucketCurrency` follows.
 *
 * Quantized to 4dp, the precision `executeRefund`, `adjustWallet` and the
 * ledger all agree on, so the RefundItem, the payout and the books carry one
 * number rather than three roundings of it.
 *
 * `walletUsed` is deliberately NOT subtracted: it is a payment method, not a
 * discount — the buyer really did pay that much for the unit, just partly with
 * credit they already held. `executeRefund`'s own order-level ceiling is
 * `Order.totalAmount`, which IS net of `walletUsed`, so an order paid largely
 * from the wallet can have this figure refused there. That fails CLOSED (it
 * refuses to pay, never overpays), which is the direction a payout guard should
 * err in, and it is the same limitation `refundableAmountForOrder` already
 * documents rather than a new one introduced here.
 */
function refundableAmountForUnit(
  order: {
    subtotalAmount: Decimal.Value;
    bulkDiscountAmount: Decimal.Value;
    discountAmount: Decimal.Value;
    currency: string;
    fxRate: Decimal.Value | null;
  },
  item: { unitPrice: Decimal.Value; quantity: number },
): Decimal {
  const lineGross = new Decimal(item.unitPrice).times(item.quantity);
  const totalDiscount = new Decimal(order.bulkDiscountAmount).plus(order.discountAmount);
  const orderSubtotal = new Decimal(order.subtotalAmount);
  let net = lineGross;
  if (totalDiscount.greaterThan(0) && orderSubtotal.greaterThan(0)) {
    net = lineGross.minus(totalDiscount.times(lineGross).div(orderSubtotal));
  }
  if (order.currency !== "IDR" && order.fxRate != null) {
    net = net.div(new Decimal(order.fxRate));
  }
  return quantizeMoney(net, 4);
}

/** The unit's position within its order ("1 of 5"), for the admin-facing audit
 *  line. Ordered by id, the same order every admin list renders items in. */
async function unitPosition(db: Db, orderId: number, orderItemId: number) {
  const ids = await db.orderItem.findMany({
    where: { orderId },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  return { index: ids.findIndex((row) => row.id === orderItemId) + 1, total: ids.length };
}

/** Everything the mutators need about the unit under complaint, read once. */
async function loadUnit(db: Db, orderItemId: number) {
  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    include: {
      product: { select: { id: true, name: true } },
      order: {
        select: {
          id: true,
          orderCode: true,
          status: true,
          currency: true,
          fxRate: true,
          subtotalAmount: true,
          discountAmount: true,
          bulkDiscountAmount: true,
          totalAmount: true,
          userId: true,
          user: { select: { telegramId: true, language: true } },
        },
      },
      stockItem: { select: { id: true, status: true } },
    },
  });
  if (!item) throw new ValidationError("error.order_item_not_found");
  return item;
}

/**
 * Try to issue a replacement credential for `item` and, if one is there, hand
 * it over for real: flip it SOLD, repoint the OrderItem at it, and enqueue the
 * buyer's credentials DM (see this file's module comment on why that enqueue IS
 * the redelivery). Returns null when the SKU has nothing AVAILABLE, which is
 * the AWAITING_STOCK outcome rather than an error.
 *
 * `allocateOneAvailableStock` only RESERVES a row (status + orderId +
 * reservedAt); taking it to SOLD and stamping `soldAt` is the fulfilment step
 * `approveOrder` does in its own delivery loop, and this is that same step for
 * one item.
 */
async function issueReplacementCredential(
  db: Db,
  item: Awaited<ReturnType<typeof loadUnit>>,
): Promise<StockItem | null> {
  const reserved = await allocateOneAvailableStock(db, item.productId, item.order.id);
  if (!reserved) return null;

  const sold = await db.stockItem.update({
    where: { id: reserved.id },
    data: { status: StockStatus.SOLD, soldAt: new Date() },
  });
  await db.orderItem.update({ where: { id: item.id }, data: { stockItemId: sold.id } });
  await enqueueOrderDeliveredDm(db, {
    orderId: item.order.id,
    orderCode: item.order.orderCode,
    telegramId: item.order.user.telegramId,
    language: item.order.user.language,
  });
  return sold;
}

/**
 * Record that one delivered credential was bad, retire it, and replace it if
 * the shop can — the one sanctioned way to open a `StockReplacement`.
 *
 * Refuses, with a specific error each time:
 *  - an order that is not DELIVERED (nothing has been handed over yet, so
 *    there is nothing to replace — an undelivered order is fixed by delivering
 *    or cancelling it, not by this);
 *  - an `OrderItem` whose current `stockItemId` is absent or is not a SOLD row.
 *    This is what keeps hand-fulfilled (MANUAL/MANUAL_WITH_INFO) orders out
 *    entirely — they never reserve stock — and it is also what stops a unit
 *    being replaced twice over: after a REFUNDED_INSTEAD the item still points
 *    at the DEAD original, so a second request is refused here;
 *  - a unit that already has a NON-TERMINAL request open
 *    (`TERMINAL_STOCK_REPLACEMENT_STATUSES` defines what counts as closed).
 *    One open request per unit at a time: two would each retire a credential
 *    and each hand one out, paying for one complaint twice.
 *
 * Concurrency: the `OrderItem` row is locked FOR UPDATE before anything is
 * read, so two admins acting on the same unit at the same instant are
 * serialized and the second one sees the first one's committed request and is
 * refused by the guard above. Without the lock both would read "no open
 * request" and both would proceed — the same read-then-write shape
 * `executeRefund` locks the order row for, and for the same reason.
 */
export async function replaceStockItem(
  db: Db,
  args: {
    orderItemId: number;
    /** Admin-written account of what was wrong with the delivered credential. */
    reason: string;
    /** The admin recording this. A replacement is always attributable. */
    executedBy: number;
    /** The support ticket the complaint arrived on, when it arrived on one. */
    supportTicketId?: number | null;
    /** Admin notes about the handling itself, as opposed to `reason`. */
    notes?: string | null;
  },
): Promise<StockReplacementOutcome> {
  const run = async (tx: Db): Promise<StockReplacementOutcome> => {
    await tx.$queryRaw`SELECT id FROM order_items WHERE id = ${args.orderItemId} FOR UPDATE`;
    const item = await loadUnit(tx, args.orderItemId);

    if (item.order.status !== OrderStatus.DELIVERED) {
      throw new ValidationError("error.stock_replacement_order_not_delivered", {
        status: item.order.status,
      });
    }
    // Checked BEFORE the SOLD check below, although either would refuse. Once a
    // request is open its own first act was to retire the delivered credential,
    // so a second caller would find a DEAD row and be told "this line has no
    // delivered account to replace" — true, but baffling, and it hides the one
    // thing the admin needs to know and can act on: request #N is already open,
    // go and resolve that one. This is the order the CONCURRENT case actually
    // lands in, not a hypothetical.
    const open = await tx.stockReplacement.findFirst({
      where: {
        orderItemId: args.orderItemId,
        status: { notIn: [...TERMINAL_STOCK_REPLACEMENT_STATUSES] },
      },
      select: { id: true },
    });
    if (open) {
      throw new ValidationError("error.stock_replacement_already_open", { existingId: open.id });
    }
    if (!item.stockItem || item.stockItem.status !== StockStatus.SOLD) {
      throw new ValidationError("error.stock_replacement_item_not_sold");
    }

    const replacementRow = await tx.stockReplacement.create({
      data: {
        orderItemId: args.orderItemId,
        originalStockItemId: item.stockItem.id,
        supportTicketId: args.supportTicketId ?? null,
        reason: args.reason,
        status: StockReplacementStatus.REQUESTED,
        requestedBy: args.executedBy,
        notes: args.notes ?? null,
      },
    });

    await killDeliveredStockItem(tx, item.stockItem.id, replacementRow.id);

    const issued = await issueReplacementCredential(tx, item);
    const { index, total } = await unitPosition(tx, item.order.id, item.id);
    const which = `${index} of ${total}`;

    const replacement = await claimStockReplacementStatus(tx, {
      stockReplacementId: replacementRow.id,
      from: StockReplacementStatus.REQUESTED,
      to: issued ? StockReplacementStatus.COMPLETED : StockReplacementStatus.AWAITING_STOCK,
      data: issued ? { replacementStockItemId: issued.id } : undefined,
    });

    await logAdminAction(tx, {
      adminId: args.executedBy,
      action: issued ? "stock_replacement_completed" : "stock_replacement_awaiting_stock",
      targetType: "stock_replacement",
      targetId: replacement.id,
      details: issued
        ? `Replaced account ${which} on order ${item.order.orderCode} — the buyer reported: ${args.reason}. The old account was retired and a fresh ${item.product.name} was sent to them.`
        : `Retired account ${which} on order ${item.order.orderCode} — the buyer reported: ${args.reason}. There is no spare ${item.product.name} in stock, so the buyer is waiting for a restock or a refund.`,
    });

    return { replacement, replacementStockItem: issued };
  };

  // A `Tx` has no `$transaction` (Prisma strips it from the interactive
  // transaction client), so its presence is what distinguishes the bare client
  // from a caller-owned transaction — same idiom as `executeRefund`/
  // `adjustWallet`.
  const ownsTransaction = "$transaction" in db && typeof db.$transaction === "function";
  const outcome = ownsTransaction ? await db.$transaction(run) : await run(db);

  // Logged after the commit, never inside it: a line claiming a buyer holds a
  // new account must not survive a transaction that rolled the swap back. The
  // buyer's own `reason` is left out for the same purpose `createRefund` leaves
  // it out of its pino line — it is unbounded admin-written text, and the audit
  // entry above already carries the admin-facing account of this.
  if (outcome.replacementStockItem) {
    logger.info(
      { stockReplacementId: outcome.replacement.id, orderItemId: args.orderItemId },
      `Replaced a bad account on order item ${args.orderItemId} under stock replacement ${outcome.replacement.id}: the delivered credential is now DEAD, a fresh one is SOLD against the same order, and the buyer's credentials message has been queued for re-sending by admin ${args.executedBy}.`,
    );
  } else {
    logger.warn(
      { stockReplacementId: outcome.replacement.id, orderItemId: args.orderItemId },
      `Retired a bad account on order item ${args.orderItemId} under stock replacement ${outcome.replacement.id}, but had no AVAILABLE credential of that denomination to hand over, so the request is parked at AWAITING_STOCK and the buyer is holding nothing for that unit. Nothing retries this on its own — an admin has to restock and re-run the allocation, or refund the unit instead.`,
    );
  }

  return outcome;
}

/**
 * Try again to issue a replacement for a request sitting at AWAITING_STOCK —
 * the resume step for the "we were out of stock, then we restocked" case.
 *
 * Deliberately a separate mutator rather than re-calling `replaceStockItem`:
 * by this point the `OrderItem` points at the DEAD original and an open request
 * already exists, so both of that function's guards would (correctly) refuse.
 * And deliberately admin-triggered rather than a poller — nothing in this
 * milestone sweeps `AWAITING_STOCK` rows in the background.
 *
 * Finding nothing to allocate is NOT an error: the request is simply left where
 * it was, with no status move and no audit line, and the caller is told by the
 * null `replacementStockItem`. Only a real state change is worth an admin's
 * audit log.
 */
export async function retryReplacementAllocation(
  db: Db,
  args: { stockReplacementId: number; executedBy: number },
): Promise<StockReplacementOutcome> {
  const run = async (tx: Db): Promise<StockReplacementOutcome> => {
    // Locked before the status is read, so two admins retrying the same request
    // at once cannot both allocate a credential for it.
    await tx.$queryRaw`SELECT id FROM stock_replacements WHERE id = ${args.stockReplacementId} FOR UPDATE`;
    const existing = await tx.stockReplacement.findUnique({
      where: { id: args.stockReplacementId },
    });
    if (!existing) throw new ValidationError("error.stock_replacement_not_found");
    if (existing.status !== StockReplacementStatus.AWAITING_STOCK) {
      throw new ValidationError("error.stock_replacement_not_awaiting_stock", {
        status: existing.status,
      });
    }

    const item = await loadUnit(tx, existing.orderItemId);
    const issued = await issueReplacementCredential(tx, item);
    if (!issued) return { replacement: existing, replacementStockItem: null };

    const replacement = await claimStockReplacementStatus(tx, {
      stockReplacementId: existing.id,
      from: StockReplacementStatus.AWAITING_STOCK,
      to: StockReplacementStatus.COMPLETED,
      data: { replacementStockItemId: issued.id },
    });

    const { index, total } = await unitPosition(tx, item.order.id, item.id);
    await logAdminAction(tx, {
      adminId: args.executedBy,
      action: "stock_replacement_completed",
      targetType: "stock_replacement",
      targetId: replacement.id,
      details: `Handed over the replacement account ${index} of ${total} on order ${item.order.orderCode}, now that ${item.product.name} is back in stock. It has been sent to the buyer, who had been waiting since the complaint was recorded.`,
    });

    return { replacement, replacementStockItem: issued };
  };

  const ownsTransaction = "$transaction" in db && typeof db.$transaction === "function";
  const outcome = ownsTransaction ? await db.$transaction(run) : await run(db);

  if (outcome.replacementStockItem) {
    logger.info(
      { stockReplacementId: outcome.replacement.id, orderItemId: outcome.replacement.orderItemId },
      `Cleared stock replacement ${outcome.replacement.id} from AWAITING_STOCK: a restocked credential has been sold against the original order and queued for sending, so the buyer is no longer holding a dead account for that unit.`,
    );
  }
  return outcome;
}

/**
 * Give the buyer their money back for this one unit instead of replacing it —
 * the admin's explicit decision to stop waiting for a restock.
 *
 * Only a request at AWAITING_STOCK may take this branch. A REQUESTED one has
 * not tried to allocate yet (and cannot persist in that state anyway — the
 * opener resolves it in the same transaction), and a terminal one is already
 * settled; refusing both is what makes double-paying a unit impossible.
 *
 * ## One Refund row per refunded unit
 *
 * This always opens a NEW `Refund`, quoted at exactly this unit's refundable
 * amount, rather than attaching to an existing open Refund on the order. The
 * Refund domain is built for that: `createRefundItem`'s own doc comment reads
 * every sibling RefundItem "across ALL Refunds, not just the current one"
 * precisely because "a partial refund history can span more than one Refund
 * request over time (e.g. buy 3, one turns out dead now and another later)",
 * and `refundableAmountForOrder` sums executions across every Refund on the
 * order. Both ceilings are cross-Refund by construction, so a second unit's own
 * Refund cannot over-refund the item or the order.
 *
 * Reuse would also not work even where it looks tempting: the previous unit's
 * Refund is COMPLETED by the time this returns (executeRefund closes it), and
 * `createRefundItem` refuses to attach an item to a terminal Refund. The only
 * row reuse could ever find is a PENDING/PROCESSING Refund somebody opened for
 * a different decision — and commandeering that would pay out and close a
 * request quoted for a different amount.
 *
 * ## The payout
 *
 * Defaults to WALLET, and that is the method this flow is shaped around:
 * MANUAL_TRANSFER requires a `proofFileId` for a transfer that has already left
 * the bank, which a service function cannot invent, while a wallet credit is
 * instant — and by the time a complaint has waited out a restock the buyer has
 * been owed something for a while. `adjustWallet` is called by `executeRefund`
 * with no `orderId`, which is what lets several units of ONE order each be
 * refunded without colliding on `wallet_transactions`' UNIQUE (orderId,
 * reason) — see `executeRefund`'s own doc comment. MANUAL_TRANSFER stays
 * available for a shop that pays back out of band; its proof requirement is
 * enforced by `executeRefund` and deliberately not duplicated here.
 */
export async function refundInsteadOfReplace(
  db: Db,
  args: {
    stockReplacementId: number;
    /** The admin making the call. A payout is always attributable. */
    executedBy: number;
    /** `RefundExecutionMethod` (@app/core/enums). Defaults to WALLET. */
    method?: string;
    /** An identifier for the payout outside this system. */
    reference?: string | null;
    /** Required by `executeRefund` for MANUAL_TRANSFER. Never logged. */
    proofFileId?: string | null;
    notes?: string | null;
  },
): Promise<RefundInsteadOutcome> {
  const method = args.method ?? RefundExecutionMethod.WALLET;

  const run = async (tx: Db): Promise<RefundInsteadOutcome & { orderCode: string }> => {
    // Locked before the status is read: the payout below happens before the
    // status claim (money first, records second — `executeRefund`'s own order),
    // so without this lock two concurrent callers could each pay the buyer
    // before either claimed the row.
    await tx.$queryRaw`SELECT id FROM stock_replacements WHERE id = ${args.stockReplacementId} FOR UPDATE`;
    const existing = await tx.stockReplacement.findUnique({
      where: { id: args.stockReplacementId },
    });
    if (!existing) throw new ValidationError("error.stock_replacement_not_found");
    if (existing.status !== StockReplacementStatus.AWAITING_STOCK) {
      throw new ValidationError("error.stock_replacement_not_awaiting_stock", {
        status: existing.status,
      });
    }

    const item = await loadUnit(tx, existing.orderItemId);
    const amount = refundableAmountForUnit(item.order, item);
    if (!amount.greaterThan(0)) {
      throw new ValidationError("error.stock_replacement_nothing_to_refund", {
        orderCode: item.order.orderCode,
      });
    }

    const refund = await createRefund(tx, {
      orderId: item.order.id,
      amount,
      currency: item.order.currency,
      reason: `Replacement unavailable for a bad ${item.product.name} — refunded instead. Buyer reported: ${existing.reason}`,
      adminId: args.executedBy,
    });
    await createRefundItem(tx, {
      refundId: refund.id,
      orderItemId: item.id,
      amount,
      reason: `Stock replacement #${existing.id}: no ${item.product.name} available to replace the bad account with.`,
      adminId: args.executedBy,
    });
    // `executeRefund` pays only a PROCESSING refund — it pays a refund, it does
    // not decide whether to. The decision was made by whoever called this
    // function, so the review step is walked here rather than left to a caller
    // that would have no other reason to know about it.
    await transitionRefundStatus(tx, {
      refundId: refund.id,
      from: RefundStatus.PENDING,
      to: RefundStatus.PROCESSING,
      adminId: args.executedBy,
      meta: `refunding one unit of order ${item.order.orderCode} instead of replacing it (stock replacement #${existing.id})`,
    });
    const execution = await executeRefund(tx, {
      refundId: refund.id,
      method,
      amount,
      reference: args.reference ?? null,
      proofFileId: args.proofFileId ?? null,
      executedBy: args.executedBy,
      notes: args.notes ?? null,
    });

    const replacement = await claimStockReplacementStatus(tx, {
      stockReplacementId: existing.id,
      from: StockReplacementStatus.AWAITING_STOCK,
      to: StockReplacementStatus.REFUNDED_INSTEAD,
      data: { refundId: refund.id },
    });

    const { index, total } = await unitPosition(tx, item.order.id, item.id);
    await logAdminAction(tx, {
      adminId: args.executedBy,
      action: "stock_replacement_refunded_instead",
      targetType: "stock_replacement",
      targetId: replacement.id,
      details: `Refunded ${amount.toString()} ${item.order.currency} for account ${index} of ${total} on order ${item.order.orderCode} instead of replacing it — no ${item.product.name} came back in stock. The rest of the order is unaffected.`,
    });

    return { replacement, refund, execution, orderCode: item.order.orderCode };
  };

  const ownsTransaction = "$transaction" in db && typeof db.$transaction === "function";
  const { orderCode, ...outcome } = ownsTransaction ? await db.$transaction(run) : await run(db);

  // After the commit, for the same reason `executeRefund` logs its own payout
  // after the commit: a line saying a buyer was paid must not survive a
  // transaction that rolled the payment back.
  logger.info(
    { stockReplacementId: outcome.replacement.id, refundId: outcome.refund.id },
    `Refunded ${outcome.execution.amount.toString()} ${outcome.execution.currency} for one unit of order ${orderCode} by ${outcome.execution.method} instead of replacing a bad account, because the denomination never came back in stock. Stock replacement ${outcome.replacement.id} is closed as REFUNDED_INSTEAD by admin ${args.executedBy}; the rest of the order stands.`,
  );

  return outcome;
}
