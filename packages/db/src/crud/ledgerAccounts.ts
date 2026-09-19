/**
 * Chart of accounts (Financial Ledger M1) — the canonical LedgerAccount rows
 * every ledger posting is made against, and the idempotent seed that installs
 * them.
 *
 * The list below is the SOURCE OF TRUTH for which accounts exist, not the
 * database: `LedgerAccount.code` (not its autoincrement `id`) is what posting
 * code refers to, precisely so this seed can run against a fresh database and
 * an already-seeded one and leave posting code working either way.
 *
 * Deliberately NOT in this file: anything that posts to the ledger — that's
 * `packages/db/src/crud/ledger.ts`'s `postFinancialTransaction` (the ledger's
 * only writer, since M2) and its callers in `ledgerPostings.ts` (wired to
 * every real order/payment/wallet/refund path since M3). This file only
 * installs the buckets they post into.
 */
import { LedgerAccountType, OrderCurrency } from "@app/core/enums";
import type { Db } from "./_types";

/** One chart-of-accounts row, as declared by the seed. */
export interface ChartOfAccountsEntry {
  /** Stable `<purpose>.<currency>` identifier, e.g. "cash.idr". */
  code: string;
  /** Display-only label; safe to reword without touching posting code. */
  name: string;
  type: LedgerAccountType;
  currency: OrderCurrency;
}

/**
 * The canonical chart of accounts.
 *
 * Most purposes exist once per currency because this shop holds two
 * unconvertible balances (see `User.walletBalanceUsdt`'s "no cross-currency
 * conversion" note) and a single mixed-currency account could only report a
 * meaningless sum. `referral_expense` is the one exception — it has a USDT row
 * only, because `maybePayReferralCommission` (crud/referrals.ts) always pays
 * commission into the referrer's USDT balance: it converts an IDR order's total
 * through the order's `fxRate` snapshot first and skips the commission entirely
 * when no rate is available, precisely so a Rupiah figure can never land in a
 * USDT wallet. An IDR twin would therefore be an account nothing can ever
 * legitimately post to.
 *
 * That referral row is an EXPENSE, not a liability. M1 first seeded it as
 * `referral_payable.idr` (LIABILITY, IDR), which was wrong twice over: wrong
 * currency, as above, and wrong type. A commission is paid by crediting the
 * referrer's wallet, and that credit already recognises a liability through
 * `wallet_liability.usdt` — booking a second liability for the same money would
 * count the shop's obligation twice and would never be discharged by anything.
 * What the commission actually is, for the shop, is a cost of acquiring the
 * referred buyer: the same shape as `payment_fee.*`. So the posting is
 * `Dr referral_expense.usdt / Cr wallet_liability.usdt` (crud/ledgerPostings.ts),
 * which recognises the cost and the obligation exactly once each.
 *
 * The `*_clearing` accounts are what make money-in-transit expressible at all:
 * funds a gateway has taken from the buyer but not yet paid out to us sit in
 * `provider_clearing.*` rather than being counted as `cash.*`, and an approved
 * but not-yet-paid refund sits in `refund_clearing.*`. Both are expected to
 * trend back to zero; a persistent balance on one is the signal that something
 * never settled.
 *
 * The two clearing purposes are NOT both typed `CLEARING`, even though that
 * type exists, because money in transit is still somebody's asset or somebody's
 * liability and a trial balance can only balance if each side is classified by
 * its actual normal balance:
 *
 * - `provider_clearing.*` is an ASSET (debit-normal). It is money a gateway has
 *   collected and now owes us — a receivable we expect to convert into
 *   `cash.*`. A sale posts `Dr provider_clearing / Cr sales_revenue`, so the
 *   balance sits on the debit side.
 * - `refund_clearing.*` is a LIABILITY (credit-normal). It is money we owe a
 *   buyer once a refund is approved but before it is paid out: approval posts
 *   `Cr refund_clearing` and the payout posts `Dr refund_clearing`, so the
 *   balance sits on the credit side.
 *
 * Typing both as the normal-balance-agnostic `CLEARING` would leave a future
 * trial-balance or reconciliation report to guess a sign, and it would get one
 * of the two backwards. The "expected to trend to zero" property that motivates
 * the `CLEARING` type is a monitoring concern, and it is preserved here by the
 * `*_clearing` code prefix, which is what such a report should key off.
 */
export const CHART_OF_ACCOUNTS: readonly ChartOfAccountsEntry[] = [
  {
    code: "provider_clearing.idr",
    name: "Provider Clearing (IDR)",
    // Debit-normal: a receivable from the gateway. See the doc comment above.
    type: LedgerAccountType.ASSET,
    currency: OrderCurrency.IDR,
  },
  {
    code: "provider_clearing.usdt",
    name: "Provider Clearing (USDT)",
    // Debit-normal: a receivable from the gateway. See the doc comment above.
    type: LedgerAccountType.ASSET,
    currency: OrderCurrency.USDT,
  },
  {
    code: "cash.idr",
    name: "Cash (IDR)",
    type: LedgerAccountType.ASSET,
    currency: OrderCurrency.IDR,
  },
  {
    code: "cash.usdt",
    name: "Cash (USDT)",
    type: LedgerAccountType.ASSET,
    currency: OrderCurrency.USDT,
  },
  {
    code: "wallet_liability.idr",
    name: "Wallet Liability (IDR)",
    type: LedgerAccountType.LIABILITY,
    currency: OrderCurrency.IDR,
  },
  {
    code: "wallet_liability.usdt",
    name: "Wallet Liability (USDT)",
    type: LedgerAccountType.LIABILITY,
    currency: OrderCurrency.USDT,
  },
  {
    code: "sales_revenue.idr",
    name: "Sales Revenue (IDR)",
    type: LedgerAccountType.REVENUE,
    currency: OrderCurrency.IDR,
  },
  {
    code: "sales_revenue.usdt",
    name: "Sales Revenue (USDT)",
    type: LedgerAccountType.REVENUE,
    currency: OrderCurrency.USDT,
  },
  {
    code: "payment_fee.idr",
    name: "Payment Fee (IDR)",
    type: LedgerAccountType.EXPENSE,
    currency: OrderCurrency.IDR,
  },
  {
    code: "payment_fee.usdt",
    name: "Payment Fee (USDT)",
    type: LedgerAccountType.EXPENSE,
    currency: OrderCurrency.USDT,
  },
  {
    code: "refund_clearing.idr",
    name: "Refund Clearing (IDR)",
    // Credit-normal: money owed to the buyer. See the doc comment above.
    type: LedgerAccountType.LIABILITY,
    currency: OrderCurrency.IDR,
  },
  {
    code: "refund_clearing.usdt",
    name: "Refund Clearing (USDT)",
    // Credit-normal: money owed to the buyer. See the doc comment above.
    type: LedgerAccountType.LIABILITY,
    currency: OrderCurrency.USDT,
  },
  {
    code: "adjustment.idr",
    name: "Adjustment (IDR)",
    type: LedgerAccountType.EQUITY,
    currency: OrderCurrency.IDR,
  },
  {
    code: "adjustment.usdt",
    name: "Adjustment (USDT)",
    type: LedgerAccountType.EQUITY,
    currency: OrderCurrency.USDT,
  },
  {
    code: "referral_expense.usdt",
    name: "Referral Commission Expense (USDT)",
    // Debit-normal: a cost of acquiring the referred buyer, not a second
    // liability alongside the wallet credit. See the doc comment above.
    type: LedgerAccountType.EXPENSE,
    currency: OrderCurrency.USDT,
  },
];

/** A stored account whose classification no longer matches `CHART_OF_ACCOUNTS`.
 *  Both sides of each disagreement are carried, because which one is right is
 *  exactly the question the operator has to answer. */
export interface DivergedLedgerAccount {
  code: string;
  storedType: string;
  expectedType: string;
  storedCurrency: string;
  expectedCurrency: string;
}

export interface SeedChartOfAccountsReport {
  /** How many rows `CHART_OF_ACCOUNTS` defines — upserted every run. */
  accountCount: number;
  /** Stored rows whose `type`/`currency` disagree with the chart. Never fixed
   *  here; see `seedChartOfAccounts`' doc comment for why. */
  diverged: DivergedLedgerAccount[];
  /** Codes of ACTIVE stored rows the chart no longer contains. Never retired
   *  here; see `seedChartOfAccounts`' doc comment for why. */
  notInChart: string[];
}

/**
 * Install (or refresh) every `CHART_OF_ACCOUNTS` row. Idempotent: each row is
 * upserted on its unique `code`, so running this against an already-seeded
 * database changes nothing observable and adds no duplicates.
 *
 * ONLY `name` is refreshed on an existing row. Rewording a display label in the
 * list above and re-running is the intended way to apply that fix, because a
 * label carries no accounting meaning.
 *
 * `type` and `currency` are deliberately NOT refreshed, and must not be added
 * back to the `update` clause. By the time a re-seed runs, an account may
 * already have LedgerEntry rows posted against it, and this ledger is
 * append-only:
 *
 * - Changing `type` reinterprets the accounting sign of every historical entry
 *   on that account, silently turning a correct balance into a wrong one.
 * - Changing `currency` breaks this schema's documented invariant that
 *   `entry.currency == account.currency` for every row already posted.
 *
 * Either change would happen with no error, no warning and no audit trail, on a
 * CLI bootstrap a human re-runs after every deploy. So re-classifying an
 * existing account is a migration decision — one that has to reason about (and
 * usually reverse, via REVERSAL entries) the entries already posted against it —
 * not something a seed re-run may do behind the operator's back. Add a new
 * account with the correct classification and retire the old one, or write a
 * real migration; do not "fix" this clause.
 *
 * `isActive` is likewise NOT touched: an admin who retired an account should not
 * have the seed silently revive it.
 *
 * ## What it REPORTS instead of changing
 *
 * Because the upsert refreshes only `name`, a database can hold rows that no
 * longer agree with this list, and silence about them is what made the ledger's
 * reference data drift unnoticeably. Two shapes, both now returned so
 * `scripts/seed-chart-of-accounts.ts` can print them:
 *
 * - `diverged` — a row whose `type` or `currency` differs from what this list
 *   says it should be. The upsert deliberately will not fix it (see above), so
 *   the seed's only honest options are to report it or to hide it.
 * - `notInChart` — an ACTIVE `ledger_accounts` row whose `code` this list no
 *   longer contains. `referral_payable.idr` is the live example: M3 dropped it
 *   from the chart as wrongly classified, but nothing removed or retired the row
 *   an M1-era seed had already written, so on any database seeded before M3 it is
 *   still active and still shows up in `trialBalance` as a real account.
 *
 * Neither is auto-corrected, and `notInChart` rows are deliberately NOT
 * auto-retired, for the same reason `type` and `currency` are not auto-refreshed:
 * retiring an account is an accounting decision about rows that may already carry
 * posted entries, and a seed a human re-runs after every deploy must not make it
 * behind their back. A hand-added account outside this list would also be swept
 * up. Retire a dropped code deliberately, by setting its `isActive` to false once
 * you have confirmed what its entries mean — after which `postFinancialTransaction`
 * refuses new postings to it (`error.ledger_account_retired`) and `trialBalance`
 * stops listing it, while `getAccountBalance` keeps its history readable.
 *
 * Writes no audit-log entry — this is a system/CLI bootstrap with no acting
 * admin, and it changes reference data rather than any shop state an admin
 * would look for in the audit log (`scripts/seed-chart-of-accounts.ts` prints
 * its own summary instead). Contrast `seedDetectionKnowledge`, which does log:
 * that seed edits knowledge an admin also edits by hand through the admin UI,
 * so its changes belong in the same trail as theirs.
 *
 * Not wrapped in a `$transaction`: each upsert is independently idempotent and
 * order-independent, so a partial run simply leaves the rest to the next run —
 * and keeping 15 sequential round-trips out of a single transaction follows
 * CLAUDE.md's "keep every `$transaction` short" rule. Pass a `tx` as `db` if a
 * caller does need it to be atomic with surrounding work.
 */
export async function seedChartOfAccounts(db: Db): Promise<SeedChartOfAccountsReport> {
  for (const account of CHART_OF_ACCOUNTS) {
    await db.ledgerAccount.upsert({
      where: { code: account.code },
      create: {
        code: account.code,
        name: account.name,
        type: account.type,
        currency: account.currency,
      },
      update: {
        name: account.name,
      },
    });
  }

  // Read back AFTER the upserts, so a row this run created cannot be reported as
  // diverged or unknown. One query for the whole table: the chart is reference
  // data of a few dozen rows, not something that needs paging.
  const stored = await db.ledgerAccount.findMany({
    select: { code: true, type: true, currency: true, isActive: true },
    orderBy: { code: "asc" },
  });
  const expected = new Map(CHART_OF_ACCOUNTS.map((account) => [account.code, account] as const));

  const diverged: DivergedLedgerAccount[] = [];
  const notInChart: string[] = [];
  for (const row of stored) {
    const want = expected.get(row.code);
    if (!want) {
      // Retired rows are not reported: whoever retired one already made the
      // decision this list would be asking them to make.
      if (row.isActive) notInChart.push(row.code);
      continue;
    }
    if (row.type !== want.type || row.currency !== want.currency) {
      diverged.push({
        code: row.code,
        storedType: row.type,
        expectedType: want.type,
        storedCurrency: row.currency,
        expectedCurrency: want.currency,
      });
    }
  }

  return { accountCount: CHART_OF_ACCOUNTS.length, diverged, notInChart };
}
