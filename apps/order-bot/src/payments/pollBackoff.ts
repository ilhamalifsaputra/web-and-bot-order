/**
 * Bounded exponential backoff shared by the Bybit and Binance internal-transfer
 * pollers. A flat fixed-duration backoff on every rate-limit hit can stack into
 * multi-minute outages if the exchange throttles several poll cycles in a row
 * (each hit re-arms the same flat delay). This gate instead doubles the delay
 * per *consecutive* hit, capped at `capMs`, and resets to zero on the next
 * successful call — so one transient 429 costs seconds, not minutes.
 */

export interface BackoffGate {
  /** True while a backoff window from a prior rate-limit hit is still active. */
  shouldSkip(now?: number): boolean;
  /** Record a rate-limit hit; returns the new window, consecutive-hit count, and delay. */
  recordRateLimit(now?: number): { backoffUntil: number; hitCount: number; delayMs: number };
  /** Record a successful call; clears the backoff window and hit count. */
  recordSuccess(): void;
  /** Epoch ms until which shouldSkip() returns true; 0 when clear. */
  readonly backoffUntil: number;
  /** Current consecutive rate-limit hit count; 0 when healthy. */
  readonly hitCount: number;
}

export function createBackoffGate(opts: { baseMs?: number; capMs?: number } = {}): BackoffGate {
  const baseMs = opts.baseMs ?? 3_000;
  const capMs = opts.capMs ?? 30_000;
  let backoffUntil = 0;
  let hitCount = 0;

  return {
    shouldSkip(now = Date.now()) {
      return now < backoffUntil;
    },
    recordRateLimit(now = Date.now()) {
      hitCount += 1;
      const delayMs = Math.min(baseMs * 2 ** (hitCount - 1), capMs);
      backoffUntil = now + delayMs;
      return { backoffUntil, hitCount, delayMs };
    },
    recordSuccess() {
      backoffUntil = 0;
      hitCount = 0;
    },
    get backoffUntil() {
      return backoffUntil;
    },
    get hitCount() {
      return hitCount;
    },
  };
}
