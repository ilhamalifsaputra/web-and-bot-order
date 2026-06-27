/**
 * DB schema integrity checks. SQLite has no migration enforcement at runtime, so
 * a live DB can drift (e.g. a migration that was never `prisma db push`-ed),
 * which silently breaks code paths that write to the missing table — most
 * dangerously the payment-delivery ledgers (`processed_*_tx`), where a missing
 * table means "buyer paid, never delivered". This helper lets the boot sequence
 * surface that drift loudly instead of failing one order at a time.
 */
import type { Db } from "./_types";

/**
 * Of the given table names, return those that DO NOT exist in the SQLite DB.
 * Empty result = all present. Names are matched verbatim against `sqlite_master`.
 */
export async function missingTables(db: Db, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const placeholders = names.map(() => "?").join(", ");
  const rows = await db.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`,
    ...names,
  );
  const present = new Set(rows.map((r) => r.name));
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
