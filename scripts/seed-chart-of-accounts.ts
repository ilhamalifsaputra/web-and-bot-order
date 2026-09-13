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
 * the posting rather than inventing an account. Re-run it after adding an entry
 * to `CHART_OF_ACCOUNTS` (or after correcting an existing entry's name/type/
 * currency — the helper refreshes those on rows that already exist).
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
