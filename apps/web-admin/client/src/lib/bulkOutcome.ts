/**
 * One honest reading of a bulk action's result, shared by Orders, Payments and
 * Vouchers. Each used to raise `toast.success` whatever came back, so "0
 * succeeded, 5 failed" arrived in green, the per-item reasons were dropped and
 * the failed rows lost their selection.
 *
 * The rule: success only if everything succeeded, error if nothing did, warning
 * in between. Only what succeeded leaves the selection, and each failure keeps
 * its reason for `BulkFailuresNotice`.
 */
import { toast } from "sonner";
import { describeError } from "./errorMessages";

/** A per-item failure as the bulk routes send it. */
export interface BulkFailedItem {
  id: number;
  error: string;
  error_args?: Record<string, string>;
}

/** A failure ready to show: which item, and why in a sentence. */
export interface BulkFailureLine {
  label: string;
  reason: string;
}

export interface BulkReport {
  /** Past-tense verb: "Deleted". */
  done: string;
  /** Singular noun: "voucher". */
  noun: string;
  succeeded: number;
  failed: number;
  /** Items never sent because the run stopped early. */
  notAttempted?: number;
  /** Replaces the sentence only when everything succeeded. */
  allDone?: string;
}

export type BulkOutcomeKind = "success" | "warning" | "error";

export function bulkOutcomeKind({ succeeded, failed, notAttempted = 0 }: BulkReport): BulkOutcomeKind {
  if (succeeded === 0) return "error";
  return failed + notAttempted === 0 ? "success" : "warning";
}

export function bulkOutcomeMessage(report: BulkReport): string {
  const { done, noun, succeeded, failed, notAttempted = 0, allDone } = report;
  const total = succeeded + failed + notAttempted;
  const nouns = `${noun}${total === 1 ? "" : "s"}`;
  if (succeeded === total) return allDone ?? `${done} ${total} ${nouns}.`;
  const shortfall = [
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(notAttempted > 0 ? [`${notAttempted} not attempted`] : []),
  ];
  return `${done} ${succeeded} of ${total} ${nouns} — ${shortfall.join(", ")}.`;
}

export function toastBulkOutcome(report: BulkReport): void {
  toast[bulkOutcomeKind(report)](bulkOutcomeMessage(report));
}

/** The selection after a bulk action: what failed stays for another try. */
export function withoutSucceeded(selected: ReadonlySet<number>, succeeded: Iterable<number>): Set<number> {
  const next = new Set(selected);
  for (const id of succeeded) next.delete(id);
  return next;
}

/** Turn the routes' keys into sentences through the same helper as every other
 * admin error. Rebuilt as a failure because `describeError` reads the figures
 * from the same `errorArgs` an `ApiError` carries. */
export function bulkFailureLines(
  failed: readonly BulkFailedItem[],
  labelOf: (id: number) => string,
): BulkFailureLine[] {
  return failed.map(({ id, error, error_args }) => ({
    label: labelOf(id),
    reason: describeError({ message: error, errorArgs: error_args }),
  }));
}

export interface SequentialResult<T> {
  succeeded: T[];
  failed: { item: T; error: unknown }[];
  /** The error that ended the run early, or null if it ran to the end. */
  stopped: unknown;
  /** Includes the item that stopped the run: it was turned away unprocessed. */
  notAttempted: T[];
}

/**
 * Send items one at a time. An ordinary failure is recorded and the run moves on;
 * an error `shouldStop` recognises ends it, because the items behind it would
 * only meet the same refusal.
 */
export async function sendSequentially<T>(
  items: readonly T[],
  send: (item: T) => Promise<unknown>,
  shouldStop: (error: unknown) => boolean,
): Promise<SequentialResult<T>> {
  const result: SequentialResult<T> = { succeeded: [], failed: [], stopped: null, notAttempted: [] };
  // A worker that calls itself, as in mapWithConcurrency: each send starts only
  // once the one before it has its answer.
  async function sendFrom(index: number): Promise<void> {
    if (index >= items.length) return;
    const item = items[index]!;
    try {
      await send(item);
      result.succeeded.push(item);
    } catch (error) {
      if (shouldStop(error)) {
        result.stopped = error;
        result.notAttempted = items.slice(index);
        return;
      }
      result.failed.push({ item, error });
    }
    return sendFrom(index + 1);
  }
  await sendFrom(0);
  return result;
}
