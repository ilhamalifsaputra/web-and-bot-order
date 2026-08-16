/**
 * Pre-flight check for Task E5 item 2's migration
 * (prisma/migrations/20260816010000_wallet_tx_unique_order_reason).
 *
 * That migration adds `@@unique([orderId, reason])` to `wallet_transactions`.
 * Unlike every other migration in this repo it is NOT unfalsifiable against
 * existing data: `CREATE UNIQUE INDEX` fails outright if the database already
 * holds a duplicate pair, and `prisma db push` will refuse rather than apply
 * anything. Run this against the live database BEFORE deploying that schema
 * change.
 *
 * Why a script and not `prisma db execute`: that command runs a statement but
 * discards its result set, so a SELECT through it prints "Script executed
 * successfully" whether it matched zero rows or a thousand. It cannot answer
 * this question.
 *
 * READ-ONLY. It opens the database, runs one grouped SELECT and disconnects.
 * It never writes, and it deliberately offers no "fix" mode:
 * `wallet_transactions` is an append-only financial ledger (see the
 * onDelete: Restrict guardrails on the model), so a duplicate found here is a
 * real historical double-movement on a buyer's balance and needs a human
 * decision — never a delete to make the index fit.
 *
 * Usage — pass the database file as an argument:
 *
 *   pnpm exec tsx scripts/check-wallet-tx-duplicates.ts ../../../data/bot.db
 *   pnpm exec tsx scripts/check-wallet-tx-duplicates.ts C:/path/to/data/bot.db
 *
 * The argument is resolved against your CURRENT directory and passed to Prisma
 * as an absolute path, which is the whole reason it exists. A relative
 * `DATABASE_URL_PRISMA` is resolved by Prisma against `prisma/` (where
 * schema.prisma lives), not against the directory you are standing in — which
 * is why the repo's own `.env` reads `file:../data/bot.db` — so the obvious
 * `file:./data/bot.db` silently points at `prisma/data/bot.db` and fails with
 * "Unable to open the database file". With no argument, this falls back to
 * whatever `DATABASE_URL_PRISMA` is already set to.
 *
 * It prints the file it actually opened. Check that line before believing the
 * result: pointed at the wrong database — an empty worktree copy, say — this
 * reports "no duplicates" perfectly truthfully and tells you nothing about
 * production.
 *
 * Exit code 0 = no duplicates, safe to apply. Exit code 1 = duplicates found,
 * listed on stdout. Any other failure exits 2.
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

type DuplicateRow = { order_id: number; reason: string; n: bigint | number };

/** Turn the CLI argument into an absolute `file:` URL, or return null to fall
 *  back to whatever `DATABASE_URL_PRISMA` already points at. Fails loudly on a
 *  path that does not exist rather than letting Prisma's "Unable to open the
 *  database file" stand in for it — that error reads like a permissions or
 *  corruption problem, when it is almost always a path resolved from somewhere
 *  other than where you were standing. */
function resolveDatabaseUrl(arg: string | undefined): string | null {
  if (!arg) return null;
  const absolute = resolve(process.cwd(), arg);
  if (!existsSync(absolute)) {
    throw new Error(
      `No database file at ${absolute} (resolved from "${arg}" relative to ${process.cwd()}). ` +
        `Pass the path to the database you actually want to check — for the live one, that is the data/bot.db in the main working directory, not a worktree's own copy.`,
    );
  }
  return `file:${absolute.replace(/\\/g, "/")}`;
}

async function main(): Promise<number> {
  const url = resolveDatabaseUrl(process.argv[2]);
  console.log(`Checking ${url ?? `DATABASE_URL_PRISMA (${process.env.DATABASE_URL_PRISMA ?? "unset"})`}\n`);
  const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();
  try {
    const rows = await prisma.$queryRaw<DuplicateRow[]>`
      SELECT order_id, reason, COUNT(*) AS n
        FROM wallet_transactions
       WHERE order_id IS NOT NULL
       GROUP BY order_id, reason
      HAVING COUNT(*) > 1
       ORDER BY n DESC, order_id ASC
    `;

    if (rows.length === 0) {
      console.log(
        "No duplicate (order_id, reason) pairs. The wallet_transactions UNIQUE index can be applied safely.",
      );
      return 0;
    }

    console.log(
      `Found ${rows.length} duplicate (order_id, reason) pair(s). The UNIQUE index CANNOT be applied until these are resolved:\n`,
    );
    for (const row of rows) {
      console.log(`  order_id=${row.order_id}  reason=${row.reason}  rows=${Number(row.n)}`);
    }
    console.log(
      "\nEach line is a buyer's balance that moved more than once for the same order and the same reason.\n" +
        "Decide what actually happened for each before going further, and do not delete ledger rows to make the\n" +
        "index fit — this table is the append-only record of that money.",
    );
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("Could not run the duplicate check:", err);
    process.exit(2);
  },
);
