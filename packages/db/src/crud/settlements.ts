/**
 * Provider settlement ingestion (task F1) — the missing caller for
 * `postSettlementPosting`.
 *
 * ## Why this file exists
 *
 * The double-entry ledger books every sale as `Dr provider_clearing / Cr
 * sales_revenue`: the gateway has collected the buyer's money but has not yet
 * paid it out to the shop. Nothing credited `provider_clearing` back, because
 * nothing in this codebase ever recorded a provider PAYING OUT — the
 * `Settlement`/`SettlementTransaction` models shipped as schema only (decision
 * D1's "NO PRODUCTION CALLER TODAY", known gap 6 in
 * docs/arsitektur/FINANCE_ARCHITECTURE.md). The consequence is not a rounding error: the
 * receivable grows without bound while `cash.*` is only ever debited by a
 * manual-transfer refund, so the account named "Cash" trends monotonically
 * NEGATIVE and neither account can be read as a cash position.
 *
 * `recordSettlement` closes that loop. An admin reads a provider's own payout
 * statement and enters the batch; this writes the `Settlement` row, its
 * `SettlementTransaction` lines, the `SETTLEMENT` posting and the audit row **in
 * one transaction**, so all four exist or none does. That atomicity is the whole
 * point and is not a convenience: the ledger is append-only, so a batch row
 * saved without its posting would understate `cash.*` permanently with nothing
 * to notice it, and a posting saved without its batch row would be an entry an
 * admin cannot trace to any statement.
 *
 * ## Why it refuses rather than repairs
 *
 * Unlike the postings in `ledgerPostings.ts` — which run after a buyer's money
 * has already moved, and therefore log-and-skip rather than strand a paid order
 * over a bookkeeping gap — this runs while an admin is typing a record in. The
 * money has already settled at the bank either way; nothing is in flight. So the
 * honest response to a batch whose three figures contradict each other, or whose
 * currency this shop keeps no accounts in, is to reject the entry and say which
 * figures disagree. `postSettlementPosting` would reject an inconsistent batch
 * itself (and the transaction would roll the rows back), but validating here
 * first means the admin gets the error before any row is written and the message
 * names the amounts rather than a debit total against a credit total.
 *
 * ## Deliberately NOT deduplicated on `batchReference`
 *
 * That column is admin-typed free text from an external system and the schema
 * leaves it non-unique on purpose. Two genuinely different batches can share
 * one, so keying on it would swallow a real second payout as a replay. Each
 * batch is posted exactly once under `settlement:{id}` — its own row id — which
 * is what makes a retried route call safe without making a reused statement id
 * unrecordable. See `settlementKey`'s comment in `ledgerPostings.ts`.
 */
import { OrderCurrency, PaymentMethod, SettlementStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { quantizeMoney } from "@app/core/formatters";
import { logger } from "@app/core/logger";
import { Decimal, ZERO } from "@app/core/money";
import type { FinancialTransaction, Settlement } from "@prisma/client";
import type { Db } from "./_types";
import { logAdminAction } from "./audit";
import { postSettlementPosting } from "./ledgerPostings";

const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);

const PROVIDERS = Object.values(PaymentMethod) as string[];
/**
 * The currencies the chart of accounts actually holds `cash.*`,
 * `payment_fee.*` and `provider_clearing.*` rows for. A batch in any other
 * currency has no account to post to, and `postSettlementPosting` would
 * log-and-skip it — leaving a `Settlement` row with no posting, which is
 * precisely the half-written state this file exists to prevent. So it is
 * refused up front instead.
 */
const CURRENCIES = Object.values(OrderCurrency) as string[];

/**
 * One line of a provider's statement, as an admin enters it.
 *
 * `paymentId` and `providerTransactionId` are two ways of naming the same thing
 * and both are optional. An admin reading a statement has the PROVIDER's own
 * transaction id in front of them, not this shop's internal `Payment.id`, so
 * that is the field the UI fills; `paymentId` stays available for an importer
 * that already resolved the match. Neither being present is a first-class case,
 * not an error — see `resolveLineMatch`.
 */
export interface SettlementLineInput {
  amount: Decimal.Value;
  /** The provider's own id for this line, matched against
   *  `Payment.providerTransactionId` within the batch's provider. */
  providerTransactionId?: string | null;
  /** An already-resolved internal `Payment.id`. Takes precedence when both are given. */
  paymentId?: number | null;
}

export interface RecordSettlementArgs {
  /** `PaymentMethod` value — which gateway paid this batch out. */
  provider: string;
  /** The provider's own statement/payout id, or null when it gives none. */
  batchReference?: string | null;
  /** When the PROVIDER settled the batch (UTC) — this posting's `occurredAt`. */
  settlementDate: Date;
  currency: string;
  /** What the provider collected from buyers in this batch, before its cut. */
  grossAmount: Decimal.Value;
  /** The provider's total cut. Zero is a real answer, not "unknown". */
  feeAmount: Decimal.Value;
  /** What actually landed in the shop's own account. */
  netAmount: Decimal.Value;
  /** The admin entering the batch — `Settlement.createdBy` and the audit actor. */
  adminId: number;
  lines?: SettlementLineInput[];
}

export interface RecordSettlementResult {
  settlement: Settlement;
  /**
   * The `SETTLEMENT` posting. Null only if the chart of accounts is unseeded in
   * this environment, which `postSettlementPosting` logs loudly and skips
   * (`postOrSkipMissingAccount`) — the batch row is still recorded and
   * `pnpm backfill-ledger-history` does not cover settlements, so that case is
   * re-posted by re-entering the batch after seeding. The currency guard above
   * makes the far more likely cause of a missing account impossible to reach.
   */
  posting: FinancialTransaction | null;
}

/**
 * A money field an admin typed, as a `Decimal`, or a refusal.
 *
 * `new Decimal("NaN")` and `new Decimal("Infinity")` both CONSTRUCT rather than
 * throw, so a finiteness check is not optional here — the same trap the wallet
 * adjustment route documents (M-3, backend audit 2026-07-31). An unchecked
 * non-finite amount would reach `quantizeMoney` and from there a money column.
 */
function money(raw: Decimal.Value, field: string): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(raw);
  } catch {
    throw new ValidationError("error.settlement_amount_not_a_number", { field });
  }
  if (!parsed.isFinite()) {
    throw new ValidationError("error.settlement_amount_not_a_number", { field });
  }
  return q4(parsed);
}

/**
 * Which `Payment` a line settles, or null when it settles one this shop has no
 * row for.
 *
 * An unmatched line is RECORDED, never refused: a provider reporting money
 * against a transaction id this shop has never seen is exactly the discrepancy
 * reconciliation exists to surface (see `SettlementTransaction`'s own doc
 * comment), and refusing it would make the finding unrecordable — or worse,
 * invite matching it to the wrong payment to satisfy the constraint.
 *
 * The lookup is scoped to the batch's own provider because that is the shape of
 * the uniqueness guarantee: `@@unique([method, providerTransactionId])`. A bare
 * `providerTransactionId` lookup could match another gateway's identically
 * numbered transaction.
 */
async function resolveLineMatch(
  db: Db,
  provider: string,
  line: SettlementLineInput,
): Promise<number | null> {
  if (line.paymentId != null) return line.paymentId;
  const reference = line.providerTransactionId?.trim();
  if (!reference) return null;
  const payment = await db.payment.findUnique({
    where: { method_providerTransactionId: { method: provider, providerTransactionId: reference } },
    select: { id: true },
  });
  return payment?.id ?? null;
}

/**
 * Record one provider payout batch an admin read off the provider's statement,
 * and book it: `Dr cash.<ccy>` (net) + `Dr payment_fee.<ccy>` (fee) / `Cr
 * provider_clearing.<ccy>` (gross).
 *
 * Every write happens in one transaction — the batch, its lines, the posting and
 * the audit row — so a refusal from any of them leaves the database exactly as
 * it was. When the caller already owns a transaction (the web-admin route does),
 * theirs is reused: a `Tx` cannot nest another, and the caller's scope is the one
 * that matters anyway.
 */
export async function recordSettlement(
  db: Db,
  args: RecordSettlementArgs,
): Promise<RecordSettlementResult> {
  // ── Validate before writing anything ───────────────────────────────────
  if (!PROVIDERS.includes(args.provider)) {
    throw new ValidationError("error.settlement_provider_unknown", { provider: args.provider });
  }
  const currency = args.currency.toUpperCase();
  if (!CURRENCIES.includes(currency)) {
    throw new ValidationError("error.settlement_currency_unknown", { currency });
  }
  if (Number.isNaN(args.settlementDate.getTime())) {
    throw new ValidationError("error.settlement_date_invalid");
  }

  const gross = money(args.grossAmount, "grossAmount");
  const fee = money(args.feeAmount, "feeAmount");
  const net = money(args.netAmount, "netAmount");

  if (!gross.greaterThan(0)) {
    throw new ValidationError("error.settlement_gross_not_positive", {
      grossAmount: gross.toString(),
      currency,
    });
  }
  if (fee.isNegative() || net.isNegative()) {
    throw new ValidationError("error.settlement_amounts_invalid", {
      grossAmount: gross.toString(),
      feeAmount: fee.toString(),
      netAmount: net.toString(),
      currency,
    });
  }
  // Compared on values already quantized to this repo's four places, so this is
  // `moneyEq` in effect and cannot fire on a representation artefact in the
  // fifth decimal. Refused HERE as well as in `postSettlementPosting` so the
  // admin sees the three amounts that disagree before a row is written; the
  // posting's own copy stays as the guard for any future caller.
  if (!net.plus(fee).equals(gross)) {
    throw new ValidationError("error.settlement_amounts_inconsistent", {
      grossAmount: gross.toString(),
      feeAmount: fee.toString(),
      netAmount: net.toString(),
      currency,
    });
  }

  const lineInputs = args.lines ?? [];
  let lineTotal = ZERO;
  const lineAmounts: Decimal[] = [];
  for (const [index, line] of lineInputs.entries()) {
    const amount = money(line.amount, `lines[${index}].amount`);
    if (!amount.greaterThan(0)) {
      throw new ValidationError("error.settlement_line_amount_invalid", {
        amount: amount.toString(),
        currency,
      });
    }
    lineAmounts.push(amount);
    lineTotal = lineTotal.plus(amount);
  }
  // Lines are the batch BROKEN DOWN, so they cannot total more than it. Under is
  // fine and expected — a partly itemised statement is normal, and the schema's
  // RECONCILED status is what "the lines now account for the net" means. Over is
  // a typo, and recording it would put a breakdown in the books that contradicts
  // the total posted beside it.
  if (lineTotal.greaterThan(gross)) {
    throw new ValidationError("error.settlement_lines_exceed_gross", {
      lineTotal: lineTotal.toString(),
      grossAmount: gross.toString(),
      currency,
    });
  }

  const batchReference = args.batchReference?.trim() || null;

  const write = async (tx: Db): Promise<RecordSettlementResult> => {
    const settlement = await tx.settlement.create({
      data: {
        provider: args.provider,
        batchReference,
        settlementDate: args.settlementDate,
        currency,
        grossAmount: gross,
        feeAmount: fee,
        netAmount: net,
        status: SettlementStatus.RECORDED,
        createdBy: args.adminId,
      },
    });

    // Sequential rather than a `createMany`: each line may need its own Payment
    // lookup, and the rows are few (one statement's worth).
    let matched = 0;
    for (const [index, line] of lineInputs.entries()) {
      const paymentId = await resolveLineMatch(tx, args.provider, line);
      if (paymentId !== null) matched += 1;
      await tx.settlementTransaction.create({
        data: {
          settlementId: settlement.id,
          paymentId,
          amount: lineAmounts[index]!,
          currency,
          // Stamped only when a match was actually made — `matchedAt` is null
          // for exactly the unmatched lines, which is how reconciliation finds
          // them.
          matchedAt: paymentId === null ? null : new Date(),
        },
      });
    }

    const posting = await postSettlementPosting(tx, {
      id: settlement.id,
      provider: settlement.provider,
      batchReference: settlement.batchReference,
      currency: settlement.currency,
      grossAmount: settlement.grossAmount,
      feeAmount: settlement.feeAmount,
      netAmount: settlement.netAmount,
      settlementDate: settlement.settlementDate,
    });

    const batchLabel = batchReference ? `batch ${batchReference}` : `batch #${settlement.id}`;
    const lineSentence =
      lineInputs.length === 0
        ? "No individual statement lines were entered."
        : `Entered ${lineInputs.length} statement ${lineInputs.length === 1 ? "line" : "lines"}, of which ${matched} ${matched === 1 ? "was matched" : "were matched"} to a payment in this shop.`;
    await logAdminAction(tx, {
      adminId: args.adminId,
      action: "settlement_record",
      targetType: "settlement",
      targetId: settlement.id,
      details: `Recorded a ${args.provider} payout ${batchLabel} settled on ${settlement.settlementDate.toISOString().slice(0, 10)}: ${gross.toString()} ${currency} collected from buyers, ${fee.toString()} ${currency} kept by the provider as fees, and ${net.toString()} ${currency} received into the shop's account. ${lineSentence}`,
    });

    return { settlement, posting };
  };

  // A `Tx` has no `$transaction` (Prisma strips it from the interactive
  // transaction client), so its presence is what distinguishes the bare client
  // from a caller-owned transaction — the same test `adjustWallet` uses.
  const ownsTransaction = "$transaction" in db && typeof db.$transaction === "function";
  const result = ownsTransaction
    ? await (db as { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> }).$transaction(write)
    : await write(db);

  logger.info(
    { settlementId: result.settlement.id, postingId: result.posting?.id ?? null },
    `Admin ${args.adminId} recorded a ${args.provider} settlement batch of ${gross.toString()} ${currency}, of which ${net.toString()} reached the shop's own account and ${fee.toString()} was the provider's cut. The matching double-entry posting ${result.posting ? "was made, so this batch has drained that much out of the provider clearing account" : "could NOT be made because the chart of accounts is missing an account this currency needs — run \"pnpm seed-chart-of-accounts\" and enter the batch again, because the cash position stays understated until it is posted"}.`,
  );
  return result;
}

/** One batch as the admin list reads it. */
export interface SettlementRow {
  id: number;
  provider: string;
  batchReference: string | null;
  settlementDate: Date;
  currency: string;
  grossAmount: Decimal;
  feeAmount: Decimal;
  netAmount: Decimal;
  status: string;
  createdBy: number;
  createdAt: Date;
  /** How many statement lines were entered for this batch. */
  lineCount: number;
  /** How many of those lines matched a `Payment` in this shop. */
  matchedLineCount: number;
  /**
   * The `SETTLEMENT` posting's id, or null when the batch was recorded but not
   * posted (an unseeded chart of accounts — see `RecordSettlementResult`). Shown
   * in the list because an unposted batch is the one state an admin has to act
   * on, and it is invisible from the batch row alone.
   */
  postingId: number | null;
}

export interface ListSettlementsFilter {
  provider?: string | null;
  currency?: string | null;
  limit?: number;
  offset?: number;
}

export interface ListSettlementsResult {
  rows: SettlementRow[];
  total: number;
  /** Providers that actually have a batch recorded, so a filter dropdown cannot
   *  offer one that would always come back empty. */
  providers: string[];
  /** The currencies a batch may be entered in — the chart of accounts' own list,
   *  not whatever happens to have been recorded so far. */
  currencies: string[];
}

/**
 * Recorded payout batches, newest settlement date first.
 *
 * Ordered by `settlementDate` rather than `createdAt` because that is the date
 * the money moved, and an admin entering last month's statement today must not
 * see it jump to the top of a list they read as a payout timeline. `id` breaks
 * ties so two batches settled the same day come out in a stable order.
 */
export async function listSettlements(
  db: Db,
  filter: ListSettlementsFilter,
): Promise<ListSettlementsResult> {
  const where: Record<string, unknown> = {};
  if (filter.provider) where.provider = filter.provider;
  if (filter.currency) where.currency = filter.currency.toUpperCase();

  const take = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const skip = Math.max(filter.offset ?? 0, 0);

  const [batches, total, providerGroups] = await Promise.all([
    db.settlement.findMany({
      where,
      orderBy: [{ settlementDate: "desc" }, { id: "desc" }],
      take,
      skip,
      include: { transactions: { select: { paymentId: true } } },
    }),
    db.settlement.count({ where }),
    db.settlement.groupBy({ by: ["provider"], orderBy: { provider: "asc" } }),
  ]);

  // One bulk read for every posting on this page, rather than a lookup per row.
  const postings = batches.length
    ? await db.financialTransaction.findMany({
        where: { referenceType: "settlement", referenceId: { in: batches.map((b) => b.id) } },
        select: { id: true, referenceId: true },
      })
    : [];
  const postingByBatch = new Map(postings.map((p) => [p.referenceId, p.id]));

  return {
    rows: batches.map((batch) => ({
      id: batch.id,
      provider: batch.provider,
      batchReference: batch.batchReference,
      settlementDate: batch.settlementDate,
      currency: batch.currency,
      grossAmount: new Decimal(batch.grossAmount),
      feeAmount: new Decimal(batch.feeAmount),
      netAmount: new Decimal(batch.netAmount),
      status: batch.status,
      createdBy: batch.createdBy,
      createdAt: batch.createdAt,
      lineCount: batch.transactions.length,
      matchedLineCount: batch.transactions.filter((line) => line.paymentId !== null).length,
      postingId: postingByBatch.get(batch.id) ?? null,
    })),
    total,
    providers: providerGroups.map((group) => group.provider),
    currencies: [...CURRENCIES],
  };
}
