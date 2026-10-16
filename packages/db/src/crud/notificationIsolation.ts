/**
 * Run one notification enqueue so that its failure can never undo the domain
 * write it is attached to (backend audit pass 2, A3).
 *
 * The motivating caller is payment settlement: `settlePaidOrder` /
 * `approveOrder` run inside the payment rail's `$transaction`, after the
 * gateway has already charged the buyer. Queueing an email or Telegram DM
 * there is a side effect, and a failure in it must not roll the order back to
 * unpaid.
 *
 * ## Why a savepoint, not just try/catch
 *
 * A JavaScript throw (a bug in the helper, a bad payload) is stopped by a
 * catch. A database error is not: in Postgres a failed statement puts the
 * whole transaction into the aborted state, so every later statement in the
 * settlement ("current transaction is aborted …") and the final COMMIT would
 * fail even though the JS error was caught. Prisma 5's interactive transaction
 * client has no nested `$transaction`, so the enqueue runs behind an explicit
 * `SAVEPOINT`; on failure `ROLLBACK TO SAVEPOINT` discards only the enqueue's
 * own partial writes and clears the aborted state, and the settlement carries
 * on.
 *
 * ## Why the enqueue stays inside the transaction
 *
 * The outbox exists so a notification commits atomically with the fact it
 * reports. Moving these enqueues after the commit would lose them on a crash
 * between the two; keeping them inside, behind a savepoint, keeps that
 * guarantee for every enqueue that succeeds.
 *
 * Given a top-level client (no surrounding transaction) each statement
 * autocommits, so nothing can be poisoned and a plain catch is enough.
 *
 * Only notification enqueues belong behind this. Money, stock, status and
 * ledger writes must keep failing loudly.
 */
import { logger } from "@app/core/logger";
import type { Db } from "./_types";

export async function enqueueNotificationSafely(
  db: Db,
  context: { orderId: number; notification: string },
  enqueue: () => Promise<unknown>,
): Promise<void> {
  if ("$transaction" in db) {
    try {
      await enqueue();
    } catch (err) {
      logEnqueueFailure(err, context);
    }
    return;
  }

  await db.$executeRaw`SAVEPOINT notification_enqueue`;
  try {
    await enqueue();
  } catch (err) {
    // Log the enqueue's own error first: if the rollback below fails the
    // transaction is genuinely broken and that error propagates, which would
    // otherwise hide why the enqueue failed.
    logEnqueueFailure(err, context);
    await db.$executeRaw`ROLLBACK TO SAVEPOINT notification_enqueue`;
    await db.$executeRaw`RELEASE SAVEPOINT notification_enqueue`;
    return;
  }
  await db.$executeRaw`RELEASE SAVEPOINT notification_enqueue`;
}

function logEnqueueFailure(err: unknown, context: { orderId: number; notification: string }): void {
  logger.error(
    { err, orderId: context.orderId, notification: context.notification },
    `Could not queue the ${context.notification} notification for order ${context.orderId}, so it was skipped. ` +
      `The order's own changes were kept and still commit; only this message will not be sent, ` +
      `so check the error and notify the recipient by hand if it matters.`,
  );
}
