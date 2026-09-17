/**
 * Ledger reconciliation (Financial Ledger M5) — the read-only drift detector
 * that asks whether the double-entry ledger still describes the money this shop
 * actually moved.
 *
 * `crud/ledger.ts` owns HOW a posting is written and `crud/ledgerPostings.ts`
 * owns WHAT each event posts. This file owns the question neither of them can
 * answer from inside: did every event that should have posted actually post,
 * and do the postings still agree with the rows they describe? It writes
 * nothing — not a correction, not an adjustment, not a flag on a row. A
 * reconciliation that repairs what it finds destroys the evidence of how the
 * books came to disagree, and "the ledger is append-only" (crud/ledger.ts)
 * would stop being true the moment a scheduled job started editing it.
 *
 * Separate from `reconcileFinances` (crud/reports.ts), deliberately and
 * permanently. That function checks the OPERATIONAL rows against each other
 * (an order's total against its own components, a voucher's used-count against
 * its orders, wallet balances against zero) and predates the ledger entirely;
 * this one checks those rows against the LEDGER. Both run, neither replaces the
 * other, and their finding shapes differ because their outputs are consumed
 * differently — this one carries severity, currency, a signed difference and a
 * detection timestamp per finding, which is what the plan's reconciliation
 * matrix (and any future admin view of it) needs.
 *
 * Four properties hold throughout:
 *
 * 1. **No fabricated findings.** Every finding points at two real sets of rows
 *    that genuinely disagree. Where a comparison cannot be made honestly — a
 *    chart of accounts that was never seeded, an order with no timestamp to
 *    place it against the cutover — the check SKIPS that row and says so in the
 *    log, rather than reporting a guess as drift. A reconciliation report nobody
 *    trusts is worth less than no report.
 * 2. **Bulk queries only.** Every check is a fixed, small number of queries
 *    regardless of how many rows it examines (`findMany`/`groupBy`/`aggregate`
 *    plus in-memory `Map` joins) — the same discipline `reconcileFinances`
 *    already follows. This runs every six hours against tables that grow
 *    forever; a per-row `await` in a loop would degrade silently and without
 *    limit.
 * 3. **Money is compared as money.** `moneyEq` (4 decimal places) or an explicit
 *    tolerance, never `Decimal.equals` on raw column values, and never across
 *    currencies: IDR and USDT are separate, unconvertible books here (see
 *    `assertBalancedPerCurrency` in crud/ledger.ts), so every check that
 *    compares amounts does it within one currency.
 * 4. **The cutover boundary** keeps the missing-posting check honest about an
 *    un-backfilled ledger — see `ledgerCutover` below.
 *
 * Deliberately NOT here: any repair or backfill of historical postings (M10
 * owns that, as a manually-triggered script), and any admin UI over these
 * findings. The cron job that runs this and pages an admin is
 * `reconcileLedgerJob` (apps/order-bot/src/jobs/index.ts).
 */
import {
  LedgerDirection,
  OrderCurrency,
  OrderKind,
  OrderStatus,
  ReconciliationFindingType,
  ReconciliationSeverity,
  RefundExecutionStatus,
} from "@app/core/enums";
import { AppError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { Decimal, money, moneyEq, ZERO } from "@app/core/money";
import type { Db } from "./_types";
import { getAccountBalance } from "./ledger";

/**
 * One discrepancy between the operational rows and the ledger.
 *
 * Every field is a string (or a `Date`) rather than a `Decimal`, because a
 * finding is a REPORT LINE: it gets logged, DM'd to an admin and — later —
 * rendered. `Decimal.toString()` at the point of detection keeps the exact
 * value that was compared, where a consumer re-parsing a number could not.
 */
export interface LedgerReconciliationFinding {
  /** `ReconciliationFindingType` value (@app/core/enums). */
  type: string;
  /** What kind of thing drifted: "order" | "wallet_liability" | "payment" | "refund_execution". */
  entity: string;
  /** Whatever uniquely names the row — an id, or a currency code for a control account. */
  entityId: string;
  /** What the books should say: a `Decimal.toString()`, or a word for a presence check. */
  expected: string;
  /** What they actually say, in the same units as `expected`. */
  actual: string;
  /** `expected - actual` as a signed `Decimal.toString()` when both sides are money; null otherwise. */
  difference: string | null;
  /** "IDR" | "USDT", or null for a currency-agnostic finding. */
  currency: string | null;
  /** A human-readable pointer an admin can act on without opening a database client. */
  reference: string;
  /** `ReconciliationSeverity` value (@app/core/enums). */
  severity: string;
  /** When this run detected it — one clock read for the whole run, not one per finding. */
  detectedAt: Date;
}

/**
 * How far apart two money figures may be before it counts as drift.
 *
 * Same value and same reasoning as `reconcileFinances`' own comparison in
 * crud/reports.ts: this repo quantizes money to 4 decimal places, so anything
 * at or below that is a representation artefact rather than a disagreement.
 * Written as a string, not a float, for the same reason every other amount here
 * is.
 */
const MONEY_TOLERANCE = "0.0001";

/** The chart-of-accounts suffix for a currency: "IDR" → "idr". Mirrors ledgerPostings.ts. */
const suffix = (currency: string): string => currency.toLowerCase();

/** A `_sum` aggregate that saw no rows is a real zero, not an unknown. */
const sumOrZero = (value: Decimal.Value | null | undefined): Decimal => money(value ?? 0);

/**
 * The instant before which this reconciliation does not look for missing
 * postings: the earliest `occurredAt` the ledger has ever recorded.
 *
 * This is the self-configuring answer to a problem the plan created on purpose.
 * The ledger posts only events that happen from its deploy forward; historical
 * orders are backfilled by a separate, manually-triggered script (M10) that has
 * not run. Without a boundary, the first production run of this job would
 * report every DELIVERED order the shop ever had as a CRITICAL missing posting
 * — thousands of findings that all say "this order predates the ledger", buried
 * among the handful that might mean something. An alert that cries wolf on its
 * first run is an alert that gets muted before it ever fires for real.
 *
 * Reading the earliest posting rather than a configured date is what makes it
 * self-maintaining in both directions: nothing to set at deploy time, and when
 * M10 backfills history with back-dated `occurredAt` values the boundary moves
 * back with them automatically, so the check widens to cover exactly the period
 * the books now claim to describe.
 *
 * `null` means the ledger has posted nothing at all — a fresh install, or a
 * test database. There is then no boundary that could be honest, so the
 * missing-posting check does not run at all rather than flagging the shop's
 * entire history.
 */
async function ledgerCutover(db: Db): Promise<Date | null> {
  const earliest = await db.financialTransaction.aggregate({ _min: { occurredAt: true } });
  return earliest._min.occurredAt ?? null;
}

/** The idempotency keys ledgerPostings.ts derives, re-derived for lookup. */
const orderPaymentKey = (orderId: number): string => `order:${orderId}:payment`;
const orderTopupKey = (orderId: number): string => `order:${orderId}:topup`;
const refundExecutionKey = (refundExecutionId: number): string =>
  `refund_execution:${refundExecutionId}`;

/** Which of the posted keys already exist, as one indexed bulk lookup. */
async function postedKeys(db: Db, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db.financialTransaction.findMany({
    where: { idempotencyKey: { in: [...keys] } },
    select: { idempotencyKey: true },
  });
  return new Set(rows.map((row) => row.idempotencyKey));
}

/** The subset of an order this check reads. */
interface CandidateOrder {
  id: number;
  orderCode: string;
  kind: string;
  currency: string;
  totalAmount: Decimal;
}

/**
 * Settled orders that should carry a ledger posting but do not.
 *
 * Two shapes of settled order, each with its own key: a PRODUCT order that
 * reached DELIVERED posts `order:{id}:payment` (from `approveOrder`, or from
 * `settlePaidOrder`'s MANUAL branch before it), and a WALLET_TOPUP order that
 * reached DELIVERED posts `order:{id}:topup` (from `settleWalletTopup`, which
 * sets DELIVERED and `paidAt` in the same atomic claim). Looking for the wrong
 * key would report every settled top-up in the shop as missing, so the two are
 * split by `kind` before any key is derived.
 *
 * **`paidAt`, not `deliveredAt`, is what the cutover compares.** All three
 * posting sites pass their own `now` as BOTH the order's `paidAt` and the
 * posting's `occurredAt`, so `paidAt` is exactly the instant a posting for this
 * order would carry — which is the only timestamp that can be compared
 * like-for-like against the earliest `occurredAt` in the ledger. `deliveredAt`
 * is a later and sometimes much later fact (a hand-fulfilled order is paid and
 * posted at PROCESSING, then delivered whenever an admin gets to it), so an
 * order paid just before the cutover and delivered just after it would be
 * reported as drift when it is really just pre-ledger. The rare DELIVERED order
 * with no `paidAt` at all falls back to `deliveredAt` rather than being dropped
 * silently — an approximate placement is better than a blind spot, and it can
 * only make the check more conservative at the boundary.
 *
 * **Orders that legitimately post nothing are excluded**, not reported. Both
 * posting helpers return `null` without writing anything when there is no
 * amount to recognise: a top-up whose total is not positive, and a product
 * order with neither an external total nor any wallet credit spent on it (a
 * 100%-voucher order, say). Those orders have no posting BY DESIGN, and
 * flagging them would be exactly the fabricated finding this file refuses to
 * produce.
 */
async function findMissingOrderPostings(
  db: Db,
  cutover: Date,
  detectedAt: Date,
): Promise<LedgerReconciliationFinding[]> {
  const rows = await db.order.findMany({
    where: {
      status: OrderStatus.DELIVERED,
      OR: [
        { paidAt: { gte: cutover } },
        { AND: [{ paidAt: null }, { deliveredAt: { gte: cutover } }] },
      ],
    },
    select: { id: true, orderCode: true, kind: true, currency: true, totalAmount: true },
  });
  if (rows.length === 0) return [];

  const candidates: CandidateOrder[] = rows.map((row) => ({
    id: row.id,
    orderCode: row.orderCode,
    kind: row.kind,
    currency: row.currency,
    totalAmount: money(row.totalAmount),
  }));

  const topups = candidates.filter((order) => order.kind === OrderKind.WALLET_TOPUP);
  const products = candidates.filter((order) => order.kind !== OrderKind.WALLET_TOPUP);

  // One aggregate for every candidate product order's wallet legs, so the
  // "did this order charge the buyer anything at all" question costs one query
  // rather than one per order. Grouped by currency because the legs carry their
  // own currency and a non-positive group is not a payment — the same reading
  // `postOrderPaymentPosting` does when it builds the legs in the first place.
  const walletSpendByOrder = new Map<number, boolean>();
  if (products.length > 0) {
    const legs = await db.walletTransaction.groupBy({
      by: ["orderId", "currency"],
      where: { reason: "order_payment", orderId: { in: products.map((order) => order.id) } },
      _sum: { delta: true },
    });
    for (const leg of legs) {
      if (leg.orderId == null) continue;
      // Wallet debits are stored negative; the amount spent is their magnitude.
      const spent = sumOrZero(leg._sum.delta?.toString()).negated();
      if (spent.greaterThan(0)) walletSpendByOrder.set(leg.orderId, true);
    }
  }

  const expectPosting = (order: CandidateOrder): boolean =>
    order.kind === OrderKind.WALLET_TOPUP
      ? order.totalAmount.greaterThan(0)
      : order.totalAmount.greaterThan(0) || walletSpendByOrder.get(order.id) === true;

  const chargeable = [
    ...topups.filter(expectPosting).map((order) => ({ order, key: orderTopupKey(order.id) })),
    ...products.filter(expectPosting).map((order) => ({ order, key: orderPaymentKey(order.id) })),
  ];
  const posted = await postedKeys(
    db,
    chargeable.map((entry) => entry.key),
  );

  return chargeable
    .filter((entry) => !posted.has(entry.key))
    .map(({ order, key }) => ({
      type: ReconciliationFindingType.LEDGER_POSTING_MISSING,
      entity: "order",
      entityId: String(order.id),
      // A presence check, not a money comparison: the amount is not in dispute,
      // the existence of any record of it is.
      expected: "posted",
      actual: "missing",
      difference: null,
      currency: order.currency,
      reference: `Order ${order.orderCode} settled for ${order.totalAmount.toString()} ${order.currency} with no ledger posting under "${key}"`,
      severity: ReconciliationSeverity.CRITICAL,
      detectedAt,
    }));
}

/** The subset of a refund payout these two checks read. */
interface CompletedExecution {
  id: number;
  amount: Decimal;
  currency: string;
  executedAt: Date | null;
  orderCode: string;
  refundId: number;
}

/**
 * Every COMPLETED payout, with the order code an admin would search for.
 *
 * Fetched once and shared by both checks that read payouts (missing posting,
 * amount mismatch) rather than queried twice, and joined to its order in the
 * same round trip — `reference` has to name something an admin recognises, and
 * a payout's id alone is not that.
 */
async function completedRefundExecutions(db: Db): Promise<CompletedExecution[]> {
  const rows = await db.refundExecution.findMany({
    where: { status: RefundExecutionStatus.COMPLETED },
    select: {
      id: true,
      amount: true,
      currency: true,
      executedAt: true,
      refundId: true,
      refund: { select: { order: { select: { orderCode: true } } } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    amount: money(row.amount),
    currency: row.currency,
    executedAt: row.executedAt,
    refundId: row.refundId,
    orderCode: row.refund.order.orderCode,
  }));
}

/**
 * Payouts that really happened but were never booked.
 *
 * Scoped by the same cutover as the order check, read off `executedAt` — the
 * instant `executeRefund` stamps on the row and passes as the posting's
 * `occurredAt`, so the two are directly comparable. A COMPLETED payout with no
 * `executedAt` cannot be placed against the boundary at all; it is skipped and
 * counted in a log line rather than guessed either way.
 */
function findMissingRefundPostings(
  executions: readonly CompletedExecution[],
  posted: ReadonlySet<string>,
  cutover: Date,
  detectedAt: Date,
): LedgerReconciliationFinding[] {
  const undatable = executions.filter((execution) => execution.executedAt === null);
  if (undatable.length > 0) {
    logger.warn(
      `Skipped ${undatable.length} completed refund payout(s) while reconciling the ledger because they carry no execution timestamp, so there is no way to tell whether they happened before or after the ledger started recording. They are neither confirmed nor reported as missing a ledger posting; a completed payout with no executed_at is itself worth investigating in whichever path wrote it.`,
    );
  }

  return executions
    .filter((execution) => execution.executedAt !== null && execution.executedAt >= cutover)
    .filter((execution) => !posted.has(refundExecutionKey(execution.id)))
    .map((execution) => ({
      type: ReconciliationFindingType.LEDGER_POSTING_MISSING,
      entity: "refund_execution",
      entityId: String(execution.id),
      expected: "posted",
      actual: "missing",
      difference: null,
      currency: execution.currency,
      reference: `Refund payout #${execution.id} (refund #${execution.refundId}, order ${execution.orderCode}) paid ${execution.amount.toString()} ${execution.currency} with no ledger posting under "${refundExecutionKey(execution.id)}"`,
      severity: ReconciliationSeverity.CRITICAL,
      detectedAt,
    }));
}

/**
 * A posted payout whose ledger entries record a different amount than the
 * payout row itself.
 *
 * Compares the payout's `amount` against the sum of its posting's DEBIT
 * entries. Either side of the posting would do — `postFinancialTransaction`
 * refuses to write a transaction whose debits and credits disagree — so the
 * debit side is picked once, consistently, rather than summing both and
 * inviting the question of which to believe.
 *
 * This should never fire: `postRefundExecutionPosting` reads `execution.amount`
 * fresh at posting time, in the same transaction that wrote the row. It is here
 * as the same class of defensive read as the duplicate-payment check — the
 * reachable failure is not a wrong posting but a payout row REWRITTEN after it
 * was posted, which no constraint prevents and nothing else would notice.
 */
async function findRefundAmountMismatches(
  db: Db,
  executions: readonly CompletedExecution[],
  detectedAt: Date,
): Promise<LedgerReconciliationFinding[]> {
  if (executions.length === 0) return [];

  const byKey = new Map(executions.map((execution) => [refundExecutionKey(execution.id), execution]));
  const postings = await db.financialTransaction.findMany({
    where: { idempotencyKey: { in: [...byKey.keys()] } },
    select: { id: true, idempotencyKey: true },
  });
  if (postings.length === 0) return [];

  const debitSums = await db.ledgerEntry.groupBy({
    by: ["financialTransactionId"],
    where: {
      financialTransactionId: { in: postings.map((posting) => posting.id) },
      direction: LedgerDirection.DEBIT,
    },
    _sum: { amount: true },
  });
  const postedAmountByTransaction = new Map(
    debitSums.map((row) => [row.financialTransactionId, sumOrZero(row._sum.amount?.toString())]),
  );

  const findings: LedgerReconciliationFinding[] = [];
  for (const posting of postings) {
    const execution = byKey.get(posting.idempotencyKey);
    if (!execution) continue;
    // A posting with no entries cannot exist (`postFinancialTransaction`
    // rejects an empty list), so an absent sum means the entries were removed
    // around the posting service — real drift, reported as the zero it is.
    const postedAmount = postedAmountByTransaction.get(posting.id) ?? ZERO;
    if (moneyEq(execution.amount, postedAmount)) continue;
    findings.push({
      type: ReconciliationFindingType.REFUND_AMOUNT_MISMATCH,
      entity: "refund_execution",
      entityId: String(execution.id),
      expected: execution.amount.toString(),
      actual: postedAmount.toString(),
      difference: money(execution.amount.minus(postedAmount)).toString(),
      currency: execution.currency,
      reference: `Refund payout #${execution.id} (refund #${execution.refundId}, order ${execution.orderCode}) paid ${execution.amount.toString()} ${execution.currency} but its ledger posting records ${postedAmount.toString()}`,
      severity: ReconciliationSeverity.CRITICAL,
      detectedAt,
    });
  }
  return findings;
}

/**
 * The two `WalletTransaction` reason codes that make up one order's checkout
 * hold: the debit `adjustWallet` writes when a buyer spends credit at checkout
 * (`order_payment`, from all three checkout paths in crud/orders.ts) and the
 * credit `releaseOrderHolds` writes when that order is rejected, cancelled or
 * credited back (`order_refund`). `wallet_transactions` is UNIQUE on
 * `(orderId, reason)`, so an order has at most one of each and their sum is its
 * outstanding hold — nothing else here depends on that, but it is why the sum is
 * a net of two rows rather than of an open-ended history.
 */
const HOLD_REASONS: readonly string[] = ["order_payment", "order_refund"];

/**
 * How much wallet credit is spent but not yet booked, per currency.
 *
 * This is the reconciling term between two records that are both correct and
 * updated at DIFFERENT MOMENTS. Checkout debits `User.walletBalance` the instant
 * a buyer spends credit (crud/orders.ts, all three checkout paths), while
 * `wallet_liability.<ccy>` is only debited when the order SETTLES, by
 * `postOrderPaymentPosting`'s wallet leg — this ledger recognises nothing until
 * an order settles, deliberately (see `postOrderHoldReleasePosting`'s doc
 * comment for why posting the hold itself would be wrong). So every order
 * sitting in PENDING_PAYMENT or PENDING_VERIFICATION with credit spent on it
 * makes the buyers' side of `findWalletLedgerDrift` legitimately SMALLER than
 * the ledger's, by exactly the amount held. Without this term, an ordinary
 * checkout — the single most common thing this shop does — would raise a
 * CRITICAL drift alert every six hours until an admin approved the order.
 *
 * An order counts as in flight when NO `order:{id}:payment` posting exists for
 * it, which is the same question the settlement path answers and not a guess
 * about status: statuses change and get added, the posting's presence is the
 * fact that actually decides whether `wallet_liability` has been debited yet.
 * A settled order whose posting was ERASED therefore lands here too, and is
 * reported by `findMissingOrderPostings` instead — the same root cause named
 * once, by the check that can point at the order, rather than twice.
 *
 * The release is netted against the debit per order, so a hold returned by
 * `releaseOrderHolds` stops counting: both movements are invisible to the ledger
 * on an unsettled order, so their sum is what remains outstanding. A net that
 * comes out NEGATIVE (more credit returned than was ever spent — unreachable
 * through the app, since the release amount is the order's own `walletUsed`) is
 * floored at zero rather than subtracted: this term exists to explain a
 * shortfall the ledger has not caught up with, and letting it go negative would
 * let it explain away credit that appeared from nowhere, which is drift.
 *
 * Two queries regardless of how many orders are involved: one `groupBy` that
 * nets each order's movements in the database, then one indexed lookup of the
 * payment keys for the orders whose net is non-zero. Like the rest of this file
 * the second one's `IN` list is unbounded (the same precedent `reconcileFinances`
 * sets); it is bounded in practice by orders that hold wallet credit — every
 * released hold nets to zero and is dropped before the lookup.
 */
async function inFlightWalletHolds(db: Db): Promise<Map<string, Decimal>> {
  const movements = await db.walletTransaction.groupBy({
    by: ["orderId", "currency"],
    where: { reason: { in: [...HOLD_REASONS] }, orderId: { not: null } },
    _sum: { delta: true },
  });

  // Grouped per (order, currency) because the movement rows carry their own
  // currency — the same reading `postOrderPaymentPosting` does when it builds
  // the wallet leg — and a debit is stored negative, so the outstanding hold is
  // the negation of the net.
  const outstanding = movements
    .filter((movement) => movement.orderId !== null)
    .map((movement) => ({
      orderId: movement.orderId as number,
      currency: movement.currency,
      hold: Decimal.max(ZERO, sumOrZero(movement._sum.delta?.toString()).negated()),
    }))
    .filter((row) => row.hold.greaterThan(0));
  if (outstanding.length === 0) return new Map();

  const posted = await postedKeys(
    db,
    [...new Set(outstanding.map((row) => row.orderId))].map(orderPaymentKey),
  );

  const totals = new Map<string, Decimal>();
  for (const row of outstanding) {
    if (posted.has(orderPaymentKey(row.orderId))) continue;
    totals.set(row.currency, (totals.get(row.currency) ?? ZERO).plus(row.hold));
  }
  return totals;
}

/**
 * The control-account invariant: the sum of every buyer's wallet balance must
 * equal the `wallet_liability.<ccy>` account that exists to mirror it.
 *
 * This is the one check whose failure means the wallet sub-ledger itself is
 * wrong, and it is the reason `wallet_liability` is an account rather than a
 * derived figure: `User.walletBalance` is what a buyer can spend, and
 * `wallet_liability.idr` is what the books say the shop owes buyers. Those are
 * two independent records of the same obligation, updated by different code
 * (`adjustWallet` and `postFinancialTransaction`), so the only thing that keeps
 * them equal is that every balance movement also posts — which is precisely
 * what this compares.
 *
 * Both currencies are checked independently and never summed: IDR and USDT are
 * separate books here (see `assertBalancedPerCurrency` in crud/ledger.ts), and
 * a blended total would let a surplus in one hide a shortfall in the other.
 *
 * **The two records are updated at different moments, so the comparison carries
 * one reconciling term**: wallet credit spent at checkout leaves
 * `User.walletBalance` immediately but only reaches `wallet_liability.<ccy>` when
 * the order settles, so the buyers' side is legitimately lower than the ledger's
 * while any order is in flight. `inFlightWalletHolds` measures that gap from real
 * `WalletTransaction` rows and it is ADDED to the buyers' side before comparing.
 * It is a timing difference between two correct records, not an allowance: it is
 * computed per order from rows that exist, floored at zero, and it can only ever
 * explain a shortfall the ledger has not caught up with.
 *
 * **Before M10's backfill runs, this check is EXPECTED to report the shop's
 * whole pre-ledger wallet float as drift.** That is a different problem from the
 * in-flight term above and has a different fix. `User.walletBalance` carries
 * every credit a buyer has ever been given, including the ones granted before the
 * ledger existed, while `wallet_liability.idr` only holds what has been posted
 * since M3 went live; until the backfill books that history, the difference
 * between them is real and this check reports it. It resolves when M10 runs, not
 * before.
 *
 * It is NOT reported unscoped because the per-row history to scope it with is
 * missing — that history exists. `adjustWallet` (crud/users.ts) writes a
 * timestamped `WalletTransaction` with `delta` and `balanceAfter` before every
 * single balance write, so "movements since the cutover" is a query anyone could
 * write. It is reported unscoped because scoping it that way would blind the
 * check to any balance change that bypassed `adjustWallet` altogether — a
 * hand-edited `User.walletBalance` column, a future credit path that forgets to
 * go through it — which writes no `WalletTransaction` row and would therefore
 * cancel out of a movements-based comparison exactly. That is precisely the class
 * of drift this check exists to catch, so the unscoped comparison is the
 * deliberately more paranoid one, not merely the un-optimised one. Suppressing
 * the pre-ledger float instead would need a stored opening balance this milestone
 * does not have, and inventing one would be exactly the fabricated figure this
 * file refuses to produce.
 *
 * One aggregate for both currencies, then one balance read per account. An
 * account that does not exist at all (an environment where
 * `pnpm seed-chart-of-accounts` was never run) is logged and SKIPPED rather
 * than compared against a zero it never had: `getAccountBalance` refuses to
 * call a missing account "0.00" for exactly this reason, and reporting the
 * buyers' whole balance as drift against an account that was never created
 * would name the wrong problem.
 */
async function findWalletLedgerDrift(
  db: Db,
  detectedAt: Date,
): Promise<LedgerReconciliationFinding[]> {
  const totals = await db.user.aggregate({
    _sum: { walletBalance: true, walletBalanceUsdt: true },
  });
  const byCurrency: ReadonlyArray<{ currency: string; usersTotal: Decimal }> = [
    { currency: OrderCurrency.IDR, usersTotal: sumOrZero(totals._sum.walletBalance?.toString()) },
    { currency: OrderCurrency.USDT, usersTotal: sumOrZero(totals._sum.walletBalanceUsdt?.toString()) },
  ];

  const holds = await inFlightWalletHolds(db);

  const findings: LedgerReconciliationFinding[] = [];
  for (const { currency, usersTotal } of byCurrency) {
    const accountCode = `wallet_liability.${suffix(currency)}`;
    let ledgerTotal: Decimal;
    try {
      ledgerTotal = await getAccountBalance(db, accountCode);
    } catch (e) {
      if (e instanceof AppError && e.key === "error.ledger_account_not_found") {
        logger.error(
          { err: e, accountCode },
          `Could not reconcile buyers' wallet balances against the ledger because the "${accountCode}" account does not exist in this database. No drift is being reported for this currency — there is nothing to compare against, which is a different and more serious problem than a mismatch. It almost always means the chart of accounts was never seeded here; run "pnpm seed-chart-of-accounts".`,
        );
        continue;
      }
      throw e;
    }

    // What the control account should stand at: the credit buyers can still
    // spend, plus the credit they have already spent on orders the ledger has
    // not booked yet. Both halves come from real rows.
    const inFlight = holds.get(currency) ?? ZERO;
    const expected = money(usersTotal.plus(inFlight));

    const difference = money(expected.minus(ledgerTotal));
    if (!difference.abs().greaterThan(MONEY_TOLERANCE)) continue;
    // The one check in this file whose finding is logged individually, and the
    // only one where that is affordable: it produces at most one finding per
    // currency, so the log stays bounded however badly the books have drifted.
    // The other three are reported by count in `reconcileLedgerJob`'s own
    // summary line (apps/order-bot/src/jobs/index.ts) because each can return a
    // finding per order, payment or payout — and listing those here would mean
    // either an unbounded log or a truncated id dump, which docs/LOGGING.md
    // rules out in favour of summarising by count.
    //
    // Logged at `error`, not `warn`: this is the control account for money the
    // shop owes its buyers, and the two records of that same money disagree.
    logger.error(
      { accountCode, currency },
      `Buyers' wallet balances no longer agree with the ledger in ${currency}: the "${accountCode}" control account stands at ${ledgerTotal.toString()} while the balances buyers actually hold — ${usersTotal.toString()} spendable, plus ${inFlight.toString()} already spent on orders that have not settled yet — come to ${expected.toString()}, a difference of ${difference.toString()}. This line cannot tell apart the shop's two possible causes: either this is the known, expected gap from wallet credit that pre-dates the ledger and simply has not been backfilled (M10) yet, or one of the two figures above is genuinely wrong about money the shop owes real people. Confirm which before treating this as a new incident — if the historical backfill has already run, it is the latter, and needs reconciling by hand.`,
    );
    findings.push({
      type: ReconciliationFindingType.WALLET_LEDGER_DRIFT,
      entity: "wallet_liability",
      entityId: currency,
      expected: expected.toString(),
      actual: ledgerTotal.toString(),
      difference: difference.toString(),
      currency,
      reference: inFlight.greaterThan(0)
        ? `Buyers hold ${usersTotal.toString()} ${currency} of wallet credit between them and have spent a further ${inFlight.toString()} ${currency} on orders that have not settled yet, so the "${accountCode}" control account should stand at ${expected.toString()} — it stands at ${ledgerTotal.toString()}`
        : `Buyers hold ${usersTotal.toString()} ${currency} of wallet credit between them, but the "${accountCode}" control account stands at ${ledgerTotal.toString()}`,
      severity: ReconciliationSeverity.CRITICAL,
      detectedAt,
    });
  }
  return findings;
}

/**
 * Two `Payment` rows claiming the same provider transaction.
 *
 * `@@unique([method, providerTransactionId])` already forbids this at write
 * time, so on a healthy database this check returns nothing on every run —
 * which is the correct outcome, not evidence the check is pointless. What it
 * catches is the case the constraint cannot: a row written around the Prisma
 * client (a manual edit, a partially-applied migration, a restore from an
 * inconsistent dump). A genuine duplicate here means one provider payment was
 * recorded twice, which is a double-counted settlement.
 *
 * Nulls are never flagged. `providerTransactionId` is null whenever a rail
 * never captured a reference (the schema's own doc comment says so), and those
 * rows are legitimately distinct — grouping them together would report every
 * shop's ordinary payment history as a mass duplication.
 *
 * Prisma has no `having` on `groupBy`, so the counts are filtered in JS. That
 * is not a sampling shortcut: the grouped result has one row per distinct
 * provider transaction, and only the handful with a count above one survive.
 */
async function findDuplicateProviderTransactions(
  db: Db,
  detectedAt: Date,
): Promise<LedgerReconciliationFinding[]> {
  const groups = await db.payment.groupBy({
    by: ["method", "providerTransactionId"],
    where: { providerTransactionId: { not: null } },
    _count: { _all: true },
  });

  return groups
    .filter((group) => group._count._all > 1 && group.providerTransactionId !== null)
    .map((group) => ({
      type: ReconciliationFindingType.DUPLICATE_PROVIDER_TRANSACTION,
      entity: "payment",
      entityId: `${group.method}:${group.providerTransactionId}`,
      // A count comparison, not a money one: how many payment rows claim this
      // one provider transaction, against the one row that may.
      expected: "1",
      actual: String(group._count._all),
      difference: null,
      currency: null,
      reference: `${group._count._all} payment rows share provider transaction "${group.providerTransactionId}" on ${group.method}`,
      severity: ReconciliationSeverity.CRITICAL,
      detectedAt,
    }));
}

/**
 * Run every ledger reconciliation check and return what drifted.
 *
 * An empty array means the books agree with the rows they describe, as far as
 * these four checks can see — it does NOT mean nothing was checked, and it is
 * the expected result of most runs. Reads only; see this file's module comment
 * for why it must stay that way.
 *
 * One `detectedAt` is taken for the whole run and stamped on every finding, so
 * a report's rows all say when the books were examined rather than each
 * carrying a slightly different clock read from the moment its own query
 * returned.
 */
export async function reconcileLedger(db: Db): Promise<LedgerReconciliationFinding[]> {
  const detectedAt = new Date();
  const findings: LedgerReconciliationFinding[] = [];

  const executions = await completedRefundExecutions(db);

  const cutover = await ledgerCutover(db);
  if (cutover === null) {
    // Nothing has ever been posted, so "this event has no posting" is true of
    // the shop's entire history and says nothing about drift. Reported as a log
    // line rather than as thousands of findings.
    logger.info(
      "Skipped the missing-ledger-posting checks while reconciling the ledger because the ledger has no postings at all yet, so there is no point in its history to measure drift from. The wallet, duplicate-payment and refund-amount checks still ran.",
    );
  } else {
    findings.push(...(await findMissingOrderPostings(db, cutover, detectedAt)));
    const posted = await postedKeys(
      db,
      executions.map((execution) => refundExecutionKey(execution.id)),
    );
    findings.push(...findMissingRefundPostings(executions, posted, cutover, detectedAt));
  }

  findings.push(...(await findWalletLedgerDrift(db, detectedAt)));
  findings.push(...(await findDuplicateProviderTransactions(db, detectedAt)));
  findings.push(...(await findRefundAmountMismatches(db, executions, detectedAt)));

  return findings;
}

/**
 * How many findings of each type a run produced, in a stable order.
 *
 * Lives here rather than in the cron job because the counts follow the enum,
 * not the caller: a type added to `ReconciliationFindingType` later should show
 * up in the job's log line and admin DM without the job having to learn about
 * it. Types with no findings are included as zeros, so a report reads the same
 * shape every run.
 */
export function countFindingsByType(
  findings: readonly LedgerReconciliationFinding[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of Object.values(ReconciliationFindingType)) counts[type] = 0;
  for (const finding of findings) counts[finding.type] = (counts[finding.type] ?? 0) + 1;
  return counts;
}
