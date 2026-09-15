/**
 * Idempotent first-run seed for the Financial Ledger's chart of accounts:
 * installs every `CHART_OF_ACCOUNTS` entry (packages/db/src/crud/
 * ledgerAccounts.ts) into the `ledger_accounts` table via the
 * `seedChartOfAccounts` crud helper. That helper upserts each row on its
 * unique `code`, so re-running this script is always a safe no-op at the row
 * level — no duplicates, no errors.
 *
 * Run this once per environment BEFORE anything posts to the ledger: a posting
 * site resolves the account it needs by `code`, so an unseeded database fails
 * the posting rather than inventing an account. Since M3 that includes every
 * order settlement, wallet top-up, manual wallet adjustment and referral
 * commission — so on a database where this has never run, those paths log a
 * missing-account failure instead of recording the money that moved.
 *
 * Re-run it after adding an entry to `CHART_OF_ACCOUNTS`, or after rewording an
 * existing entry's display `name`. It does NOT re-classify an existing row: the
 * helper deliberately refreshes only `name`, never `type` or `currency`, because
 * either of those would silently reinterpret every LedgerEntry already posted
 * against that account (see `seedChartOfAccounts`'s own doc comment). Correcting
 * a wrongly-classified account means adding a replacement row and retiring the
 * old one — which is exactly what M3 did to M1's `referral_payable.idr`.
 *
 * Writes no audit-log entry: there is no acting admin for a CLI bootstrap, and
 * this installs reference data rather than changing shop state. See
 * `seedChartOfAccounts`'s own doc comment for why that differs from
 * scripts/seed-detection-knowledge.ts, which does log.
 *
 *   pnpm seed-chart-of-accounts
 */
import { prisma, initDb, seedChartOfAccounts } from "@app/db";

async function main(): Promise<void> {
  await initDb(); // no-op on Postgres; kept for boot-sequencing parity with the app

  const { accountCount } = await seedChartOfAccounts(prisma);

  console.log(
    `[seed-chart-of-accounts] seeded ${accountCount} ledger account(s) from CHART_OF_ACCOUNTS.`,
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[seed-chart-of-accounts] failed:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
