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
 * Usage, from the repo root, against the live database:
 *
 *   DATABASE_URL_PRISMA="file:./data/bot.db" pnpm exec tsx scripts/check-wallet-tx-duplicates.ts
 *
 * Exit code 0 = no duplicates, safe to apply. Exit code 1 = duplicates found,
 * listed on stdout. Any other failure exits 2.
 */
import { PrismaClient } from "@prisma/client";

type DuplicateRow = { order_id: number; reason: string; n: bigint | number };

async function main(): Promise<number> {
  const prisma = new PrismaClient();
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
