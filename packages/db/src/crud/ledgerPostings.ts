/**
 * Ledger posting map (Financial Ledger M3) — the one place that decides WHICH
 * chart-of-accounts rows each real money event in this shop touches, and in
 * which direction.
 *
 * `crud/ledger.ts` owns HOW a posting is written (balanced, idempotent,
 * append-only) and is the ledger's only writer. This file owns WHAT to write:
 * for an order payment, a wallet top-up, a manual adjustment, a referral
 * commission and the three ways money flows back toward a customer, it turns the
 * event into a list of debit/credit legs and hands them to
 * `postFinancialTransaction`. Nothing here writes a ledger row itself.
 *
 * Why one module rather than a helper inside each caller: three of these events
 * are raised from more than one place (an order payment settles through both
 * `approveOrder` and `settlePaidOrder`'s manual branch; a manual adjustment is
 * raised from `wallet_topup.ts`, from web-admin's users route and from the bot's
 * `/wallet` command), and two of those call sites live outside `packages/db`
 * entirely. A copy of the account mapping per call site is a copy of the
 * accounting rules, and the copies would drift — a debit/credit direction that
 * is right in one file and backwards in another is exactly the bug a ledger
 * exists to make impossible. It also keeps ad-hoc ledger logic out of route and
 * handler files, per CLAUDE.md.
 *
 * Three conventions hold throughout, and each is load-bearing:
 *
 * 1. **Amounts and currencies come from the `WalletTransaction` row, never from
 *    the caller's intent.** Every wallet-derived posting here takes a
 *    `walletTransactionId` (returned by `adjustWallet` since M3) and reads that
 *    row's own `delta` and `currency`. `adjustWallet` records the amount it
 *    ACTUALLY applied, which is the figure a buyer's balance moved by and the
 *    figure M5's reconciliation must tie the ledger back to; the amount a caller
 *    asked for is not necessarily the same number, and `Order.walletUsed` has no
 *    currency of its own at all (see `reconcileFinances`' note in crud/reports.ts).
 * 2. **A posting never blocks the money movement it describes.** These functions
 *    are called after the buyer's balance or the order's state has already
 *    changed. Where a posting cannot be made meaningfully — no chargeable
 *    amount, a zero-value movement, a currency whose account does not exist, or a
 *    chart of accounts that was never seeded — they log and return `null` instead
 *    of throwing, because refusing to deliver a paid order over a bookkeeping gap
 *    is the worse of the two failures (see `postOrSkipMissingAccount`). What still
 *    throws is a genuine money error, above all `error.ledger_unbalanced`: that
 *    means this file built a wrong entry list, which is a bug to surface rather
 *    than an event to skip.
 * 3. **Idempotency keys are derived, never invented per call site**:
 *    `order:{orderId}:payment`, `order:{orderId}:topup`, and
 *    `wallet:{walletTransactionId}` for everything keyed off a wallet movement.
 *    A retried webhook or a double-tapped admin button re-derives the same key
 *    and `postFinancialTransaction` returns the first posting.
 *
 * Deliberately NOT here: the six payment-rail handlers' settlement/fee postings
 * and `Payment.providerTransactionId/fee/netAmount` (the next task), and any
 * reversal helper (`crud/ledger.ts`' doc comment explains why the milestone that
 * first needs one should own it). Every posting below is an independent
 * `FinancialTransaction` with its own entries, not a mirror of another one.
 */
import { FinancialTransactionType, LedgerDirection, OrderCurrency } from "@app/core/enums";
import { AppError } from "@app/core/errors";
import { quantizeMoney } from "@app/core/formatters";
import { logger } from "@app/core/logger";
import { Decimal, ZERO } from "@app/core/money";
import type { FinancialTransaction } from "@prisma/client";
import type { Db } from "./_types";
import {
  postFinancialTransaction,
  type LedgerEntryInput,
  type PostFinancialTransactionArgs,
} from "./ledger";

const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);

/**
 * Post one event, or — if the account it names does not exist — log loudly and
 * skip it. Every posting in this file goes through here.
 *
 * `error.ledger_account_not_found` means one of exactly two things: the chart of
 * accounts was never seeded in this environment (`pnpm seed-chart-of-accounts`),
 * or this file names an account with a typo. Neither is fixable by failing the
 * caller, and failing the caller is expensive in a way that is easy to
 * underestimate: these postings sit inside order settlement, wallet top-up
 * crediting and admin wallet adjustments, so letting the error propagate means a
 * shop that deployed without running the seed would refuse to DELIVER PAID
 * ORDERS and refuse to credit top-ups whose money has already arrived. A missing
 * bookkeeping row is recoverable (seed the chart, post the backlog by hand); a
 * buyer who paid and got nothing is not.
 *
 * So this is convention #2 above applied to the one failure mode that is an
 * operator or deploy omission rather than a money error. Everything else
 * `postFinancialTransaction` raises still propagates — above all
 * `error.ledger_unbalanced`, which means THIS file built a wrong entry list, and
 * a wrong entry list is a bug to surface rather than an event to skip.
 *
 * Swallowing it is safe with respect to a caller's transaction, which is not
 * obvious and is the reason this can be a `catch` at all: `prepareEntries`
 * resolves account codes with a SELECT and throws BEFORE the first INSERT, so
 * nothing has been written and no Postgres transaction has been aborted. The
 * caller's `tx` is still healthy and its own remaining writes still commit.
 */
async function postOrSkipMissingAccount(
  db: Db,
  args: PostFinancialTransactionArgs,
  context: string,
): Promise<FinancialTransaction | null> {
  try {
    return await postFinancialTransaction(db, args);
  } catch (e) {
    if (e instanceof AppError && e.key === "error.ledger_account_not_found") {
      logger.error(
        { err: e, idempotencyKey: args.idempotencyKey },
        `Recorded no ledger posting for ${context} because the ledger account it needs does not exist in this database. The money itself moved and is correct; only the double-entry record is missing, so the financial reports will understate this event until it is posted by hand. This almost always means the chart of accounts was never seeded here — run "pnpm seed-chart-of-accounts" and post the missing entries for anything that settled in the meantime.`,
      );
      return null;
    }
    throw e;
  }
}

/** The chart-of-accounts suffix for a currency: "IDR" → "idr". */
const suffix = (currency: string): string => currency.toLowerCase();

/**
 * The two idempotency-key shapes every posting below derives (the third,
 * `order:{id}:topup`, is used once and spelled out at its call site). Kept as
 * functions rather than written out per posting so the key an order-payment
 * posting WRITES and the key `hasPostedOrderPayment` LOOKS UP can never drift
 * apart — that lookup is the whole conditional-posting rule.
 */
const orderPaymentKey = (orderId: number): string => `order:${orderId}:payment`;
const walletKey = (walletTransactionId: number): string => `wallet:${walletTransactionId}`;

/** The subset of an order every posting here needs. Deliberately structural. */
export interface PostableOrder {
  id: number;
  orderCode: string;
  currency: string;
  totalAmount: Decimal.Value;
}

/** One debit/credit pair moving `amount` of one currency between two accounts. */
function pair(
  debitCode: string,
  creditCode: string,
  amount: Decimal,
  currency: string,
): LedgerEntryInput[] {
  return [
    { accountCode: debitCode, direction: LedgerDirection.DEBIT, amount, currency },
    { accountCode: creditCode, direction: LedgerDirection.CREDIT, amount, currency },
  ];
}

/**
 * Has an `ORDER_PAYMENT` already been posted for this order?
 *
 * This one lookup is what makes the three "money flows back toward the
 * customer" postings below correct, and it replaces guessing the answer from
 * which code path is running. The same wallet credit means two different things
 * depending on it:
 *
 * - **A posting exists** → revenue was already recognised for this order at
 *   settle time, so crediting the buyer now REVERSES part of that revenue
 *   (`Dr sales_revenue`).
 * - **No posting exists** → the order never reached a settled state, so nothing
 *   was ever recognised. There is no revenue to reverse; what is happening is
 *   that cash which genuinely arrived is being recognised for the FIRST time, as
 *   wallet credit (`Dr provider_clearing`).
 *
 * Deriving it from the caller is what an earlier version of this work got wrong
 * in both directions. `creditOrderToBalance` can fire on a `PROCESSING` order
 * that `settlePaidOrder`'s manual branch already posted an `ORDER_PAYMENT` for,
 * and it can equally fire on a `PENDING_VERIFICATION`/`UNDERPAID` order that
 * never reached one (`computeOrderEligibility`'s `canCredit` covers all three
 * statuses) — so neither "always paid" nor "never paid" is true of any single
 * call site. Asking the ledger directly is exact, and it is a single indexed
 * lookup on `ix_financial_tx_idempotency_key`.
 */
async function hasPostedOrderPayment(db: Db, orderId: number): Promise<boolean> {
  const priorPayment = await db.financialTransaction.findUnique({
    where: { idempotencyKey: orderPaymentKey(orderId) },
    select: { id: true },
  });
  return priorPayment !== null;
}

/**
 * One applied wallet movement, read back from its own row.
 *
 * `amount` is the movement's MAGNITUDE (ledger entry amounts are always
 * positive; `direction` carries the sign) and `increasedBalance` says which way
 * the buyer's balance went, since that is what decides the debit/credit order of
 * an adjustment's legs.
 */
interface WalletMovement {
  amount: Decimal;
  currency: string;
  increasedBalance: boolean;
}

/**
 * Read one wallet movement, or return `null` when there is nothing to post.
 *
 * A zero `delta` is the "nothing to post" case rather than an error: entry
 * amounts must be strictly positive (`crud/ledger.ts`), and a movement that
 * applied nothing has no economic effect to record. It can genuinely happen —
 * the bot's `/wallet` command accepts a zero amount, and a credit can quantize
 * away — so it is handled here once instead of at each call site.
 */
async function readWalletMovement(
  db: Db,
  walletTransactionId: number,
  context: string,
): Promise<WalletMovement | null> {
  const movement = await db.walletTransaction.findUnique({
    where: { id: walletTransactionId },
    select: { delta: true, currency: true },
  });
  if (!movement) {
    // Only reachable if a caller passed an id from a different transaction that
    // has since rolled back, or a hand-written id. Worth a loud log rather than
    // a throw: the wallet movement this was meant to describe does not exist, so
    // there is no money event to record either.
    logger.error(
      `Posted nothing to the ledger for ${context} because wallet movement ${walletTransactionId} could not be found — the ledger will not reflect this balance change, so it needs to be posted by hand if the balance really did move`,
    );
    return null;
  }
  const delta = q4(new Decimal(movement.delta));
  if (delta.isZero()) {
    logger.info(
      `Posted nothing to the ledger for ${context} because the wallet movement applied an amount of zero — no money changed hands, so there is no financial event to record`,
    );
    return null;
  }
  return {
    amount: delta.abs(),
    currency: movement.currency,
    increasedBalance: delta.greaterThan(0),
  };
}

/**
 * An order's payment, at the moment it settles: the shop has earned the order's
 * value, and the buyer has paid it through some combination of a payment gateway
 * and their own wallet balance.
 *
 * Two legs, either of which can be absent:
 *
 * - **Gateway leg** (`order.totalAmount` > 0): `Dr provider_clearing.<ccy> /
 *   Cr sales_revenue.<ccy>`. `totalAmount` is what the buyer owed EXTERNALLY —
 *   it is already net of any `walletUsed` — and it sits in `provider_clearing`
 *   rather than `cash` because the gateway has collected it but not yet paid it
 *   out to the shop (see `CHART_OF_ACCOUNTS`' doc comment).
 * - **Wallet leg(s)**: `Dr wallet_liability.<ccy> / Cr sales_revenue.<ccy>` for
 *   the credit the buyer spent at checkout. Spending credit discharges the
 *   shop's obligation to the buyer, which is a DEBIT to a credit-normal
 *   liability, and earns the same revenue as cash would.
 *
 * The wallet leg is read from the `order_payment` `WalletTransaction` rows and
 * grouped BY THEIR OWN CURRENCY, not from `Order.walletUsed`: that column is a
 * bare number whose currency depends on which checkout path spent it (IDR on an
 * IDR order, USDT on a USDT order, and nothing structurally prevents a future
 * caller from doing both), while the ledger rows each carry a currency. Each
 * currency group becomes its own balanced pair — `postFinancialTransaction`
 * balances per currency and never sums across them, so a mixed-currency order
 * posts correctly as one event.
 *
 * A genuinely free order (no external total, no wallet spend) posts nothing and
 * returns `null`: there is no amount to record, and calling the posting service
 * with an empty entry list is rejected by design.
 */
export async function postOrderPaymentPosting(
  db: Db,
  order: PostableOrder,
  occurredAt: Date,
): Promise<FinancialTransaction | null> {
  const entries: LedgerEntryInput[] = [];
  const described: string[] = [];

  const gatewayAmount = q4(new Decimal(order.totalAmount));
  if (gatewayAmount.greaterThan(0)) {
    entries.push(
      ...pair(
        `provider_clearing.${suffix(order.currency)}`,
        `sales_revenue.${suffix(order.currency)}`,
        gatewayAmount,
        order.currency,
      ),
    );
    described.push(`${gatewayAmount.toString()} ${order.currency} collected by the payment gateway`);
  }

  const walletLegs = await db.walletTransaction.findMany({
    where: { reason: "order_payment", orderId: order.id },
    select: { currency: true, delta: true },
  });
  // Grouped in insertion order so the posting's entries come out in a stable
  // order run to run, which makes two postings of the same event comparable.
  const spentByCurrency = new Map<string, Decimal>();
  for (const leg of walletLegs) {
    // Wallet debits are stored negative; the amount spent is their magnitude.
    const spent = new Decimal(leg.delta).negated();
    spentByCurrency.set(leg.currency, (spentByCurrency.get(leg.currency) ?? ZERO).plus(spent));
  }
  for (const [currency, total] of spentByCurrency) {
    const spent = q4(total);
    // A non-positive group means the rows for this currency net to a refund or
    // to nothing, which is not a payment and has no positive amount to post.
    if (!spent.greaterThan(0)) continue;
    entries.push(
      ...pair(
        `wallet_liability.${suffix(currency)}`,
        `sales_revenue.${suffix(currency)}`,
        spent,
        currency,
      ),
    );
    described.push(`${spent.toString()} ${currency} spent from the buyer's wallet balance`);
  }

  if (entries.length === 0) {
    logger.warn(
      `Recorded no ledger posting for order ${order.orderCode} because it had no chargeable amount at all — neither an external total nor any wallet credit spent on it — so there is no revenue to recognise. Delivery is unaffected, but an order that cost the buyer nothing is worth understanding: it usually means a pricing or voucher rule reduced the whole order to zero.`,
    );
    return null;
  }

  return postOrSkipMissingAccount(
    db,
    {
      type: FinancialTransactionType.ORDER_PAYMENT,
      referenceType: "order",
      referenceId: order.id,
      idempotencyKey: orderPaymentKey(order.id),
      description: `Recognised revenue for order ${order.orderCode}, paid as ${described.join(" and ")}.`,
      occurredAt,
      entries,
    },
    `the payment of order ${order.orderCode}`,
  );
}

/**
 * A wallet top-up settling: the buyer has paid a gateway in order to hold
 * spendable credit, and the shop now owes them that credit.
 *
 * `Dr provider_clearing.<ccy> / Cr wallet_liability.<ccy>`. No revenue is
 * involved — a top-up sells nothing, it converts the buyer's cash into an
 * obligation, and revenue is recognised later when they spend that credit on an
 * order (the wallet leg of `postOrderPaymentPosting`). Booking a top-up as
 * revenue is the double-count that M6's dashboard work exists to undo.
 *
 * The amount is the order's own `totalAmount`, which is the figure
 * `settleWalletTopup` credits and the figure `createWalletTopupOrder` validated
 * — deliberately not the amount a rail reported (`settleWalletTopup` logs that
 * discrepancy and credits the order's total anyway, so the ledger must agree
 * with the credit, not with the report).
 */
export async function postWalletTopupPosting(
  db: Db,
  order: PostableOrder,
  occurredAt: Date,
): Promise<FinancialTransaction | null> {
  const amount = q4(new Decimal(order.totalAmount));
  if (!amount.greaterThan(0)) {
    logger.warn(
      `Recorded no ledger posting for wallet top-up order ${order.orderCode} because its total is zero or negative, so no money arrived to recognise. The buyer's balance was still credited by that same amount, which means nothing moved; a top-up order with no value should not have been creatable, so this is worth investigating in whichever rail produced it.`,
    );
    return null;
  }

  return postOrSkipMissingAccount(
    db,
    {
      type: FinancialTransactionType.WALLET_DEPOSIT,
      referenceType: "order",
      referenceId: order.id,
      idempotencyKey: `order:${order.id}:topup`,
      description: `Recognised a wallet top-up of ${amount.toString()} ${order.currency} for order ${order.orderCode} as credit the shop now owes the buyer.`,
      occurredAt,
      entries: pair(
        `provider_clearing.${suffix(order.currency)}`,
        `wallet_liability.${suffix(order.currency)}`,
        amount,
        order.currency,
      ),
    },
    `the wallet top-up of order ${order.orderCode}`,
  );
}

/**
 * An admin moving a buyer's balance by hand (`admin_adjust`) — a goodwill
 * credit, a correction, a manual debit.
 *
 * There is no customer payment behind this and no sale, so the counter-account
 * is `adjustment.<ccy>` (EQUITY): the shop is deciding to owe the buyer more, or
 * less, out of its own equity. Direction follows the movement:
 *
 * - **Credit to the buyer** (`delta > 0`): `Dr adjustment / Cr wallet_liability`
 *   — the obligation grows.
 * - **Debit from the buyer** (`delta < 0`): `Dr wallet_liability / Cr adjustment`
 *   — the obligation shrinks.
 *
 * `referenceId` is the acting admin's id, with `referenceType: "manual"`: a
 * hand-made adjustment's most useful back-pointer is the person who made it, and
 * every call site has one. The order id some call sites also pass to
 * `adjustWallet` is not used here — the movement is not an order's payment, and
 * pointing the posting at the order would make it look like one.
 */
export async function postWalletAdjustmentPosting(
  db: Db,
  args: { walletTransactionId: number; adminId: number; occurredAt: Date },
): Promise<FinancialTransaction | null> {
  const movement = await readWalletMovement(
    db,
    args.walletTransactionId,
    `a manual wallet adjustment by admin ${args.adminId}`,
  );
  if (!movement) return null;

  const wallet = `wallet_liability.${suffix(movement.currency)}`;
  const adjustment = `adjustment.${suffix(movement.currency)}`;
  const direction = movement.increasedBalance
    ? `credited ${movement.amount.toString()} ${movement.currency} to`
    : `debited ${movement.amount.toString()} ${movement.currency} from`;

  return postOrSkipMissingAccount(
    db,
    {
      type: FinancialTransactionType.ADJUSTMENT,
      referenceType: "manual",
      referenceId: args.adminId,
      idempotencyKey: walletKey(args.walletTransactionId),
      description: `Admin ${args.adminId} ${direction} a buyer's wallet balance by hand.`,
      occurredAt: args.occurredAt,
      entries: movement.increasedBalance
        ? pair(adjustment, wallet, movement.amount, movement.currency)
        : pair(wallet, adjustment, movement.amount, movement.currency),
    },
    `a manual wallet adjustment by admin ${args.adminId}`,
  );
}

/**
 * A referral commission paid into the referrer's wallet.
 *
 * `Dr referral_expense.usdt / Cr wallet_liability.usdt` — the commission is a
 * cost of acquiring the referred buyer (the same shape as a payment-gateway
 * fee), and the credit itself is a new obligation to the referrer. See
 * `CHART_OF_ACCOUNTS`' doc comment for why this is an EXPENSE and not a second
 * liability alongside the wallet credit.
 *
 * USDT only, because `maybePayReferralCommission` pays commission only into the
 * USDT balance and skips the commission entirely when an IDR order cannot be
 * converted. A movement in any other currency is therefore impossible today; if
 * one ever appears it is logged and skipped rather than posted, because there is
 * no `referral_expense` account in another currency to post it to and throwing
 * here would roll back the delivery that earned the commission.
 */
export async function postReferralCommissionPosting(
  db: Db,
  args: { walletTransactionId: number; orderId: number; orderCode: string; occurredAt: Date },
): Promise<FinancialTransaction | null> {
  const movement = await readWalletMovement(
    db,
    args.walletTransactionId,
    `a referral commission on order ${args.orderCode}`,
  );
  if (!movement) return null;

  if (movement.currency !== OrderCurrency.USDT) {
    logger.error(
      `Recorded no ledger posting for the referral commission on order ${args.orderCode} because it was paid in ${movement.currency} rather than USDT, and the shop's chart of accounts has a referral commission expense account in USDT only. The referrer was still paid, so this commission is missing from the books and needs a manual entry. Referral commission is meant to be USDT-only, so whichever code path paid it in another currency is the real bug.`,
    );
    return null;
  }

  return postOrSkipMissingAccount(
    db,
    {
      type: FinancialTransactionType.ADJUSTMENT,
      referenceType: "order",
      referenceId: args.orderId,
      idempotencyKey: walletKey(args.walletTransactionId),
      description: `Recorded a referral commission of ${movement.amount.toString()} ${movement.currency} paid to the referrer for order ${args.orderCode}.`,
      occurredAt: args.occurredAt,
      entries: pair(
        "referral_expense.usdt",
        "wallet_liability.usdt",
        movement.amount,
        movement.currency,
      ),
    },
    `the referral commission on order ${args.orderCode}`,
  );
}

/**
 * Money the buyer really sent, turned into wallet credit instead of into a
 * delivered order: `unfulfilled_credit` (`creditOrderToBalance` — an order the
 * shop cannot fulfil) and `underpaid_refund` (`refundUnderpaidOrder` — a crypto
 * deposit that fell short of the order's price).
 *
 * Both are external cash becoming an obligation to the buyer, and which account
 * that cash comes OUT of depends on whether the order's revenue was ever
 * recognised (see `hasPostedOrderPayment`):
 *
 * - **An `ORDER_PAYMENT` exists** → `Dr sales_revenue.<ccy> / Cr
 *   wallet_liability.<ccy>`. Revenue was recognised at settle time for a sale
 *   that is now not happening, so the credit reverses that revenue for the
 *   portion being handed back. Reached when `creditOrderToBalance` runs on a
 *   `PROCESSING` order.
 * - **No `ORDER_PAYMENT` exists** → `Dr provider_clearing.<ccy> / Cr
 *   wallet_liability.<ccy>`. The order never settled, so no revenue was ever
 *   recognised and there is nothing to reverse; this is the first time the cash
 *   is recognised at all. Economically identical to a wallet top-up, because
 *   that is what it has become. The common case for both reasons: an UNDERPAID
 *   order never has `paidAt` set, and `canCredit` also covers
 *   `PENDING_VERIFICATION`.
 *
 * Debiting `sales_revenue` in the second case would book NEGATIVE revenue that
 * was never earned and would leave the cash that genuinely arrived unrecorded on
 * the asset side — the trial balance would still balance, and the books would
 * still be wrong.
 */
export async function postOrderWalletCreditPosting(
  db: Db,
  args: { walletTransactionId: number; orderId: number; orderCode: string; occurredAt: Date },
): Promise<FinancialTransaction | null> {
  const movement = await readWalletMovement(
    db,
    args.walletTransactionId,
    `credit given to the buyer for order ${args.orderCode}`,
  );
  if (!movement) return null;

  const revenueWasRecognised = await hasPostedOrderPayment(db, args.orderId);
  const wallet = `wallet_liability.${suffix(movement.currency)}`;
  const source = revenueWasRecognised
    ? `sales_revenue.${suffix(movement.currency)}`
    : `provider_clearing.${suffix(movement.currency)}`;
  const explanation = revenueWasRecognised
    ? `reversing the revenue recognised for it`
    : `recognising the payment that arrived for it`;

  return postOrSkipMissingAccount(
    db,
    {
      type: FinancialTransactionType.REFUND,
      referenceType: "order",
      referenceId: args.orderId,
      idempotencyKey: walletKey(args.walletTransactionId),
      description: `Converted ${movement.amount.toString()} ${movement.currency} from order ${args.orderCode} into wallet credit for the buyer, ${explanation}.`,
      occurredAt: args.occurredAt,
      entries: pair(source, wallet, movement.amount, movement.currency),
    },
    `credit given to the buyer for order ${args.orderCode}`,
  );
}

/**
 * The wallet HOLD placed at checkout being released (`order_refund`, from
 * `releaseOrderHolds`) — the buyer's own credit, spent on an order that is now
 * being cancelled, rejected or credited back.
 *
 * Unlike every other posting here, this one is **conditional on whether to post
 * at all**, because the release means two different things:
 *
 * - **No `ORDER_PAYMENT` exists** (the ordinary `rejectOrder`/`cancelOrder`
 *   case) → **post nothing.** The checkout-time wallet debit was never posted to
 *   the ledger either: this ledger recognises nothing until an order settles, by
 *   design. Releasing the hold is a purely internal reversal of something the
 *   books never recorded, so there is no event here — and inventing one would
 *   credit `wallet_liability` for an obligation the ledger never discharged,
 *   leaving `wallet_liability` permanently above the sum of real wallet balances.
 * - **An `ORDER_PAYMENT` exists** (`creditOrderToBalance` on an order already
 *   `PROCESSING`, whose manual-branch settlement posted one) → `Dr
 *   sales_revenue.<ccy> / Cr wallet_liability.<ccy>`. Here the wallet spend WAS
 *   recognised as revenue, by that posting's wallet leg, so returning it has to
 *   reverse that revenue. Omitting this posting is what would leave
 *   `sales_revenue` permanently overstated by the wallet-paid portion of every
 *   credited order — balanced books, wrong numbers.
 *
 * Note the amount comes from the movement row, so it is the credit actually
 * returned rather than `Order.walletUsed`, and its currency is the one the
 * wallet really moved in.
 */
export async function postOrderHoldReleasePosting(
  db: Db,
  args: { walletTransactionId: number; orderId: number; orderCode: string; occurredAt: Date },
): Promise<FinancialTransaction | null> {
  const revenueWasRecognised = await hasPostedOrderPayment(db, args.orderId);
  if (!revenueWasRecognised) return null;

  const movement = await readWalletMovement(
    db,
    args.walletTransactionId,
    `the wallet hold released on order ${args.orderCode}`,
  );
  if (!movement) return null;

  return postOrSkipMissingAccount(
    db,
    {
      type: FinancialTransactionType.REFUND,
      referenceType: "order",
      referenceId: args.orderId,
      idempotencyKey: walletKey(args.walletTransactionId),
      description: `Returned ${movement.amount.toString()} ${movement.currency} of wallet credit spent on order ${args.orderCode}, reversing the revenue recognised for it.`,
      occurredAt: args.occurredAt,
      entries: pair(
        `sales_revenue.${suffix(movement.currency)}`,
        `wallet_liability.${suffix(movement.currency)}`,
        movement.amount,
        movement.currency,
      ),
    },
    `the wallet hold released on order ${args.orderCode}`,
  );
}
