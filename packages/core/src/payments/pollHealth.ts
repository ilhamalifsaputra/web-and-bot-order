/**
 * evaluatePollHealth — the single rule for turning a payment poller's
 * heartbeat into a health verdict. Pure: no Prisma, no `@app/db` import,
 * takes a plain heartbeat record so it can be read from both the web-admin
 * server (dashboard health tile, PaymentsPage detail) and the order-bot's
 * jobs module. Lives in `core` (not `db`) precisely so both sides can share
 * one implementation instead of re-deriving the rule — the three call sites
 * it replaces are apps/web-admin/src/routes/api/dashboard.ts's health tile,
 * apps/order-bot/src/jobs/index.ts's `pollWatchdogDecision`, and
 * apps/web-admin/client/src/pages/PaymentsPage.tsx's `healthPill`.
 *
 * `paging` reproduces `pollWatchdogDecision`'s "unhealthy" bit
 * (apps/order-bot/src/jobs/index.ts:193-209) bit-for-bit: never-ran, OR
 * `consecutiveFailures >= failureThreshold`, OR more than `staleMs` since
 * `lastRun`, suppressed while a live backoff window is in effect. That rule
 * is what pages admins today and must not change here — this module only
 * adds a *display* rule (`status`) that is stricter about staleness (the
 * dashboard's bug) and looser about a single failed cycle (the dashboard's
 * and PaymentsPage's other bug: one failure isn't an outage).
 *
 * `lastSuccessAt` — written by all three rails, read by nothing until this
 * module — gets folded into `detail` whenever it diverges from `lastRun`,
 * since `lastRun` alone advances on every cycle whether that cycle
 * succeeded or failed and so hides an ongoing failure streak.
 */

export interface PollHeartbeat {
  lastRun: string | null;
  lastSuccessAt: string | null;
  backoffUntil: string | null;
  consecutiveFailures: number | null;
}

export interface PollHealthEvaluation {
  status: "green" | "yellow" | "red" | "unmonitored";
  paging: boolean;
  detail: string;
  /** Milliseconds elapsed since `lastRun`, or null when there is no `lastRun`
   * to measure from (never run, or monitoring is off). */
  staleMs: number | null;
}

const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_FAILURE_THRESHOLD = 3;

function minutesAgo(iso: string, now: number): number {
  return Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
}

/** Appends a clause about the last successful cycle when `lastSuccessAt`
 * diverges from `lastRun` — the failure mode `lastRun` alone hides. */
function withLastSuccessClause(base: string, health: PollHeartbeat, now: number): string {
  if (!health.lastSuccessAt || health.lastSuccessAt === health.lastRun) return base;
  return `${base} The last successful cycle was ${minutesAgo(health.lastSuccessAt, now)} minute(s) ago.`;
}

export function evaluatePollHealth(
  health: PollHeartbeat | null,
  opts: { enabled: boolean; now?: number; staleMs?: number; failureThreshold?: number },
): PollHealthEvaluation {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;

  // Rule 1: disabled, or no heartbeat record at all.
  if (!opts.enabled) {
    return { status: "unmonitored", paging: false, detail: "Health monitoring is disabled for this poller.", staleMs: null };
  }
  if (!health) {
    return { status: "unmonitored", paging: false, detail: "No heartbeat has been recorded for this poller yet.", staleMs: null };
  }

  const elapsedSinceLastRun = health.lastRun ? now - Date.parse(health.lastRun) : null;
  const consecutiveFailures = health.consecutiveFailures ?? 0;

  // Rule 2: a live (not expired) backoff window is an intentional pause, not
  // a failure. Expiry-aware — an expired backoffUntil falls through to the
  // rules below instead of reading as a stale "still backing off" truthiness
  // check would (the dashboard.ts bug this replaces).
  const backoffUntil = health.backoffUntil ? Date.parse(health.backoffUntil) : NaN;
  if (!Number.isNaN(backoffUntil) && backoffUntil > now) {
    return {
      status: "yellow",
      paging: false,
      detail: `Rate-limited on purpose until ${new Date(backoffUntil).toISOString()}; retrying automatically once the window ends.`,
      staleMs: elapsedSinceLastRun,
    };
  }

  // Rule 3: never completed a cycle.
  if (!health.lastRun) {
    return {
      status: "red",
      paging: true,
      detail: "The poller has never completed a cycle.",
      staleMs: null,
    };
  }

  // Rule 4: failing every cycle (consecutiveFailures past the threshold) —
  // lastRun keeps advancing so staleness alone would never catch this.
  if (consecutiveFailures >= failureThreshold) {
    return {
      status: "red",
      paging: true,
      detail: withLastSuccessClause(
        `Cycles are completing but ${consecutiveFailures} consecutive cycles failed.`,
        health,
        now,
      ),
      staleMs: elapsedSinceLastRun,
    };
  }

  // Rule 5: no cycle has completed within the staleness window — the check
  // the dashboard's traffic light is missing entirely today.
  if (elapsedSinceLastRun !== null && elapsedSinceLastRun > staleMs) {
    return {
      status: "red",
      paging: true,
      detail: withLastSuccessClause(
        `No cycle has completed in ${minutesAgo(health.lastRun, now)} minute(s); the poller appears stuck or stopped.`,
        health,
        now,
      ),
      staleMs: elapsedSinceLastRun,
    };
  }

  // Rule 6: a failed cycle happened, but the poller is still on schedule and
  // below the paging threshold — a blip out of a 30-second loop, not an
  // outage. Relaxed from the dashboard's/PaymentsPage's "any failure is
  // critical" rule.
  if (consecutiveFailures >= 1) {
    return {
      status: "yellow",
      paging: false,
      detail: withLastSuccessClause(
        `${consecutiveFailures} consecutive cycle(s) failed, but the poller is still running on schedule.`,
        health,
        now,
      ),
      staleMs: elapsedSinceLastRun,
    };
  }

  // Rule 7: healthy.
  return {
    status: "green",
    paging: false,
    detail: `Cycles are completing normally; last run ${minutesAgo(health.lastRun, now)} minute(s) ago.`,
    staleMs: elapsedSinceLastRun,
  };
}
