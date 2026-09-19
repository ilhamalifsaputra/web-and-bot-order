/**
 * Ledger posting service (Financial Ledger M2) — the ONLY writer of
 * `FinancialTransaction`/`LedgerEntry` rows, plus the two read helpers that
 * interpret them (`getAccountBalance`, `trialBalance`).
 *
 * Being the only writer is what makes this file load-bearing. Every invariant
 * the ledger depends on is an APPLICATION-layer invariant (see LedgerEntry's
 * doc comment in prisma/schema.prisma): `amount` positive, `entry.currency ==
 * account.currency`, and debits equal credits per currency. Postgres cannot
 * express the third at all (a cross-row aggregate), and this schema does not use
 * CHECK constraints for the first two either — `db push` is the deploy mechanism
 * (docs/MIGRATIONS.md), so invariants live in code. Nothing else may insert into
 * these two tables: a second writer is a second, unreviewed copy of the rules.
 *
 * Two things are enforced here that no amount of care at the CALL site could
 * enforce instead:
 *
 * 1. **Balance before write.** Validation runs to completion before the first
 *    INSERT, so a rejected posting leaves no half-written event behind. An
 *    unbalanced FinancialTransaction is not a recoverable state — nothing later
 *    can tell which of its legs was the wrong one.
 * 2. **One economic effect per `idempotencyKey`.** Every payment rail in this
 *    shop is at-least-once (webhooks redeliver, pollers re-check the same order
 *    every cycle), so posting sites WILL ask to post the same event twice. A
 *    duplicate returns the already-posted row rather than throwing, because a
 *    retry is normal operation, not an error a webhook handler should surface.
 *
 * Deliberately NOT in this file:
 * - **No reversal helper.** The ledger is append-only and a mis-posting is
 *   cancelled by a REVERSAL transaction, but nothing in this milestone needs to
 *   reverse anything yet, and `FinancialTransaction` has no
 *   `@@unique([reversalOfId])` — so a reversal helper also owes a
 *   one-reversal-per-transaction guard, which is a decision better made by the
 *   milestone that first needs it than guessed at here.
 * - ~~No wiring.~~ Stale as of M3: `ledgerPostings.ts`'s eight posting
 *   functions now call `postFinancialTransaction` from every real order,
 *   payment, wallet and refund code path. A balance read off these tables is
 *   complete with respect to production traffic since that milestone landed,
 *   not just what tests posted.
 * - **No chart-of-accounts cache.** Each call batch-fetches the accounts it
 *   names. The chart is 15 rows and nothing hot calls this, so a cache would
 *   only add a staleness failure mode (a newly seeded account looking unknown)
 *   in exchange for nothing measurable.
 */
import { ValidationError } from "@app/core/errors";
import { LedgerAccountType, LedgerDirection } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { Decimal, money, moneyEq, ZERO } from "@app/core/money";
import type { FinancialTransaction } from "@prisma/client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";

/** One debit or credit line of a posting, as the caller describes it. */
export interface LedgerEntryInput {
  /** `LedgerAccount.code`, e.g. "cash.idr" — NOT the numeric id. */
  accountCode: string;
  /** DEBIT | CREDIT (`LedgerDirection`, @app/core/enums). */
  direction: LedgerDirection;
  /**
   * Always positive: the sign is carried by `direction`, never by this value.
   * Quantized to 4 decimal places on the way in, like every money value in this
   * repo (@app/core/money) — see `parseEntryAmount`.
   */
  amount: Decimal.Value;
  /**
   * "IDR" | "USDT" (`OrderCurrency`, @app/core/enums). Must equal the named
   * account's own `currency`; a mismatch is rejected rather than silently
   * trusting one over the other.
   */
  currency: string;
}

/** Everything one posted event needs. */
export interface PostFinancialTransactionArgs {
  /** `FinancialTransactionType` value (@app/core/enums). */
  type: string;
  /**
   * What business thing this event is about — "order" | "payment" |
   * "refund_execution" | "wallet_topup" | "manual". A free string, not an enum,
   * matching `AuditLog.targetType`'s precedent and FinancialTransaction's own
   * "intentionally UNTYPED back-pointer" doc comment: a general journal has to
   * be able to record an event against anything, including a purely manual
   * adjustment with no domain row at all.
   */
  referenceType: string;
  referenceId: number;
  /**
   * Caller-derived and globally unique — the retry guard. This service only
   * enforces uniqueness and non-blankness, never a shape (see
   * FinancialTransaction's own doc comment for the actual keys
   * `ledgerPostings.ts` derives). Posting the same key twice returns the
   * first posting instead of creating a second one or throwing.
   */
  idempotencyKey: string;
  /**
   * Human-readable summary for the admin-facing ledger view. Written as a
   * natural-language sentence, not `key=value` shorthand — same audience and
   * convention as `AuditLog.details` (docs/LOGGING.md).
   */
  description: string;
  /**
   * When the money moved in the real world (UTC). Not defaulted anywhere: a
   * backfilled or settlement posting must not be able to claim it happened at
   * import time. `postedAt` is set here, and is a different fact.
   */
  occurredAt: Date;
  entries: LedgerEntryInput[];
}

/** One line of a trial balance — an account and where it stands right now. */
export interface TrialBalanceRow {
  accountCode: string;
  accountType: string;
  currency: string;
  balance: Decimal;
}

/**
 * Account types whose balance RISES on a debit.
 *
 * `CLEARING` is listed here as a documented default rather than a claim: it is
 * normal-balance-agnostic by design, and the seeded chart of accounts contains
 * no `CLEARING` row precisely so no real account's sign depends on this guess
 * (Task 1 typed `provider_clearing.*` ASSET and `refund_clearing.*` LIABILITY
 * for exactly that reason — see `CHART_OF_ACCOUNTS`' doc comment). If a future
 * account is ever typed `CLEARING`, it reads debit-positive, which matches the
 * "money in transit we expect to receive" case.
 */
const DEBIT_NORMAL_TYPES: readonly string[] = [
  LedgerAccountType.ASSET,
  LedgerAccountType.EXPENSE,
  LedgerAccountType.CLEARING,
];

/** Account types whose balance RISES on a credit. */
const CREDIT_NORMAL_TYPES: readonly string[] = [
  LedgerAccountType.LIABILITY,
  LedgerAccountType.REVENUE,
  LedgerAccountType.EQUITY,
];

/**
 * Every `LedgerAccount.type` this service can assign a balance sign to — the
 * union of the two lists above, spelled as that union rather than as a third
 * hand-kept list so a type added to one of them cannot be accepted on write and
 * then rejected on read (or the reverse).
 */
const KNOWN_ACCOUNT_TYPES: readonly string[] = [...DEBIT_NORMAL_TYPES, ...CREDIT_NORMAL_TYPES];

/** Recognised `LedgerEntry.direction` values. */
const VALID_DIRECTIONS: readonly string[] = [LedgerDirection.DEBIT, LedgerDirection.CREDIT];

/** The two sides of one account's (or one currency group's) entries. */
interface DirectionSums {
  debit: Decimal;
  credit: Decimal;
}

/** An entry with its account resolved and its amount parsed — ready to insert. */
interface PreparedEntry {
  accountId: number;
  direction: string;
  amount: Decimal;
  currency: string;
}

const noSums = (): DirectionSums => ({ debit: ZERO, credit: ZERO });

/**
 * Parse and validate one entry amount: well-formed, finite, and strictly
 * positive AFTER quantizing to this repo's 4 decimal places.
 *
 * Same idiom as `refunds.ts`'s `parseRefundAmount` — a malformed `Decimal`
 * constructor throw is converted into a clean `ValidationError` so no raw
 * `[DecimalError] Invalid argument` ever escapes to a future route as an
 * unhandled 500 instead of a 422.
 *
 * The quantizing is not cosmetic. `ledger_entries.amount` is DECIMAL(65,30), so
 * it would happily store more precision than this repo's money type recognises,
 * while `moneyEq` (the balance check below) compares at 4 places — two legs
 * differing in the 5th decimal would pass the check and then be STORED unequal,
 * leaving a transaction whose own rows do not add up. Quantizing here means the
 * values compared are exactly the values written. It also makes an amount that
 * vanishes at 4 places (0.00001) a rejection rather than a stored 0, which would
 * have broken LedgerEntry's "amount is always positive" invariant.
 */
function parseEntryAmount(raw: Decimal.Value): Decimal {
  let amount: Decimal;
  try {
    amount = money(raw);
  } catch {
    throw new ValidationError("error.ledger_amount_invalid");
  }
  if (!amount.isFinite() || !amount.greaterThan(0)) {
    throw new ValidationError("error.ledger_amount_invalid");
  }
  return amount;
}

/**
 * The core double-entry invariant: within each currency, the DEBIT amounts and
 * the CREDIT amounts must sum to the same total.
 *
 * Currency groups are independent and are NEVER summed against each other. A
 * posting with an IDR leg and a USDT leg is valid as long as IDR balances
 * against IDR and USDT against USDT — this shop holds two unconvertible
 * balances (see `User.walletBalanceUsdt`'s "no cross-currency conversion" note),
 * so "100000 IDR == 6.25 USDT" is not a statement this codebase may make for any
 * purpose, including a balance check.
 *
 * A mismatch in ANY group rejects the WHOLE posting — the balanced groups are
 * not salvaged. They were written as one event by a caller that believed all of
 * it; posting the half that happens to add up would record a real-world event
 * that never occurred. The error names the first offending currency and both of
 * its sums, so the leg that is wrong is visible from the message alone.
 *
 * Uses `moneyEq`, not `Decimal.equals`, matching this repo's convention for
 * every money comparison: both sides are quantized to 4 places first, which is
 * the precision the amounts were parsed (and will be stored) at.
 */
function assertBalancedPerCurrency(entries: readonly PreparedEntry[]): void {
  const totals = new Map<string, DirectionSums>();
  for (const entry of entries) {
    const sums = totals.get(entry.currency) ?? noSums();
    if (entry.direction === LedgerDirection.DEBIT) {
      sums.debit = sums.debit.plus(entry.amount);
    } else {
      sums.credit = sums.credit.plus(entry.amount);
    }
    totals.set(entry.currency, sums);
  }

  // Map iteration is insertion-ordered, so the currency reported is the first
  // one that appears in `entries` and fails — deterministic across runs.
  for (const [currency, sums] of totals) {
    if (!moneyEq(sums.debit, sums.credit)) {
      throw new ValidationError("error.ledger_unbalanced", {
        currency,
        debitTotal: money(sums.debit).toString(),
        creditTotal: money(sums.credit).toString(),
      });
    }
  }
}

/**
 * Validate every entry and resolve each `accountCode` to an account id, or
 * throw. Runs entirely before the caller writes anything.
 *
 * Accounts are batch-fetched in ONE query keyed by `code: { in: [...] }` rather
 * than looked up per entry: a posting with a dozen legs would otherwise cost a
 * dozen round trips inside the critical path of a payment webhook.
 *
 * Five things are checked, and the account's own row supplies three of them —
 * which is why the `select` reads `isActive` and `type` as well as `currency`.
 * The account must exist, must not be RETIRED, and must carry a `type` this
 * service can assign a balance sign to; the entry's direction must be recognised
 * and its currency must match the account's. The retirement and type checks are
 * the two that used to be missing: both were enforced only on the READ side
 * (`trialBalance` omits retired accounts, `signedBalance` throws on an unknown
 * type), which meant a posting could be committed and then turn out to be
 * unreportable — an entry the books hold but cannot show.
 */
async function prepareEntries(db: Db, entries: readonly LedgerEntryInput[]): Promise<PreparedEntry[]> {
  if (entries.length === 0) {
    // A transaction with no entries is trivially "balanced" (0 == 0) and would
    // record a money event that moved no money — meaningless in the books and
    // invisible in every report.
    throw new ValidationError("error.ledger_entries_empty");
  }

  // Amounts first, so a malformed amount is reported as such even if the entry
  // also names an account that does not exist.
  const amounts = entries.map((entry) => parseEntryAmount(entry.amount));

  const codes = [...new Set(entries.map((entry) => entry.accountCode))];
  const accounts = await db.ledgerAccount.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true, currency: true, type: true, isActive: true },
  });
  const byCode = new Map(accounts.map((account) => [account.code, account] as const));

  return entries.map((entry, index) => {
    const account = byCode.get(entry.accountCode);
    if (!account) {
      // Not an internal error: posting sites name accounts as string constants,
      // so a typo or a chart-of-accounts row that was never seeded lands here.
      throw new ValidationError("error.ledger_account_not_found", { accountCode: entry.accountCode });
    }
    if (!account.isActive) {
      // `isActive: false` means an operator deliberately took this account out of
      // the books' current picture — `trialBalance` already omits it. Until now
      // nothing stopped a posting site still naming it, which produced the worst
      // of both worlds: the entry was written and counted by
      // `getAccountBalance`, but the account it landed on was invisible in the
      // trial balance, so the posting silently stopped adding up to the reported
      // cash position. Retirement has to mean retired on the write side too, or
      // it is only a display filter.
      throw new ValidationError("error.ledger_account_retired", {
        accountCode: entry.accountCode,
      });
    }
    if (!KNOWN_ACCOUNT_TYPES.includes(account.type)) {
      // Checked HERE, at write time, even though `signedBalance` checks the same
      // thing when a balance is read. `type` is a free String column, so a row
      // seeded by an older chart, restored from a dump, or edited by hand can
      // carry a value no reader can assign a sign to — and catching it only on
      // read means the posting is already committed by the time anyone finds
      // out, leaving an entry that cannot be reported at all. Refusing the write
      // keeps "every entry in this table can be read back" true.
      throw new ValidationError("error.ledger_account_type_unknown", {
        accountCode: entry.accountCode,
        accountType: String(account.type),
      });
    }
    if (!VALID_DIRECTIONS.includes(entry.direction)) {
      // The one bad input the balance check cannot catch by itself: an
      // unrecognised direction belongs to neither sum, so a posting made
      // entirely of them sums 0 == 0 and would look perfectly balanced while
      // moving money nowhere. `direction` is typed, but this service is the
      // ledger's only gate and a JS caller (or a JSON body) is not type-checked.
      throw new ValidationError("error.ledger_direction_invalid", {
        accountCode: entry.accountCode,
        direction: String(entry.direction),
      });
    }
    if (entry.currency !== account.currency) {
      // LedgerEntry invariant #3. Rejected rather than silently corrected to the
      // account's own currency: the caller's two statements disagree about what
      // was moved, and guessing which one it meant is how a USDT amount ends up
      // booked as rupiah.
      throw new ValidationError("error.ledger_currency_mismatch", {
        accountCode: entry.accountCode,
        entryCurrency: entry.currency,
        accountCurrency: account.currency,
      });
    }
    return {
      accountId: account.id,
      direction: entry.direction,
      amount: amounts[index]!,
      currency: entry.currency,
    };
  });
}

/**
 * Post one balanced, idempotent financial event: a `FinancialTransaction` and
 * its `LedgerEntry` children, written together or not at all.
 *
 * Order of operations, each step load-bearing:
 *
 * 1. **Idempotency check first.** An already-posted key returns its existing row
 *    immediately — no re-validation, no second insert, no throw. This is the
 *    "same operation ten times = one economic effect" guarantee the whole ledger
 *    rests on, and it must hold even if the retry's `entries` differ (a
 *    redelivered webhook carrying a corrected amount must NOT rewrite a posted
 *    event; that is what a REVERSAL is for).
 * 2. **Validate everything** (`prepareEntries`, `assertBalancedPerCurrency`)
 *    before the first write.
 * 3. **Write in one transaction**, so a failure cannot leave a transaction
 *    without its entries. `reversalOfId` is never set here — only a REVERSAL
 *    posting has one, and this milestone builds no reversal path.
 * 4. **Reclaim on the idempotency race.** Two callers posting the same key for
 *    the first time can both pass step 1 before either commits; the loser hits
 *    the unique index on `idempotency_key`, and what it does then is return the
 *    winner's row. The same "insert-first, reclaim-on-conflict" idiom the
 *    `Processed*Tx` tables already use for redelivered gateway callbacks.
 *
 * The reclaim happens OUTSIDE the transaction on purpose: a unique violation
 * aborts the Postgres transaction it occurred in, so re-reading on that same
 * connection would fail with "current transaction is aborted" instead of
 * returning the winner's row. Letting the transaction roll back first and then
 * re-reading is what makes the reclaim actually work.
 *
 * Accepts either the bare client or a caller's `tx` (`Db` is `PrismaClient |
 * Tx`), opening its own transaction only when given the former — a `Tx` cannot
 * nest one. Same detection as `adjustWallet`'s (./users.ts). One consequence is
 * documented rather than hidden: when the caller owns the transaction, a lost
 * idempotency race CANNOT be reclaimed, because the violation has already
 * aborted the caller's transaction and every later statement in it — including
 * the caller's own other writes — is doomed. The P2002 is rethrown so the
 * caller's transaction fails cleanly and can be retried whole, at which point
 * step 1 returns the winner's row.
 */
export async function postFinancialTransaction(
  db: Db,
  args: PostFinancialTransactionArgs,
): Promise<FinancialTransaction> {
  // Computed first because both refusal logs below fork their consequence
  // clause on it: whether a refusal has actually lost money or merely aborted a
  // still-open transaction turns on whether this call owns its transaction or
  // is nested inside a caller's.
  const ownsTransaction = "$transaction" in db && typeof db.$transaction === "function";

  if (args.idempotencyKey.trim() === "") {
    // A blank key is not "no key" — it is a key every other blank-key caller
    // shares, so the second such posting would be handed an unrelated
    // transaction as its own idempotent replay and would silently skip writing
    // real money.
    //
    // Unlike `error.ledger_account_not_found`, this error is NOT swallowed by
    // `postOrSkipMissingAccount`, so a nested call's caller transaction aborts
    // with it — "the event needs a manual entry" is only true when this call
    // owns its own transaction and the money has therefore already moved.
    const e = new ValidationError("error.ledger_idempotency_key_required");
    const consequence = ownsTransaction
      ? "the money this event describes has already moved, so the books now understate it and need a manual entry once the posting site is corrected"
      : "this call was nested inside the caller's own transaction, so that transaction — and any money movement it already made — was rolled back with it; nothing needs a manual entry, only a retry once the posting site is corrected";
    logger.error(
      { err: e },
      `Refused to post the ${args.type} ledger transaction for ${args.referenceType} ${args.referenceId} because it arrived with a blank idempotency key, and wrote nothing at all — a blank key is shared by every other caller that leaves it blank, so accepting it would eventually hand one event's posting back to an unrelated one as its own replay. Whichever posting site built this key is the bug; ${consequence}.`,
    );
    throw e;
  }

  const alreadyPosted = await db.financialTransaction.findUnique({
    where: { idempotencyKey: args.idempotencyKey },
  });
  if (alreadyPosted) {
    // The idempotency guard working, not a fault: every payment rail in this
    // shop is at-least-once, so a posting site asking twice is ordinary
    // operation. Logged at `info` for exactly the reason
    // `PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED` is (@app/core/payments/
    // logEvents) — logging the expected case as a warning teaches whoever reads
    // these logs to ignore warnings.
    logger.info(
      { idempotencyKey: args.idempotencyKey, financialTransactionId: alreadyPosted.id },
      `Posted nothing new to the ledger for the ${args.type} event on ${args.referenceType} ${args.referenceId}, because financial transaction ${alreadyPosted.id} already records it under the same idempotency key — the existing posting is returned unchanged, so the event is recognised once however many times it is replayed`,
    );
    return alreadyPosted;
  }

  let prepared: PreparedEntry[];
  try {
    prepared = await prepareEntries(db, args.entries);
    assertBalancedPerCurrency(prepared);
  } catch (e) {
    // `error.ledger_account_not_found` is additionally caught and logged by
    // `postOrSkipMissingAccount` (./ledgerPostings.ts) one layer up. That
    // overlap is deliberate rather than a duplicate: this line records that the
    // ledger service itself refused the posting and carries the error, while
    // that one names the business event and what an admin has to do about it.
    //
    // The consequence clause forks on three things a blanket "money already
    // moved, hand-post an entry" sentence gets wrong on real paths: (a) not
    // every rejection here is a validation failure — `prepareEntries` reads the
    // chart of accounts first, so a connection reset or timeout lands in this
    // same catch and is not a caller bug; (b) when this call is nested inside a
    // caller's own transaction (executeRefund's payout, for one), throwing here
    // NORMALLY aborts that whole transaction — including whatever money
    // movement it had already made — so nothing was actually kept, and
    // hand-posting an entry would fabricate one for a payout that never
    // happened; (c) the one exception to (b): `error.ledger_account_not_found`
    // specifically is caught and SWALLOWED one layer up by
    // `postOrSkipMissingAccount` (./ledgerPostings.ts), which is exactly what
    // makes the overlap noted above deliberate — that catch does not rethrow,
    // so the caller's transaction is still healthy and its own money movement
    // DOES commit even though this call is nested. A blanket "nothing needs a
    // manual entry" for every nested case would be false for that one, most
    // common failure (an unseeded chart of accounts).
    const isValidation = e instanceof ValidationError;
    const isMissingAccount = e instanceof ValidationError && e.key === "error.ledger_account_not_found";
    const consequence = ownsTransaction
      ? "the money this event describes has already moved, so the books now understate it and need a manual entry once the posting site is corrected"
      : isMissingAccount
        ? "this call was nested inside the caller's own transaction — if that caller swallows a missing ledger account and continues (see postOrSkipMissingAccount), its own money movement still committed and needs a manual entry once the account is seeded; if it does not, its transaction rolled back with this one and nothing needs a manual entry"
        : "this call was nested inside the caller's own transaction, so that transaction — and any money movement it already made — was rolled back with it; nothing needs a manual entry, only a retry once the posting site is corrected";
    logger.error(
      { err: e, idempotencyKey: args.idempotencyKey },
      isValidation
        ? `Refused to post the ${args.type} ledger transaction for ${args.referenceType} ${args.referenceId} because it did not pass validation, and wrote nothing at all — ${consequence}`
        : `Failed to post the ${args.type} ledger transaction for ${args.referenceType} ${args.referenceId} because reading the chart of accounts for it failed, and wrote nothing at all — ${consequence}`,
    );
    throw e;
  }

  const write = async (trx: Db): Promise<FinancialTransaction> => {
    const transaction = await trx.financialTransaction.create({
      data: {
        type: args.type,
        referenceType: args.referenceType,
        referenceId: args.referenceId,
        idempotencyKey: args.idempotencyKey,
        description: args.description,
        occurredAt: args.occurredAt,
        // When the books learned about it, as opposed to when it happened. The
        // column defaults to now() anyway; set explicitly so the row's meaning
        // does not depend on the database clock of whoever deploys this.
        postedAt: new Date(),
      },
    });
    // `createMany` is workable because every `accountId` was resolved by the
    // batch fetch above, so no child needs a nested write to discover its
    // parent — one INSERT for all legs instead of one per leg.
    await trx.ledgerEntry.createMany({
      data: prepared.map((entry) => ({
        financialTransactionId: transaction.id,
        accountId: entry.accountId,
        direction: entry.direction,
        amount: entry.amount,
        currency: entry.currency,
      })),
    });
    return transaction;
  };

  // A `Tx` has no `$transaction` (Prisma strips it from the interactive
  // transaction client), so its presence is what distinguishes the bare client
  // from a caller-owned transaction. Same check as ./users.ts's `adjustWallet`.
  // (Computed above, before the validation catch, which needs it too.)
  try {
    const posted = ownsTransaction ? await db.$transaction(write) : await write(db);
    // Says "wrote", not "committed", and adds the caveat below when the caller
    // owns the transaction: at this line a caller-owned posting is real only
    // inside that caller's still-open transaction, and a line claiming the
    // books recorded an event must not outlive a rollback that took it away.
    // `refunds.ts`'s own payout log makes the same distinction by waiting for
    // the commit; this service cannot wait, because it does not own the commit.
    logger.info(
      { idempotencyKey: args.idempotencyKey, financialTransactionId: posted.id },
      `Wrote the ${args.type} event on ${args.referenceType} ${args.referenceId} to the ledger as financial transaction ${posted.id}, balanced across ${prepared.length} entries: ${args.description}` +
        (ownsTransaction ? "" : " (inside the calling transaction, so it becomes final only when that transaction commits)"),
    );
    return posted;
  } catch (e) {
    if (!isUniqueViolation(e) || !ownsTransaction) throw e;
    // The only unique constraint these two tables carry is
    // `ix_financial_tx_idempotency_key`, and the re-read confirms it: a row now
    // exists under our key, so a concurrent caller posted this same event while
    // we were validating. That is the guard working, not a fault.
    const raced = await db.financialTransaction.findUnique({
      where: { idempotencyKey: args.idempotencyKey },
    });
    if (raced) {
      logger.info(
        { idempotencyKey: args.idempotencyKey, financialTransactionId: raced.id },
        `Posted nothing new to the ledger for the ${args.type} event on ${args.referenceType} ${args.referenceId}, because a concurrent caller wrote financial transaction ${raced.id} for the same idempotency key while this one was still validating — that caller's posting is returned instead, so the two racing callers still produced exactly one entry in the books`,
      );
      return raced;
    }
    throw e;
  }
}

/**
 * Sum the debits and credits of every entry belonging to the given accounts, as
 * ONE aggregate query.
 *
 * `groupBy` rather than fetching rows and adding them up in JS: `ledger_entries`
 * grows without bound (every payment, refund and settlement adds rows forever),
 * so a balance read that transfers the whole history would degrade silently and
 * without limit. Accounts with no entries are simply absent from the result —
 * callers substitute zero.
 */
async function sumsByAccount(db: Db, accountIds: readonly number[]): Promise<Map<number, DirectionSums>> {
  const grouped = await db.ledgerEntry.groupBy({
    by: ["accountId", "direction"],
    where: { accountId: { in: [...accountIds] } },
    _sum: { amount: true },
  });

  const byAccount = new Map<number, DirectionSums>();
  for (const row of grouped) {
    const sums = byAccount.get(row.accountId) ?? noSums();
    const total = money(row._sum.amount?.toString() ?? 0);
    if (row.direction === LedgerDirection.DEBIT) {
      sums.debit = sums.debit.plus(total);
    } else if (row.direction === LedgerDirection.CREDIT) {
      sums.credit = sums.credit.plus(total);
    }
    // Any other `direction` value cannot have been written by this service (see
    // `prepareEntries`), and counting it on either side would misstate the
    // balance — so it is left out, and the balance reads as if the row is not
    // there rather than as if it were a debit.
    byAccount.set(row.accountId, sums);
  }
  return byAccount;
}

/**
 * Turn one account's debit/credit sums into the signed balance its type implies.
 *
 * The single place this codebase decides what a balance's sign MEANS — both
 * `getAccountBalance` and `trialBalance` route through it, so the two can never
 * drift into reporting the same account with opposite signs.
 *
 * Debit-normal accounts (ASSET, EXPENSE, CLEARING) read `debits - credits`;
 * credit-normal ones (LIABILITY, REVENUE, EQUITY) read `credits - debits`. So a
 * DEBIT increases `cash.idr` (ASSET) and DECREASES `wallet_liability.idr`
 * (LIABILITY), which is the accounting convention and the reason
 * `LedgerAccount.type` exists.
 *
 * The result is SIGNED, not absolute: an ASSET account credited beyond its
 * debits is genuinely negative, and reporting that as a positive number would
 * hide exactly the kind of bug a trial balance is read to find.
 *
 * An unrecognised `type` throws instead of defaulting. Defaulting would pick a
 * sign for an account nobody classified and report a confidently wrong balance —
 * the one outcome worse than an error here.
 */
function signedBalance(account: { code: string; type: string }, sums: DirectionSums): Decimal {
  if (DEBIT_NORMAL_TYPES.includes(account.type)) return money(sums.debit.minus(sums.credit));
  if (CREDIT_NORMAL_TYPES.includes(account.type)) return money(sums.credit.minus(sums.debit));
  throw new ValidationError("error.ledger_account_type_unknown", {
    accountCode: account.code,
    accountType: account.type,
  });
}

/**
 * One account's current balance, signed per its type (see `signedBalance`).
 *
 * Reads the whole history of the account every call — there is no running-total
 * column to go stale, which is the point: the entries ARE the balance, and a
 * cached total that disagrees with them is unfixable without knowing which one
 * lied. Cheap because the sum happens in Postgres.
 *
 * Throws if `accountCode` names no account, rather than returning zero: "this
 * account has no entries" and "there is no such account" are different answers,
 * and a typo'd code silently reading 0.00 would make a reconciliation report
 * look clean.
 */
export async function getAccountBalance(db: Db, accountCode: string): Promise<Decimal> {
  const account = await db.ledgerAccount.findUnique({
    where: { code: accountCode },
    select: { id: true, code: true, type: true },
  });
  if (!account) throw new ValidationError("error.ledger_account_not_found", { accountCode });

  const sums = (await sumsByAccount(db, [account.id])).get(account.id) ?? noSums();
  return signedBalance(account, sums);
}

/**
 * Every ACTIVE account of one currency with its current balance — "show me
 * where the money is right now", ordered by `code` so successive reads are
 * comparable line by line.
 *
 * Read-only, for the reconciliation milestone and for manual admin inspection.
 *
 * NO PRODUCTION CALLER TODAY — exported and covered by tests, but no route, job
 * or admin page renders it yet (`reconcileLedger` uses `getAccountBalance` for
 * the one control account it checks, not this). Noted so a reader does not assume
 * an admin is looking at these numbers somewhere. Worth knowing before trusting
 * them: with no SETTLEMENT posting in the system, `cash.*` only ever goes
 * negative and `provider_clearing.*` never drains, so a trial balance rendered
 * today would show a structurally misleading cash position — see the ledger's
 * open design questions, not a bug in this function.
 *
 * It does NOT assert that debits equal credits across accounts: that property is
 * true by construction, because `postFinancialTransaction` refuses to write an
 * unbalanced posting in the first place. A trial balance that does not balance
 * is therefore a signal about the posting service (or about rows written around
 * it), which is information to report, not to throw away by refusing to render.
 *
 * Retired accounts (`isActive: false`) are omitted — an admin retired them from
 * the books' current picture on purpose; their entries stay readable through
 * `getAccountBalance`, which takes any code.
 *
 * One aggregate query for all of them, not one per account: this is exactly the
 * N+1 a per-account loop over `getAccountBalance` would have been, and the sign
 * logic is shared through `signedBalance` instead.
 */
export async function trialBalance(db: Db, currency: string): Promise<TrialBalanceRow[]> {
  const accounts = await db.ledgerAccount.findMany({
    where: { currency, isActive: true },
    select: { id: true, code: true, type: true, currency: true },
    orderBy: { code: "asc" },
  });
  if (accounts.length === 0) return [];

  const sums = await sumsByAccount(
    db,
    accounts.map((account) => account.id),
  );

  return accounts.map((account) => ({
    accountCode: account.code,
    accountType: account.type,
    currency: account.currency,
    balance: signedBalance(account, sums.get(account.id) ?? noSums()),
  }));
}
