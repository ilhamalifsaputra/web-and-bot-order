/**
 * Ledger posting map (Financial Ledger M3) — the one place that decides WHICH
 * chart-of-accounts rows each real money event in this shop touches, and in
 * which direction.
 *
 * `crud/ledger.ts` owns HOW a posting is written (balanced, idempotent,
 * append-only) and is the ledger's only writer. This file owns WHAT to write:
 * for an order payment, a wallet top-up (settled in full, or credited short when
 * the money arrived short), a provider settlement batch, a manual adjustment, a
 * referral commission and the four ways money flows back toward a customer, it
 * turns the event into a list of debit/credit legs and hands them to
 * `postFinancialTransaction`. Nothing here writes a ledger row itself.
 *
 * Why one module rather than a helper inside each caller: three of these events
 * are raised from more than one place (an order payment settles through both
 * `approveOrder` and `settlePaidOrder`'s manual branch; a manual adjustment is
 * raised from web-admin's users route and from the bot's `/wallet` command), and
 * two of those call sites live outside `packages/db` entirely. A copy of the account mapping per call site is a copy of the
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
 *    `order:{orderId}:payment`, `order:{orderId}:topup`, `settlement:{settlementId}`,
 *    and `wallet:{walletTransactionId}` for everything keyed off a wallet movement.
 *    A retried webhook or a double-tapped admin button re-derives the same key
 *    and `postFinancialTransaction` returns the first posting.
 *
 * Deliberately NOT here: a per-payment FEE posting for any rail.
 * `Payment.providerTransactionId` is wired (each rail handler stamps its own
 * gateway transaction id), but `Payment.fee` stays null — none of this shop's six
 * gateways reports a real per-transaction fee figure, so there is no fee amount to
 * post at payment time and never has been; this is not a follow-up task, it is the
 * correct state for as long as that stays true. A provider's fee IS booked where a
 * real figure exists, which is a settlement batch an admin entered off the
 * provider's own statement (`postSettlementPosting`) — that is the fee leg of a
 * SETTLEMENT, not a FEE transaction, and the distinction is the difference between
 * a reported amount and an estimated one.
 * Reversals are absent from this file too, but they do EXIST:
 * `reverseFinancialTransaction` (crud/ledger.ts) mirrors a posting's own entries,
 * so it needs no account map of its own and belongs with the writer rather than
 * here. Every posting below is an independent `FinancialTransaction` with its own
 * entries, not a mirror of another one.
 */
import {
  FinancialTransactionType,
  LedgerDirection,
  OrderCurrency,
  RefundExecutionMethod,
} from "@app/core/enums";
import { AppError, ValidationError } from "@app/core/errors";
import { quantizeMoney } from "@app/core/formatters";
import { logger } from "@app/core/logger";
import { Decimal, ZERO } from "@app/core/money";
import type { FinancialTransaction } from "@prisma/client";
import type { Db } from "./_types";
import { findUnderpaidReceived } from "./_underpaid";
import {
  postFinancialTransaction,
  type LedgerEntryInput,
  type PostFinancialTransactionArgs,
} from "./ledger";

const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);

/**
 * How an operator is actually meant to fix a posting that is missing or wrong,
 * spelled once and appended to every log line below that reports one.
 *
 * These lines used to end in "needs a manual entry"/"needs to be posted by hand",
 * which named no mechanism that exists: `postFinancialTransaction` is the ledger's
 * only writer and raw SQL against its two tables is forbidden (crud/ledger.ts's
 * module comment), so the advice amounted to "edit the books", which is what the
 * whole design prevents. The two real mechanisms are the backfill script (for an
 * event that was never posted) and `reverseFinancialTransaction` (for one that was
 * posted wrongly), and every line here now says which applies.
 */
const NOT_BY_HAND =
  "do not add rows to \"financial_transactions\"/\"ledger_entries\" by hand. A posting that WAS made and is wrong is the other case, and reverseFinancialTransaction (crud/ledger.ts) is what cancels it before the corrected event is posted.";

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
 * bookkeeping row is recoverable (seed the chart, then re-post the backlog with
 * `pnpm backfill-ledger-history`); a buyer who paid and got nothing is not.
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
        `Recorded no ledger posting for ${context} because the ledger account it needs does not exist in this database. The money itself moved and is correct; only the double-entry record is missing, so the financial reports will understate this event until it is posted. This almost always means the chart of accounts was never seeded here — run "pnpm seed-chart-of-accounts", then "pnpm backfill-ledger-history" to post everything that settled in the meantime. That script re-derives the same idempotency keys these functions do, so it posts exactly what is missing and nothing twice; ${NOT_BY_HAND}`,
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
/**
 * A refund payout's key is the EXECUTION's id, not the order's and not the
 * wallet movement's. One order can be refunded several times over its life (a
 * second bad unit found later, a bounced transfer retried), so an order-keyed
 * posting would swallow every refund after the first as a replay of it; and a
 * `MANUAL_TRANSFER` payout has no wallet movement to key off at all. The
 * `RefundExecution` row is the one thing that exists exactly once per payout
 * attempt, in both methods.
 */
const refundExecutionKey = (refundExecutionId: number): string =>
  `refund_execution:${refundExecutionId}`;

/**
 * A provider payout batch's key: the `Settlement` row is the one thing that
 * exists exactly once per batch, and a batch is what actually moves money from
 * `provider_clearing` into `cash`. Deliberately NOT keyed on
 * `batchReference` — that column is admin-typed free text from an external
 * system and is explicitly not unique (see the model's own doc comment), so two
 * genuinely different batches can share one, and a provider reusing its own
 * statement id would silently swallow the second batch as a replay of the first.
 */
const settlementKey = (settlementId: number): string => `settlement:${settlementId}`;

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
 * This one lookup is what makes the "money flows back toward the customer"
 * postings below correct, and it replaces guessing the answer from which code
 * path is running. The same credit back to a buyer means two different things
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
      `Posted nothing to the ledger for ${context} because wallet movement ${walletTransactionId} could not be found — the ledger will not reflect this balance change. If the balance really did move, whichever path wrote it without a readable wallet_transactions row is the bug to fix first; the movement can then be posted by re-running "pnpm backfill-ledger-history", which covers every wallet-derived posting shape. ${NOT_BY_HAND}`,
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

/** How an order's external total splits between money that arrived and money the
 *  shop absorbed. `shortfall` is zero for every order but an underpaid one that
 *  was delivered anyway. */
interface UnderpaidSplit {
  received: Decimal;
  shortfall: Decimal;
}

/**
 * Split an order's external total into what a rail actually collected and what
 * the shop absorbed by delivering an UNDERPAID order anyway.
 *
 * `deliverUnderpaidOrder` (crud/binance_internal.ts) is the only path that
 * reaches here with a shortfall: it moves the order UNDERPAID →
 * PENDING_VERIFICATION and hands it to `approveOrder`, whose posting call is
 * this one. Nothing else can — `UNDERPAID`'s only non-terminal outgoing edge in
 * `LEGAL_TRANSITIONS` is that one (`crud/orderStatus.ts`), and every rail's
 * top-up-a-short-payment search matches PENDING orders only, so an order cannot
 * be flagged short and then quietly paid in full.
 *
 * Read from the rail's own shortfall row (`findUnderpaidReceived`) rather than
 * taken as an argument, and read HERE rather than at the call site, for the
 * reason this file exists: the split is part of the account mapping, and
 * `approveOrder`, `settlePaidOrder`'s manual branch and
 * `scripts/backfill-ledger-history.ts` all post through this function. A
 * `receivedAmount` parameter would have to be threaded through `approveOrder`'s
 * signature and re-derived by the backfill, which is two more places for the
 * figure to be computed differently.
 *
 * Both edges are deliberate:
 *
 * - **No row** (the overwhelming majority of orders) → the whole total arrived.
 *   The lookup is three indexed `findFirst`s on the shortfall tables, paid once
 *   per settled order, which is not a hot path.
 * - **A row recording AT OR ABOVE the total** → no shortfall. That is an
 *   overpayment or a stale row, and neither is a loss to book; `received` is
 *   clamped to the total so the posting can never claim the gateway collected
 *   more than the order asked for. A negative recorded amount is clamped to zero
 *   for the same reason, since a rail cannot have collected less than nothing.
 */
async function underpaidSplit(
  db: Db,
  order: PostableOrder,
  externalTotal: Decimal,
): Promise<UnderpaidSplit> {
  const recorded = await findUnderpaidReceived(db, order.id);
  if (recorded === null) return { received: externalTotal, shortfall: ZERO };
  const received = Decimal.min(Decimal.max(ZERO, q4(recorded)), externalTotal);
  return { received, shortfall: q4(externalTotal.minus(received)) };
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
 * - **Absorbed-shortfall leg**, on an UNDERPAID order an admin delivered anyway:
 *   the gateway leg is reduced to what actually ARRIVED and the difference is
 *   debited to `payment_shortfall.<ccy>` (EXPENSE), so the three legs read
 *   `Dr provider_clearing` (received) + `Dr payment_shortfall` (shortfall) /
 *   `Cr sales_revenue` (the full total). Revenue is deliberately unchanged —
 *   the shop earned the sale it chose to honour, and the shortfall is the cost
 *   of honouring it, not a discount on the price. Booking the full total as
 *   `provider_clearing` (as this function did before the whole-branch review's
 *   decision D2) claimed the gateway was holding money it never collected, which
 *   overstates the receivable by every shortfall ever waved through and leaves
 *   the loss nowhere. See `underpaidSplit` for which path can reach this and why
 *   nothing else can.
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
    // How much of the external total actually arrived, and what the shop ate.
    // Zero on every ordinary order — `underpaidSplit` only looks anything up
    // when a rail recorded a shortfall against this order.
    const { received, shortfall } = await underpaidSplit(db, order, gatewayAmount);
    const revenueAccount = `sales_revenue.${suffix(order.currency)}`;
    if (received.greaterThan(0)) {
      entries.push({
        accountCode: `provider_clearing.${suffix(order.currency)}`,
        direction: LedgerDirection.DEBIT,
        amount: received,
        currency: order.currency,
      });
      described.push(`${received.toString()} ${order.currency} collected by the payment gateway`);
    }
    if (shortfall.greaterThan(0)) {
      entries.push({
        accountCode: `payment_shortfall.${suffix(order.currency)}`,
        direction: LedgerDirection.DEBIT,
        amount: shortfall,
        currency: order.currency,
      });
      described.push(
        `${shortfall.toString()} ${order.currency} of shortfall absorbed by the shop, which delivered the order anyway`,
      );
    }
    // Revenue is the order's WHOLE total either way: the shop earned the sale it
    // chose to honour, and a shortfall is a cost of honouring it, not a discount.
    entries.push({
      accountCode: revenueAccount,
      direction: LedgerDirection.CREDIT,
      amount: gatewayAmount,
      currency: order.currency,
    });
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

/** The subset of a `Settlement` row this posting needs. Deliberately structural. */
export interface PostableSettlement {
  id: number;
  /** `PaymentMethod` value — named in the description so an admin recognises the batch. */
  provider: string;
  /** The provider's own statement/payout id, or null. Admin-typed free text. */
  batchReference?: string | null;
  currency: string;
  /** What the provider collected from buyers in this batch, before its cut. */
  grossAmount: Decimal.Value;
  /** The provider's total cut. Zero is a real answer here, not "unknown". */
  feeAmount: Decimal.Value;
  /** What actually landed in the shop's own account. */
  netAmount: Decimal.Value;
  /** When the provider settled the batch (UTC) — this posting's `occurredAt`. */
  settlementDate: Date;
}

/**
 * A provider paying out a batch: the money a gateway had collected from buyers
 * and owed the shop finally lands in the shop's own account, minus the
 * provider's cut.
 *
 * `Dr cash.<ccy>` (net) + `Dr payment_fee.<ccy>` (fee) / `Cr
 * provider_clearing.<ccy>` (gross). This is the posting that makes the two
 * accounts either side of it mean what their doc comments say they mean:
 * `provider_clearing.*` is a receivable that DRAINS when the provider pays, and
 * `cash.*` is money actually settled into the shop's own account. Without it,
 * every sale debits `provider_clearing` and nothing ever credits it, while
 * `cash.*` is only ever debited by a `MANUAL_TRANSFER` refund — so the account
 * named "Cash" goes monotonically NEGATIVE while the receivable grows without
 * bound. That is the misstatement decision D1 exists to close (see
 * `trialBalance`'s own doc comment in crud/ledger.ts).
 *
 * The fee leg is where `payment_fee.*` finally has a real amount to hold, and it
 * is a genuine one rather than the estimate `FEE` postings were rejected over
 * (see this file's module comment, and known gap 1 in docs/FINANCE_ARCHITECTURE.md):
 * `Settlement.feeAmount` is a figure an admin read off the provider's own
 * statement, not a locally computed guess. That is the whole difference, and it
 * is why the fee belongs on THIS posting and not on the order payment.
 *
 * ## Its caller (task F1), and what is still not automatic
 *
 * `recordSettlement` (crud/settlements.ts) is the one production caller: an admin
 * enters a provider's own payout statement through `POST /api/settlements`, and
 * that service writes the `Settlement` row, its `SettlementTransaction` lines,
 * this posting and the audit row in ONE transaction. Nothing else may create a
 * `Settlement` row — a row written past that service would be a batch with no
 * posting, and since the ledger is append-only nothing downstream would notice
 * the cash position it left understated.
 *
 * What remains manual is the ENTRY, not the accounting: no importer polls any
 * provider's payout API, so `provider_clearing.*` still over-reads and `cash.*`
 * still under-reads by exactly the batches nobody has typed in yet. That is an
 * operational gap (known gap 6 in docs/FINANCE_ARCHITECTURE.md), not a mapping
 * one. An importer added later calls this same function through
 * `recordSettlement` rather than posting directly, for the reason this whole file
 * exists.
 *
 * ## What it refuses
 *
 * `netAmount` is STORED rather than derived (the model says so on purpose, so a
 * provider's own arithmetic can be recorded verbatim), which means a row can
 * hold three figures that do not add up. This posting refuses that row instead
 * of posting it: net + fee != gross is not a bookkeeping preference, it is two
 * incompatible claims about one batch, and the only shapes available here are to
 * refuse it or to pick one figure to believe. `postFinancialTransaction` would
 * reject it anyway as `error.ledger_unbalanced`; refusing here names the three
 * amounts that disagree instead of reporting a debit total against a credit
 * total, which is what an admin fixing a typo needs to see.
 *
 * It THROWS for that, unlike the "log and skip" convention the rest of this file
 * follows, and the difference is exactly convention #2's boundary: those
 * functions run after a buyer's money has already moved, where refusing would
 * strand a paid order over a bookkeeping gap. A settlement batch is a record an
 * admin is entering right now, and the honest response to an inconsistent entry
 * is to reject the entry.
 *
 * A zero fee posts no fee leg and a zero net posts no cash leg (entry amounts
 * must be strictly positive), so a batch the provider swallowed entirely still
 * posts correctly as a one-sided-looking but balanced pair of legs. A gross of
 * zero has nothing to settle at all and is skipped with a log.
 *
 * `occurredAt` is the batch's own `settlementDate`, never now: financial
 * reporting for a period reads `occurredAt`, and an admin entering last week's
 * statement today must not move that money into this week.
 */
export async function postSettlementPosting(
  db: Db,
  settlement: PostableSettlement,
): Promise<FinancialTransaction | null> {
  const batch = settlement.batchReference?.trim()
    ? `${settlement.provider} batch ${settlement.batchReference.trim()}`
    : `${settlement.provider} settlement #${settlement.id}`;
  const context = `the ${batch}`;

  const gross = q4(new Decimal(settlement.grossAmount));
  const fee = q4(new Decimal(settlement.feeAmount));
  const net = q4(new Decimal(settlement.netAmount));

  if (!gross.greaterThan(0)) {
    logger.warn(
      `Recorded no ledger posting for ${context} because its gross amount is zero or negative, so there is no money in transit for it to settle. A settlement batch with no value should not have been recordable, so whichever path wrote it is worth investigating.`,
    );
    return null;
  }
  if (fee.isNegative() || net.isNegative()) {
    throw new ValidationError("error.settlement_amounts_invalid", {
      grossAmount: gross.toString(),
      feeAmount: fee.toString(),
      netAmount: net.toString(),
      currency: settlement.currency,
    });
  }
  if (!net.plus(fee).equals(gross)) {
    // Compared with Decimal.equals on values already quantized to this repo's 4
    // places by `q4` above, so this is `moneyEq` in effect and cannot fire on a
    // representation artefact in the 5th decimal.
    throw new ValidationError("error.settlement_amounts_inconsistent", {
      grossAmount: gross.toString(),
      feeAmount: fee.toString(),
      netAmount: net.toString(),
      currency: settlement.currency,
    });
  }

  const entries: LedgerEntryInput[] = [];
  const described: string[] = [];
  if (net.greaterThan(0)) {
    entries.push({
      accountCode: `cash.${suffix(settlement.currency)}`,
      direction: LedgerDirection.DEBIT,
      amount: net,
      currency: settlement.currency,
    });
    described.push(`${net.toString()} ${settlement.currency} landed in the shop's own account`);
  }
  if (fee.greaterThan(0)) {
    entries.push({
      accountCode: `payment_fee.${suffix(settlement.currency)}`,
      direction: LedgerDirection.DEBIT,
      amount: fee,
      currency: settlement.currency,
    });
    described.push(`${fee.toString()} ${settlement.currency} was the provider's cut`);
  }
  entries.push({
    accountCode: `provider_clearing.${suffix(settlement.currency)}`,
    direction: LedgerDirection.CREDIT,
    amount: gross,
    currency: settlement.currency,
  });

  return postOrSkipMissingAccount(
    db,
    {
      type: FinancialTransactionType.SETTLEMENT,
      referenceType: "settlement",
      referenceId: settlement.id,
      idempotencyKey: settlementKey(settlement.id),
      description: `Settled ${gross.toString()} ${settlement.currency} of ${settlement.provider} takings for ${batch}: ${described.join(", and ")}.`,
      occurredAt: settlement.settlementDate,
      entries,
    },
    context,
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
 * with the credit, not with the report). A top-up whose money arrived SHORT is
 * never settled through here at all — it is cancelled and the buyer is credited
 * what turned up, which is `postUnderpaidTopupCreditPosting` below.
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
 * A top-up whose money arrived SHORT, credited to the buyer anyway
 * (`creditUnderpaidTopupAnyway`): the rail collected less than the order asked
 * for, so the top-up is cancelled instead of settled and the buyer gets exactly
 * what turned up.
 *
 * `Dr provider_clearing.<ccy> / Cr wallet_liability.<ccy>` — the same pair as a
 * top-up that settled in full, for the same reason: cash a gateway has collected
 * became credit the shop owes the buyer. Only the amount differs, and it comes
 * from the movement row, so it is what `adjustWallet` actually applied rather than
 * the total the order asked for.
 *
 * This is deliberately NOT `postWalletAdjustmentPosting`, even though the wallet
 * movement underneath carries the same `admin_adjust` reason code as the two
 * genuinely hand-made adjustments (web-admin's users route, the bot's `/wallet`
 * command). Those two move a balance with no customer payment behind them at all,
 * which is what makes `adjustment.<ccy>` (EQUITY) right for them. Here money DID
 * arrive; the admin only decided what to do with it. Posting it against
 * `adjustment` would claim the shop funded this credit out of its own equity and
 * would leave the cash the rail really collected unrecorded on the asset side —
 * a trial balance that still balances, with `provider_clearing` understated by
 * every shortfall ever credited and equity consumed in its place. Economically
 * this is the same event as `postOrderWalletCreditPosting`'s no-prior-payment
 * branch (a rail reported less than expected, so the buyer is credited what came
 * in); only the KIND of order that triggered it differs, which is not an
 * accounting distinction. Sharing a `reason` string is not sharing economics.
 *
 * The transaction type stays `ADJUSTMENT`, matching that same `admin_adjust`
 * reason: this is an admin resolving a stuck top-up by hand. It is not a `REFUND`
 * (no delivery was undone — the whole point of this resolution is that a top-up
 * has nothing to refund) and not a `WALLET_DEPOSIT` (that is a top-up settling
 * for the full amount it asked for, and reporting this as one would overstate how
 * much money the rails actually delivered).
 *
 * `referenceType: "order"` points at the top-up whose gateway payment is being
 * recognised, rather than at the acting admin the way a hand-made adjustment
 * does: the `provider_clearing` debit is a claim that a rail collected this money
 * against THIS order, which is exactly what M5's reconciliation has to tie back
 * to. The admin is named in the description instead, and the `WalletTransaction`
 * row keeps `adminId` either way.
 *
 * The caller credits only a positive received amount, so the movement is always a
 * credit to the buyer; like every other one-directional posting here, the leg
 * order is fixed rather than derived from the movement's sign.
 */
export async function postUnderpaidTopupCreditPosting(
  db: Db,
  args: {
    walletTransactionId: number;
    orderId: number;
    orderCode: string;
    adminId: number;
    occurredAt: Date;
  },
): Promise<FinancialTransaction | null> {
  const context = `the shortfall credited for underpaid wallet top-up order ${args.orderCode}`;
  const movement = await readWalletMovement(db, args.walletTransactionId, context);
  if (!movement) return null;

  return postOrSkipMissingAccount(
    db,
    {
      type: FinancialTransactionType.ADJUSTMENT,
      referenceType: "order",
      referenceId: args.orderId,
      idempotencyKey: walletKey(args.walletTransactionId),
      description: `Credited ${movement.amount.toString()} ${movement.currency} to the buyer for underpaid wallet top-up order ${args.orderCode} — the amount that actually arrived, rather than the amount the top-up asked for — as resolved by admin ${args.adminId}.`,
      occurredAt: args.occurredAt,
      entries: pair(
        `provider_clearing.${suffix(movement.currency)}`,
        `wallet_liability.${suffix(movement.currency)}`,
        movement.amount,
        movement.currency,
      ),
    },
    context,
  );
}

/**
 * An OVERPAYMENT credited to the buyer's balance: a rail collected more than the
 * order asked for, the order was delivered, and an admin resolved the excess by
 * giving it to the buyer as wallet credit.
 *
 * `Dr provider_clearing.<ccy> / Cr wallet_liability.<ccy>` — the same pair, and
 * the same reasoning, as `postUnderpaidTopupCreditPosting`: cash a gateway really
 * collected became credit the shop owes the buyer. The amount comes from the
 * `WalletTransaction` row, so it is what `adjustWallet` actually applied rather
 * than what anyone intended to apply.
 *
 * The point of it existing (whole-branch review decision D3) is the account it
 * does NOT use. Without a dedicated posting, the only way to credit an
 * overpayment is a hand-made wallet adjustment, which books `Dr adjustment.<ccy>`
 * (EQUITY) — a claim that the shop funded this credit out of its own equity. For
 * an overpayment that is false twice over: the money arrived, so the asset side
 * is understated by every excess ever credited, and the shop's equity is consumed
 * by a payment a buyer made. The trial balance still balances; the numbers are
 * wrong. Sharing the `admin_adjust` reason code with a genuine goodwill credit is
 * not sharing economics.
 *
 * Type `ADJUSTMENT`, matching `postUnderpaidTopupCreditPosting` for the same
 * reason: an admin resolving a stuck payment by hand. Not `WALLET_DEPOSIT` (that
 * is a top-up settling for what it asked for) and not `REFUND` (nothing was
 * undone — the order was delivered and stays delivered).
 * `referenceType: "order"` points at the order whose gateway payment is being
 * recognised, since the `provider_clearing` debit is a claim that a rail collected
 * this money against THAT order; the admin is named in the description instead.
 *
 * ## NO PRODUCTION CALLER TODAY, and what each rail actually does
 *
 * Verified across all six rails (`binance_internal.ts`, `bybit_deposit.ts`,
 * `bybit_bsc_deposit.ts`, `tokopay.ts`, `paydisini.ts`, `nowpayments.ts`): on an
 * overpayment each one delivers the order, stamps `outcome: "overpaid"` on its own
 * processed-transaction row, enqueues an `ADMIN_OVERPAID` DM carrying the excess,
 * and logs. **None credits the excess, and none persists it as a figure** — it is
 * derivable as the processed row's `amount` minus the order's total, except on
 * TokoPay where the comparison is against `qrisChargeAmount(total)` because that
 * rail's admin fee is a buyer-side surcharge.
 *
 * So there is no admin route, bot command or job that credits an overpayment; an
 * admin does it today through the generic wallet-adjustment path, which cannot
 * tell this apart from goodwill and therefore posts against equity. This function
 * ships as the mapping to use the moment such a path exists — wire it where the
 * credit is made, in the same transaction, instead of
 * `postWalletAdjustmentPosting`. Giving the generic adjustment route a way to say
 * "this is order X's overpayment" is a product decision that was not part of this
 * one.
 *
 * Idempotent on `wallet:{walletTransactionId}` like every other wallet-derived
 * posting here, so the credit is recognised once however many times the resolving
 * call is replayed.
 */
export async function postOverpaymentCreditPosting(
  db: Db,
  args: {
    walletTransactionId: number;
    orderId: number;
    orderCode: string;
    adminId: number;
    occurredAt: Date;
  },
): Promise<FinancialTransaction | null> {
  const context = `the overpayment credited to the buyer of order ${args.orderCode}`;
  const movement = await readWalletMovement(db, args.walletTransactionId, context);
  if (!movement) return null;

  if (!movement.increasedBalance) {
    // A debit is not an overpayment being handed back, so there is no gateway
    // collection to recognise and the `provider_clearing` leg would be a claim
    // that money left the gateway. Whatever this movement is, it belongs on
    // another posting — refused rather than booked backwards.
    logger.error(
      `Recorded no ledger posting for ${context} because the wallet movement took ${movement.amount.toString()} ${movement.currency} AWAY from the buyer, and an overpayment credit can only ever add to a balance. The balance still moved, so whichever path passed a debit to this posting is the bug, and the movement needs to be posted as whatever it really is. ${NOT_BY_HAND}`,
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
      description: `Credited ${movement.amount.toString()} ${movement.currency} to the buyer of order ${args.orderCode} as wallet balance — the excess they paid above the order's total — as resolved by admin ${args.adminId}.`,
      occurredAt: args.occurredAt,
      entries: pair(
        `provider_clearing.${suffix(movement.currency)}`,
        `wallet_liability.${suffix(movement.currency)}`,
        movement.amount,
        movement.currency,
      ),
    },
    context,
  );
}

/**
 * An admin moving a buyer's balance by hand (`admin_adjust`) — a goodwill
 * credit, a correction, a manual debit.
 *
 * There is no customer payment behind this and no sale — both remaining call
 * sites (web-admin's users route, the bot's `/wallet` command) move a balance out
 * of nothing — so the counter-account is `adjustment.<ccy>` (EQUITY): the shop is
 * deciding to owe the buyer more, or less, out of its own equity. That is what
 * makes this posting the WRONG one for any `admin_adjust` movement that real
 * money did arrive behind. Two such cases have their own posting instead:
 * `postUnderpaidTopupCreditPosting` (a top-up that arrived short, credited anyway)
 * and `postOverpaymentCreditPosting` (a payment that arrived over, credited to the
 * balance). Both go through `provider_clearing` because the cash exists.
 *
 * NOTE, honestly: an admin crediting an overpayment TODAY reaches this function,
 * because no route hands the other one an order to point at — so equity is what an
 * overpayment credit currently consumes. See
 * `postOverpaymentCreditPosting`'s own doc comment for what each rail does and
 * what is still missing. Direction follows the movement:
 *
 * - **Credit to the buyer** (`delta > 0`): `Dr adjustment / Cr wallet_liability`
 *   — the obligation grows.
 * - **Debit from the buyer** (`delta < 0`): `Dr wallet_liability / Cr adjustment`
 *   — the obligation shrinks.
 *
 * `referenceId` is the acting admin's id, with `referenceType: "manual"`: a
 * hand-made adjustment's most useful back-pointer is the person who made it, both
 * call sites have one, and neither has an order to point at — the movement is not
 * an order's payment, and pointing the posting at an order would make it look
 * like one.
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
      `Recorded no ledger posting for the referral commission on order ${args.orderCode} because it was paid in ${movement.currency} rather than USDT, and the shop's chart of accounts has a referral commission expense account in USDT only. The referrer was still paid, so this commission is missing from the books. Referral commission is meant to be USDT-only, so whichever code path paid it in another currency is the real bug, and until that is settled there is no account this can honestly be posted to at all — adding one to the chart of accounts is an accounting decision, not a fix for this log line. ${NOT_BY_HAND}`,
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
 * One refund PAYOUT attempt landing (`executeRefund`, crud/refunds.ts): an
 * admin decided a buyer is owed money back, and this is the moment that money
 * actually left the shop — into the buyer's wallet balance (`WALLET`) or out of
 * the shop's own settled funds by hand (`MANUAL_TRANSFER`).
 *
 * Deliberately NOT `postOrderWalletCreditPosting`, whose two callers share the
 * arithmetic but not the story. Those are "money the buyer sent that we could
 * not turn into a delivered order, handed back as credit" — a payment the shop
 * never earned, returned before (or instead of) a sale. This is an admin
 * deciding to give back money on a refund the shop DID earn, for whatever
 * reason the `Refund` row records, and it can happen more than once on one
 * order. Same accounting shape, different event, different description, and
 * separate so a report reading `FinancialTransaction.description` never has to
 * claim a refunded delivered order was an undeliverable one.
 *
 * Amount, currency and method all come from the `RefundExecution` row rather
 * than from the caller's arguments — this file's convention #1 applied to a
 * payout that may have no `WalletTransaction` at all. That row is what an admin
 * reads as "what we actually paid this buyer", so it is what the books must
 * agree with.
 *
 * Which account the money comes OUT of follows exactly the same rule as
 * `postOrderWalletCreditPosting` (see `hasPostedOrderPayment`), because the
 * question is the same one:
 *
 * - **An `ORDER_PAYMENT` exists** → `Dr sales_revenue.<ccy>`. Revenue was
 *   recognised when the order settled, and refunding part of it reverses that
 *   much revenue. This is the ordinary case: a refund normally follows a real,
 *   delivered sale.
 * - **No `ORDER_PAYMENT` exists** → `Dr provider_clearing.<ccy>`. The order
 *   never settled, so no revenue was ever recognised and there is nothing to
 *   reverse; the cash a gateway collected is being recognised for the first
 *   time, on its way back out. Debiting `sales_revenue` here would book
 *   negative revenue that was never earned.
 *
 * Which account it goes INTO is what the method decides, and the difference is
 * economically real:
 *
 * - **`WALLET`** → `Cr wallet_liability.<ccy>`. The money has not left the shop
 *   at all; it has become credit the shop owes the buyer, spendable on the next
 *   order.
 * - **`MANUAL_TRANSFER`** → `Cr cash.<ccy>`. The money genuinely left the
 *   shop's own settled funds (`cash.*` is "money actually settled into our own
 *   account" — see `CHART_OF_ACCOUNTS`). Crediting `wallet_liability` for a
 *   bank transfer would invent an obligation that was just discharged and leave
 *   the shop's cash overstated by every manual refund ever paid.
 *
 * A method this function does not recognise is logged and skipped rather than
 * guessed at: there is no third account it could plausibly credit, and guessing
 * would misstate the books more quietly than a missing posting does.
 */
export async function postRefundExecutionPosting(
  db: Db,
  args: { refundExecutionId: number; orderId: number; orderCode: string; occurredAt: Date },
): Promise<FinancialTransaction | null> {
  const context = `the refund paid out for order ${args.orderCode}`;

  const execution = await db.refundExecution.findUnique({
    where: { id: args.refundExecutionId },
    select: { amount: true, currency: true, method: true },
  });
  if (!execution) {
    // Only reachable if a caller passed an id from a transaction that has since
    // rolled back, or a hand-written one. The payout this was meant to describe
    // does not exist, so there is no financial event to record either.
    logger.error(
      `Posted nothing to the ledger for ${context} because refund execution ${args.refundExecutionId} could not be found — if that payout really happened, the books do not reflect it. Once the row is readable, "pnpm backfill-ledger-history" posts every completed payout that has no posting yet. ${NOT_BY_HAND}`,
    );
    return null;
  }

  const amount = q4(new Decimal(execution.amount));
  if (!amount.greaterThan(0)) {
    logger.warn(
      `Recorded no ledger posting for ${context} because the recorded payout amount is zero or negative, so no money moved. A refund execution with no value should not be creatable, so whichever path wrote it is worth investigating.`,
    );
    return null;
  }

  const paidInto =
    execution.method === RefundExecutionMethod.WALLET
      ? `wallet_liability.${suffix(execution.currency)}`
      : execution.method === RefundExecutionMethod.MANUAL_TRANSFER
        ? `cash.${suffix(execution.currency)}`
        : null;
  if (paidInto === null) {
    logger.error(
      { method: execution.method },
      `Recorded no ledger posting for ${context} because its payout method is not one this shop knows how to book. The buyer may well have been paid, so this refund is missing from the books, and whichever path wrote an unknown method is the real bug: until this file learns which account that method pays out of, there is nothing it can honestly post. Fix the method, then re-post with "pnpm backfill-ledger-history". ${NOT_BY_HAND}`,
    );
    return null;
  }
  const destination =
    execution.method === RefundExecutionMethod.WALLET
      ? "into the buyer's wallet balance"
      : "by a transfer out of the shop's own funds";

  const revenueWasRecognised = await hasPostedOrderPayment(db, args.orderId);
  const paidFrom = revenueWasRecognised
    ? `sales_revenue.${suffix(execution.currency)}`
    : `provider_clearing.${suffix(execution.currency)}`;
  const explanation = revenueWasRecognised
    ? "reversing that much of the revenue recognised for it"
    : "recognising the payment that arrived for it, which was never recognised as revenue";

  return postOrSkipMissingAccount(
    db,
    {
      type: FinancialTransactionType.REFUND,
      referenceType: "refund_execution",
      referenceId: args.refundExecutionId,
      idempotencyKey: refundExecutionKey(args.refundExecutionId),
      description: `Refunded ${amount.toString()} ${execution.currency} to the buyer of order ${args.orderCode} ${destination}, ${explanation}.`,
      occurredAt: args.occurredAt,
      entries: pair(paidFrom, paidInto, amount, execution.currency),
    },
    context,
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
