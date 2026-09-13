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
 * Deliberately NOT in this file: anything that posts to the ledger. There is
 * no FinancialTransaction/LedgerEntry writer anywhere yet — that posting
 * service is a later milestone. This file only installs the buckets it will
 * eventually post into.
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
 * meaningless sum. `referral_payable` is the one exception — it has an IDR row
 * only, because referral commission is an IDR-denominated concept in this shop
 * (see the Referral model) and inventing a USDT twin for it would create an
 * account nothing can ever legitimately post to.
 *
 * The `*_clearing` accounts are what make money-in-transit expressible at all:
 * funds a gateway has taken from the buyer but not yet paid out to us sit in
 * `provider_clearing.*` rather than being counted as `cash.*`, and an approved
 * but not-yet-paid refund sits in `refund_clearing.*`. Both are expected to
 * trend back to zero; a persistent balance on one is the signal that something
 * never settled.
 */
export const CHART_OF_ACCOUNTS: readonly ChartOfAccountsEntry[] = [
  {
    code: "provider_clearing.idr",
    name: "Provider Clearing (IDR)",
    type: LedgerAccountType.CLEARING,
    currency: OrderCurrency.IDR,
  },
  {
    code: "provider_clearing.usdt",
    name: "Provider Clearing (USDT)",
    type: LedgerAccountType.CLEARING,
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
    type: LedgerAccountType.CLEARING,
    currency: OrderCurrency.IDR,
  },
  {
    code: "refund_clearing.usdt",
    name: "Refund Clearing (USDT)",
    type: LedgerAccountType.CLEARING,
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
    code: "referral_payable.idr",
    name: "Referral Payable (IDR)",
    type: LedgerAccountType.LIABILITY,
    currency: OrderCurrency.IDR,
  },
];

/**
 * Install (or refresh) every `CHART_OF_ACCOUNTS` row. Idempotent: each row is
 * upserted on its unique `code`, so running this against an already-seeded
 * database changes nothing observable and adds no duplicates.
 *
 * `name`/`type`/`currency` ARE refreshed on an existing row, so correcting a
 * label or a misfiled classification in the list above and re-running is the
 * intended way to apply that fix. `isActive` is deliberately NOT touched: an
 * admin who retired an account should not have the seed silently revive it.
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
export async function seedChartOfAccounts(db: Db): Promise<{ accountCount: number }> {
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
        type: account.type,
        currency: account.currency,
      },
    });
  }

  return { accountCount: CHART_OF_ACCOUNTS.length };
}
