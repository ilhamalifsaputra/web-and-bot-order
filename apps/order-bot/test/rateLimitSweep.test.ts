// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "@app/core/config";
import { hasBucket, rateLimit, sweepRateLimitBuckets } from "../src/middleware";
import { makeCtx } from "./helpers/ctx";

/**
 * Regression coverage for task-1-brief.md: the module-level `buckets` Map in
 * middleware.ts's rateLimit leaked one entry per unique Telegram user for
 * the life of the process, because `dq.push(now)` always left `dq.length`
 * truthy — the `else buckets.delete(from.id)` branch was dead code, and
 * nothing else ever pruned an idle user's entry. sweepRateLimitBuckets is
 * the fix's active cleanup path.
 */
describe("rateLimit — bucket sweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("an idle user's bucket entry is reclaimed once their whole window ages out and the sweep runs", async () => {
    const userId = 500_001;
    const { ctx } = makeCtx({ from: { id: userId } });
    const next = vi.fn(async () => {});

    await rateLimit(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(hasBucket(userId)).toBe(true); // entry created by the single action above

    // Advance time past the whole rate-limit window, so every hit in this
    // user's deque is now expired.
    vi.advanceTimersByTime((config.RATE_LIMIT_WINDOW_SECONDS + 1) * 1000);

    sweepRateLimitBuckets();

    expect(hasBucket(userId)).toBe(false); // pruned to empty and deleted, not left behind forever
  });

  it("an active user's bucket survives the sweep (not expired yet)", async () => {
    const userId = 500_002;
    const { ctx } = makeCtx({ from: { id: userId } });
    const next = vi.fn(async () => {});

    await rateLimit(ctx, next);
    expect(hasBucket(userId)).toBe(true);

    sweepRateLimitBuckets(); // runs immediately, well within the window

    expect(hasBucket(userId)).toBe(true); // still within window — not pruned
  });

  it("existing rate-limit behavior is unaffected: the (max+1)th action within the window is still blocked", async () => {
    const userId = 500_003;
    const max = config.RATE_LIMIT_MAX;
    let lastNext = vi.fn(async () => {});

    for (let i = 0; i < max; i++) {
      const { ctx } = makeCtx({ from: { id: userId } });
      lastNext = vi.fn(async () => {});
      await rateLimit(ctx, lastNext);
      expect(lastNext).toHaveBeenCalledTimes(1); // every action up to max passes through
    }

    const { ctx: overLimitCtx } = makeCtx({ from: { id: userId } });
    const overLimitNext = vi.fn(async () => {});
    await rateLimit(overLimitCtx, overLimitNext);
    expect(overLimitNext).not.toHaveBeenCalled(); // (max+1)th action dropped silently
  });
});
