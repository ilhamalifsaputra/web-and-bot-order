/**
 * Shared timeout wrapper + budgets for Telegram Bot API calls made directly
 * on the Bybit deposit payment path (bybitDeposit.ts, bybitBscDeposit.ts).
 *
 * main.ts deliberately does not set a bot-wide grammY client timeout — an
 * earlier attempt collided with the runner's own 30s `getUpdates` long poll
 * and aborted every idle poll, and was reverted (Task 11 review follow-up,
 * Critical #1; see buildBot() in main.ts). Without a bound here, every
 * outbound call these two rails make on delivery — a bubble edit, an admin
 * alert, the account-file upload — falls back to grammY's 500s per-call
 * default. `processDeposits` in both files runs those calls SEQUENTIALLY per
 * matched deposit, so one slow call could singlehandedly consume most of a
 * cycle — exactly what let a healthy-but-slow rail trip its own
 * `cycleTimeoutMs` deadline and page admins over nothing (followup-review-
 * fixes-2, Finding #2).
 *
 * Mirrors the identical `withTimeout` helper already duplicated in
 * tokopayReconcile.ts / paydisiniReconcile.ts / nowpaymentsReconcile.ts —
 * kept as its own small module here rather than folded into
 * `reconcileCycleBudget.ts`: that module is scoped to (and its own doc-
 * comment explicitly names) the three QRIS/IDR reconcile rails, and is also
 * read by web-admin's dashboard for THEIR staleness thresholds — nothing
 * here needs to cross that app boundary, so conflating the two would blur
 * what reconcileCycleBudget.ts is actually shared for.
 */

/** Race `promise` against `timeoutMs`; resolves `"timeout"` if the deadline
 * wins. The underlying grammY call isn't cancelled when this loses the race —
 * it may still complete in the background, the same accepted trade-off
 * pollLoop.ts's own cycle-abandon deadline makes for a hung `run()` — so this
 * only bounds how long the CALLER waits on it, not the call itself. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Bound for a plain-text Telegram call on this path — a bubble edit
 * (`editMessageText`) or an admin alert/DM (`sendMessage`). Same value and
 * reasoning as `RECONCILE_TELEGRAM_TIMEOUT_MS` in reconcileCycleBudget.ts (a
 * pure-text edit/message reliably finishes in well under a second in the
 * normal case, so 5s stays generous) — kept as its own constant here rather
 * than importing that one directly, since this module is Bybit-only and that
 * one is QRIS-scoped (see this file's own doc-comment). */
export const TELEGRAM_MESSAGE_TIMEOUT_MS = 5_000;

/** Bound for the account-file upload (`sendAccountFile` -> `api.sendDocument`).
 * A document upload is legitimately slower than a plain-text call — it has to
 * actually transmit bytes, not just a JSON frame — but the file itself is a
 * small, in-memory-generated `.txt` (a handful of KB at most, never a disk-
 * or network-sourced attachment), so it doesn't need anywhere near grammY's
 * 500s default either. Set at 2x the message budget: generous headroom over
 * a normal sub-second upload, while keeping the per-delivery worst case (see
 * each rail's own `cycleTimeoutMs` derivation) from ballooning. */
export const TELEGRAM_DOCUMENT_TIMEOUT_MS = 10_000;
