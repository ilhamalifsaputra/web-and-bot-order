/**
 * Idempotency ledger for Telegram update_id redelivery — same insert-first-
 * on-unique pattern as the Processed*Tx ledgers (crud/binance_internal.ts,
 * crud/tokopay.ts, crud/paydisini.ts, crud/nowpayments.ts, ...), but for a
 * different kind of duplicate: Telegram's long-polling `getUpdates` offset
 * only advances once a batch is fully acknowledged, so a crash mid-
 * processing (before the next poll) — or a flaky connection — redelivers
 * the same update_id on restart/retry. `bindUpdateId`
 * (apps/order-bot/src/middleware.ts) calls `claimTelegramUpdate` before
 * running the rest of the update's middleware chain, so a redelivered
 * update short-circuits instead of re-running a side effect (charging a
 * wallet, sending a duplicate DM, ...) a second time.
 *
 * Short-lived by design, unlike the payment ledgers above — a row here is
 * only ever useful for as long as Telegram might still redeliver the same
 * update_id (minutes, not months) — so `pruneProcessedTelegramUpdates` is
 * scheduled daily (jobs/index.ts's cleanupProcessedTelegramUpdatesJob),
 * unlike storageMaintenance.ts, which deliberately leaves the payment
 * Processed*Tx ledgers alone (see its own module doc comment).
 */
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";

/**
 * Claim `updateId` for processing.
 * - Returns `true` the first time this update_id is seen — the caller
 *   should proceed to run the rest of the update's middleware/handlers.
 * - Returns `false` if this update_id was already claimed (a Telegram
 *   redelivery, or an overlapping run) — the caller should skip re-running
 *   anything for it.
 */
export async function claimTelegramUpdate(db: Db, updateId: number | bigint): Promise<boolean> {
  try {
    await db.processedTelegramUpdate.create({ data: { updateId: BigInt(updateId) } });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

/** Delete claimed update_id rows older than `cutoff`. Returns the count removed. */
export async function pruneProcessedTelegramUpdates(db: Db, cutoff: Date): Promise<number> {
  const { count } = await db.processedTelegramUpdate.deleteMany({
    where: { processedAt: { lt: cutoff } },
  });
  return count;
}
