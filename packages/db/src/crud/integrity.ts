/**
 * DB schema integrity checks. Postgres has no migration enforcement at runtime, so
 * a live DB can drift (e.g. a migration that was never `prisma db push`-ed),
 * which silently breaks code paths that write to the missing table — most
 * dangerously the payment-delivery ledgers (`processed_*_tx`), where a missing
 * table means "buyer paid, never delivered". This helper lets the boot sequence
 * surface that drift loudly instead of failing one order at a time.
 */
import type { Db } from "./_types";

/**
 * Of the given table names, return those that DO NOT exist in the Postgres DB's
 * `public` schema. Empty result = all present. Queries
 * `information_schema.tables` with the name list bound as a single array
 * parameter (`= ANY($1)`), rather than building a hand-rolled `IN (...)`
 * placeholder list — Postgres supports passing an array directly.
 */
export async function missingTables(db: Db, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const rows = await db.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
    names,
  );
  const present = new Set(rows.map((r) => r.table_name));
  return names.filter((n) => !present.has(n));
}

/**
 * Tables whose absence silently breaks payment delivery. Checked at startup; a
 * missing one means orders for that gateway confirm-but-never-deliver (P2021).
 */
export const PAYMENT_LEDGER_TABLES = [
  "processed_binance_tx",
  "processed_bybit_tx",
  "processed_tokopay_tx",
  "processed_paydisini_tx",
  "processed_nowpayments_tx",
  "notification_outbox",
] as const;
