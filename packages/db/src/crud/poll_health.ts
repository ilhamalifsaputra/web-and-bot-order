/**
 * Generic per-rail poller heartbeat storage.
 *
 * `binance_internal.ts`, `bybit_deposit.ts` and `bybit_bsc_deposit.ts` each
 * carry a ~95-line copy of this exact JSON-parse / sticky-field /
 * consecutive-failure logic under their own settings key. This module is the
 * single implementation those three keys (and the three new QRIS/IDR rails —
 * TokoPay, PayDisini, NOWPayments, wired up by Task 11/12) read and write
 * through, keyed by `rail` instead of duplicated per file.
 *
 * Byte-identical JSON shape and write rule to `BinancePollHealth` /
 * `recordBinancePollHealth` (packages/db/src/crud/binance_internal.ts:556-651)
 * — existing production heartbeat blobs under `binance_poll_health`,
 * `bybit_poll_health` and `bybit_bsc_poll_health` keep parsing unchanged, no
 * migration or backfill needed. Task 10 rewraps those three existing
 * implementations onto this pair; this module does not touch them.
 */
import type { Db } from "./_types";
import { getSetting, setSetting } from "./settings";

/** One settings key per rail. The three existing keys are unchanged from
 * their per-rail originals (binance_internal.ts, bybit_deposit.ts,
 * bybit_bsc_deposit.ts) so old blobs keep resolving to the same row. */
export const POLL_HEALTH_KEYS = {
  binance: "binance_poll_health",
  bybit: "bybit_poll_health",
  bybitBsc: "bybit_bsc_poll_health",
  tokopay: "tokopay_poll_health",
  paydisini: "paydisini_poll_health",
  nowpayments: "nowpayments_poll_health",
} as const;

export type PollRail = keyof typeof POLL_HEALTH_KEYS;

export interface PollHealth {
  lastRun: string | null;
  /** Last cycle that completed WITHOUT error (0 new transfers still counts). */
  lastSuccessAt: string | null;
  lastTxCount: number | null;
  backoffUntil: string | null;
  /** Current consecutive rate-limit hit streak (0 when healthy). */
  consecutiveRateLimitHits: number | null;
  /** Sticky — last time a rate-limit hit occurred, even after recovery. */
  lastRateLimitAt: string | null;
  /** Consecutive non-rate-limit failures (network/HTTP errors); 0 when
   * healthy. Tracked separately from rate limits, which already have their
   * own backoff/counter above — `lastRun` alone can't surface this, since it
   * advances on every cycle whether that cycle succeeded or failed. */
  consecutiveFailures: number | null;
  /** Sticky — last error message seen (any failure type), for diagnostics. */
  lastError: string | null;
}

const EMPTY_POLL_HEALTH: PollHealth = {
  lastRun: null,
  lastSuccessAt: null,
  lastTxCount: null,
  backoffUntil: null,
  consecutiveRateLimitHits: null,
  lastRateLimitAt: null,
  consecutiveFailures: null,
  lastError: null,
};

/** Read a rail's poller heartbeat; all-null when it has never run (or the
 * stored blob fails to parse — the parse error is swallowed, matching the
 * per-rail originals: a corrupt heartbeat degrades to "never run" rather
 * than throwing). */
export async function getPollHealth(db: Db, rail: PollRail): Promise<PollHealth> {
  const raw = await getSetting(db, POLL_HEALTH_KEYS[rail]);
  if (!raw) return EMPTY_POLL_HEALTH;
  try {
    const p = JSON.parse(raw) as Partial<PollHealth>;
    return {
      lastRun: p.lastRun ?? null,
      lastSuccessAt: p.lastSuccessAt ?? null,
      lastTxCount: typeof p.lastTxCount === "number" ? p.lastTxCount : null,
      backoffUntil: p.backoffUntil ?? null,
      consecutiveRateLimitHits: typeof p.consecutiveRateLimitHits === "number" ? p.consecutiveRateLimitHits : null,
      lastRateLimitAt: p.lastRateLimitAt ?? null,
      consecutiveFailures: typeof p.consecutiveFailures === "number" ? p.consecutiveFailures : null,
      lastError: p.lastError ?? null,
    };
  } catch {
    return EMPTY_POLL_HEALTH;
  }
}

/** Record one poll cycle's heartbeat for `rail`. Called by that rail's
 * poller each tick. `lastRateLimitAt`/`lastError` are sticky (carried
 * forward from the prior heartbeat) so a rare hit stays visible after the
 * poller recovers. `consecutiveFailures` counts non-rate-limit failures
 * only — a rate-limit hit neither increments nor resets it, since that
 * streak already has its own dedicated counter/backoff above. */
export async function recordPollHealth(
  db: Db,
  rail: PollRail,
  args: {
    lastTxCount: number;
    backoffUntil?: number | null;
    consecutiveRateLimitHits?: number;
    rateLimited?: boolean;
    success: boolean;
    error?: string | null;
  },
): Promise<void> {
  const prev = await getPollHealth(db, rail);
  const lastRateLimitAt = args.rateLimited ? new Date().toISOString() : prev.lastRateLimitAt;
  const consecutiveFailures = args.success
    ? 0
    : args.rateLimited
      ? prev.consecutiveFailures ?? 0
      : (prev.consecutiveFailures ?? 0) + 1;
  const nowIso = new Date().toISOString();
  await setSetting(
    db,
    POLL_HEALTH_KEYS[rail],
    JSON.stringify({
      lastRun: nowIso,
      lastSuccessAt: args.success ? nowIso : prev.lastSuccessAt,
      lastTxCount: args.lastTxCount,
      backoffUntil: args.backoffUntil ? new Date(args.backoffUntil).toISOString() : null,
      consecutiveRateLimitHits: args.consecutiveRateLimitHits ?? 0,
      lastRateLimitAt,
      consecutiveFailures,
      lastError: args.success ? prev.lastError : (args.error ?? prev.lastError) ?? null,
    } satisfies PollHealth),
  );
}
