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
 * old one — which is exactly what M3 did to M1's `referral_payable.idr` IN THE
 * CHART. Note the qualifier: dropping a code from `CHART_OF_ACCOUNTS` does not
 * touch the row an earlier seed already wrote, so on a database seeded before M3
 * that account is still present and still active. This script now reports any
 * such row, and any row whose stored `type`/`currency` disagrees with the chart,
 * and exits non-zero when it finds either — it does not silently fix or retire
 * them, because both are accounting decisions about rows that may already carry
 * posted entries.
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

  const { accountCount, diverged, notInChart } = await seedChartOfAccounts(prisma);

  console.log(
    `[seed-chart-of-accounts] seeded ${accountCount} ledger account(s) from CHART_OF_ACCOUNTS.`,
  );

  // The two things the upsert cannot fix and used to stay silent about. Printed
  // rather than corrected, and the exit code goes non-zero so a deploy step that
  // checks it cannot treat a drifted chart as a clean bootstrap.
  if (diverged.length > 0) {
    console.error(
      `[seed-chart-of-accounts] ${diverged.length} account(s) in this database are classified ` +
        `differently from CHART_OF_ACCOUNTS. The seed refreshes only 'name', never 'type' or ` +
        `'currency', because either would silently reinterpret every LedgerEntry already posted ` +
        `against the account — so these need a human decision, not a re-run:`,
    );
    for (const account of diverged) {
      console.error(
        `  ${account.code}: database says ${account.storedType}/${account.storedCurrency}, ` +
          `the chart says ${account.expectedType}/${account.expectedCurrency}`,
      );
    }
  }

  if (notInChart.length > 0) {
    console.error(
      `[seed-chart-of-accounts] ${notInChart.length} ACTIVE account(s) exist in this database but ` +
        `are not in CHART_OF_ACCOUNTS: ${notInChart.join(", ")}. Each is either a code the chart ` +
        `dropped (M3 dropped M1's wrongly-classified 'referral_payable.idr' this way, and nothing ` +
        `ever retired the row an earlier seed had written) or an account added by hand. They still ` +
        `appear in the trial balance as real accounts. The seed will not retire them for you — that ` +
        `is an accounting decision about rows that may already carry posted entries. Once you have ` +
        `confirmed what an account's entries mean, set its is_active to false: new postings to it ` +
        `are then refused and the trial balance stops listing it, while its history stays readable.`,
    );
  }

  if (diverged.length > 0 || notInChart.length > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[seed-chart-of-accounts] failed:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
