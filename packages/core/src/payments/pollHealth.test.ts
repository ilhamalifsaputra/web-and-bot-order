import { describe, it, expect } from "vitest";
import { evaluatePollHealth, type PollHeartbeat } from "./pollHealth";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const MINUTE = 60_000;

function heartbeat(overrides: Partial<PollHeartbeat> = {}): PollHeartbeat {
  return {
    lastRun: null,
    lastSuccessAt: null,
    backoffUntil: null,
    consecutiveFailures: null,
    ...overrides,
  };
}

describe("evaluatePollHealth — rule table (packages/core/src/payments/pollHealth.ts)", () => {
  it("rule 1a: disabled reports unmonitored, not paging", () => {
    const result = evaluatePollHealth(heartbeat({ lastRun: new Date(NOW).toISOString() }), { enabled: false, now: NOW });
    expect(result.status).toBe("unmonitored");
    expect(result.paging).toBe(false);
  });

  it("rule 1b: a null heartbeat (enabled, but no record at all) reports unmonitored, not paging", () => {
    const result = evaluatePollHealth(null, { enabled: true, now: NOW });
    expect(result.status).toBe("unmonitored");
    expect(result.paging).toBe(false);
  });

  it('rule 2: "an EXPIRED backoff window is not yellow" — it falls through to the staleness/failure rules instead', () => {
    // Backoff expired 1 minute ago; lastRun is fresh and healthy, so this
    // should read green, not the "still yellow" reading a truthiness check
    // on backoffUntil would produce (dashboard.ts:161's bug).
    const result = evaluatePollHealth(
      heartbeat({
        lastRun: new Date(NOW - MINUTE).toISOString(),
        backoffUntil: new Date(NOW - MINUTE).toISOString(),
        consecutiveFailures: 0,
      }),
      { enabled: true, now: NOW },
    );
    expect(result.status).not.toBe("yellow");
    expect(result.status).toBe("green");
    expect(result.paging).toBe(false);
  });

  it("rule 2: a LIVE backoff window (still in the future) is yellow and does not page", () => {
    const result = evaluatePollHealth(
      heartbeat({
        lastRun: new Date(NOW - MINUTE).toISOString(),
        backoffUntil: new Date(NOW + MINUTE).toISOString(),
        consecutiveFailures: 0,
      }),
      { enabled: true, now: NOW },
    );
    expect(result.status).toBe("yellow");
    expect(result.paging).toBe(false);
  });

  it("rule 2: detail uses relative phrasing (minutes remaining), not a raw UTC instant — consistent with rules 4/5/6/7's phrasing and this repo's UTC-in-DB/local-on-display convention", () => {
    const result = evaluatePollHealth(
      heartbeat({
        lastRun: new Date(NOW - MINUTE).toISOString(),
        backoffUntil: new Date(NOW + 3 * MINUTE).toISOString(),
        consecutiveFailures: 0,
      }),
      { enabled: true, now: NOW },
    );
    expect(result.detail).toMatch(/for about 3 more minute\(s\)/);
    expect(result.detail).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no raw ISO timestamp
  });

  it("rule 3: a poller that has never completed a cycle is red and pages", () => {
    const result = evaluatePollHealth(heartbeat({ lastRun: null }), { enabled: true, now: NOW });
    expect(result.status).toBe("red");
    expect(result.paging).toBe(true);
  });

  it("rule 4: consecutiveFailures >= 3 is red and pages, even with a fresh lastRun", () => {
    const result = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - 1000).toISOString(), consecutiveFailures: 3 }),
      { enabled: true, now: NOW },
    );
    expect(result.status).toBe("red");
    expect(result.paging).toBe(true);
  });

  it("rule 4: detail carries the lastError reason when present, so the admin DM says why cycles are failing (regression: this was dropped when the watchdog was rebased onto evaluatePollHealth)", () => {
    const result = evaluatePollHealth(
      heartbeat({
        lastRun: new Date(NOW - 1000).toISOString(),
        consecutiveFailures: 3,
        lastError: "Binance pay/transactions request timed out",
      }),
      { enabled: true, now: NOW },
    );
    expect(result.status).toBe("red");
    expect(result.paging).toBe(true);
    expect(result.detail).toMatch(/3 consecutive cycles failed/);
    expect(result.detail).toContain("last error: Binance pay/transactions request timed out");
  });

  it("rule 4: detail falls back to a generic reason when lastError is absent (null or omitted)", () => {
    const withNull = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - 1000).toISOString(), consecutiveFailures: 3, lastError: null }),
      { enabled: true, now: NOW },
    );
    const omitted = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - 1000).toISOString(), consecutiveFailures: 3 }),
      { enabled: true, now: NOW },
    );
    expect(withNull.detail).toContain("last error: unknown");
    expect(omitted.detail).toContain("last error: unknown");
  });

  it("rule 4: detail truncates a very long lastError to keep the DM sentence readable, matching the 200-char convention used elsewhere for admin-facing error snippets (e.g. binanceInternal.ts's delivery-fail alert)", () => {
    const longError = "x".repeat(300);
    const result = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - 1000).toISOString(), consecutiveFailures: 3, lastError: longError }),
      { enabled: true, now: NOW },
    );
    expect(result.detail).toContain(`last error: ${"x".repeat(200)}…`);
    expect(result.detail).not.toContain("x".repeat(201));
  });

  it('rule 5: "a poller whose last cycle is hours old is red even with a zero failure count"', () => {
    // This is the dashboard.ts bug: it ignores staleness entirely and would
    // read this poller as green because consecutiveFailures is 0.
    const result = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - 3 * 60 * MINUTE).toISOString(), consecutiveFailures: 0 }),
      { enabled: true, now: NOW },
    );
    expect(result.status).toBe("red");
    expect(result.paging).toBe(true);
  });

  it('rule 6: "one failed cycle is a yellow warning, not a page"', () => {
    const result = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - MINUTE).toISOString(), consecutiveFailures: 1 }),
      { enabled: true, now: NOW },
    );
    expect(result.status).toBe("yellow");
    expect(result.paging).toBe(false);
  });

  it("rule 7: a fresh, failure-free cycle is green", () => {
    const result = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - MINUTE).toISOString(), consecutiveFailures: 0 }),
      { enabled: true, now: NOW },
    );
    expect(result.status).toBe("green");
    expect(result.paging).toBe(false);
  });
});

describe("evaluatePollHealth — rule ordering", () => {
  it("checks backoff (rule 2) before the never-ran rule (rule 3): a poller with a live backoff but no lastRun is yellow, not red", () => {
    const result = evaluatePollHealth(
      heartbeat({ lastRun: null, backoffUntil: new Date(NOW + MINUTE).toISOString() }),
      { enabled: true, now: NOW },
    );
    expect(result.status).toBe("yellow");
    expect(result.paging).toBe(false);
  });

  it("checks the failure-streak rule (rule 4) before staleness (rule 5): a stale AND failing poller is red for both reasons but paging is still true", () => {
    const result = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - 3 * 60 * MINUTE).toISOString(), consecutiveFailures: 5 }),
      { enabled: true, now: NOW },
    );
    expect(result.status).toBe("red");
    expect(result.paging).toBe(true);
    expect(result.detail).toMatch(/5 consecutive cycles failed/);
  });
});

describe("evaluatePollHealth — exact `>` boundaries (rules 2 and 5 use strict greater-than)", () => {
  it("staleness: elapsedSinceLastRun exactly equal to staleMs stays green, not red (rule 5 uses strict >)", () => {
    const result = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - 5 * MINUTE).toISOString(), consecutiveFailures: 0 }),
      { enabled: true, now: NOW }, // default staleMs is 5 minutes; elapsed is exactly 5 minutes
    );
    expect(result.status).toBe("green");
    expect(result.paging).toBe(false);
  });

  it("staleness: one millisecond past staleMs goes red and pages (rule 5's > boundary)", () => {
    const result = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - 5 * MINUTE - 1).toISOString(), consecutiveFailures: 0 }),
      { enabled: true, now: NOW },
    );
    expect(result.status).toBe("red");
    expect(result.paging).toBe(true);
  });

  it("backoff: backoffUntil exactly equal to now is NOT a live backoff (rule 2 uses strict >, so an equal timestamp means the window has already closed) and falls through to the healthy rules below", () => {
    const result = evaluatePollHealth(
      heartbeat({
        lastRun: new Date(NOW - MINUTE).toISOString(),
        backoffUntil: new Date(NOW).toISOString(),
        consecutiveFailures: 0,
      }),
      { enabled: true, now: NOW },
    );
    expect(result.status).not.toBe("yellow");
    expect(result.status).toBe("green");
    expect(result.paging).toBe(false);
  });
});

describe("evaluatePollHealth — paging parity with the watchdog (apps/order-bot/src/jobs/index.ts pollWatchdogDecision, lines 193-209)", () => {
  // pollWatchdogDecision's "unhealthy" bit is:
  //   backoff > now ? suppressed (false) :
  //   (now - lastRun > staleMs) || (consecutiveFailures >= failureThreshold)
  // where a null lastRun is treated as 0, i.e. always stale. evaluatePollHealth
  // must produce `paging` equal to that same bit in every case below —
  // admins must not get one extra (or one fewer) page as a result of this module.

  it("never ran -> paging true (watchdog: lastRun treated as epoch 0, always stale)", () => {
    expect(evaluatePollHealth(heartbeat({ lastRun: null }), { enabled: true, now: NOW }).paging).toBe(true);
  });

  it("failure streak at threshold, fresh lastRun -> paging true (watchdog: failing branch)", () => {
    expect(
      evaluatePollHealth(heartbeat({ lastRun: new Date(NOW - 1000).toISOString(), consecutiveFailures: 3 }), {
        enabled: true,
        now: NOW,
      }).paging,
    ).toBe(true);
  });

  it("stale lastRun (>5min), zero failures -> paging true (watchdog: stale branch)", () => {
    expect(
      evaluatePollHealth(heartbeat({ lastRun: new Date(NOW - 6 * MINUTE).toISOString(), consecutiveFailures: 0 }), {
        enabled: true,
        now: NOW,
      }).paging,
    ).toBe(true);
  });

  it("stale lastRun (>5min) but a LIVE backoff window -> paging false (watchdog: backoff suppresses stale)", () => {
    expect(
      evaluatePollHealth(
        heartbeat({
          lastRun: new Date(NOW - 6 * MINUTE).toISOString(),
          backoffUntil: new Date(NOW + MINUTE).toISOString(),
          consecutiveFailures: 0,
        }),
        { enabled: true, now: NOW },
      ).paging,
    ).toBe(false);
  });

  it("failing at threshold but a LIVE backoff window -> paging false (watchdog: backoff suppresses failing too)", () => {
    expect(
      evaluatePollHealth(
        heartbeat({
          lastRun: new Date(NOW - 1000).toISOString(),
          backoffUntil: new Date(NOW + MINUTE).toISOString(),
          consecutiveFailures: 5,
        }),
        { enabled: true, now: NOW },
      ).paging,
    ).toBe(false);
  });

  it("one failed cycle, fresh lastRun -> paging false (watchdog: below failureThreshold and not stale)", () => {
    expect(
      evaluatePollHealth(heartbeat({ lastRun: new Date(NOW - MINUTE).toISOString(), consecutiveFailures: 1 }), {
        enabled: true,
        now: NOW,
      }).paging,
    ).toBe(false);
  });

  it("healthy poller -> paging false", () => {
    expect(
      evaluatePollHealth(heartbeat({ lastRun: new Date(NOW - MINUTE).toISOString(), consecutiveFailures: 0 }), {
        enabled: true,
        now: NOW,
      }).paging,
    ).toBe(false);
  });

  it("custom failureThreshold is honored: consecutiveFailures at a lowered custom threshold trips rule 4 on its own (staleMs left at its wide default, so this is failureThreshold's effect alone)", () => {
    const result = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - 1000).toISOString(), consecutiveFailures: 2 }),
      { enabled: true, now: NOW, failureThreshold: 2 },
    );
    expect(result.status).toBe("red");
    expect(result.paging).toBe(true);
  });

  it("custom staleMs is honored on its own: a heartbeat that never trips rule 4 (consecutiveFailures stays 0, failureThreshold left at its default) still goes red once elapsed time passes a tightened custom staleMs — proving rule 5, not rule 4, is what reacted", () => {
    const result = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - 2 * MINUTE).toISOString(), consecutiveFailures: 0 }),
      { enabled: true, now: NOW, staleMs: MINUTE },
    );
    expect(result.status).toBe("red");
    expect(result.paging).toBe(true);
    expect(result.detail).toMatch(/No cycle has completed/);
  });
});

describe("evaluatePollHealth — detail surfaces lastSuccessAt when it diverges from lastRun", () => {
  it("reports the last successful cycle when cycles are completing (lastRun advancing) but failing", () => {
    const result = evaluatePollHealth(
      heartbeat({
        lastRun: new Date(NOW - MINUTE).toISOString(),
        lastSuccessAt: new Date(NOW - 27 * MINUTE).toISOString(),
        consecutiveFailures: 4,
      }),
      { enabled: true, now: NOW },
    );
    expect(result.status).toBe("red");
    expect(result.paging).toBe(true);
    expect(result.detail).toMatch(/4 consecutive cycles failed/);
    expect(result.detail).toMatch(/last successful cycle was 27 minute/);
  });

  it("does not mention lastSuccessAt when it equals lastRun (the common healthy case)", () => {
    const sameTimestamp = new Date(NOW - MINUTE).toISOString();
    const result = evaluatePollHealth(
      heartbeat({ lastRun: sameTimestamp, lastSuccessAt: sameTimestamp, consecutiveFailures: 0 }),
      { enabled: true, now: NOW },
    );
    expect(result.detail).not.toMatch(/last successful cycle/);
  });

  it("does not mention lastSuccessAt when it has never succeeded (null)", () => {
    const result = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - MINUTE).toISOString(), lastSuccessAt: null, consecutiveFailures: 1 }),
      { enabled: true, now: NOW },
    );
    expect(result.detail).not.toMatch(/last successful cycle/);
  });
});

describe("evaluatePollHealth — unparseable timestamps (corrupt heartbeat data)", () => {
  // Date.parse("not-a-real-timestamp") is NaN. `now - NaN > staleMs` is
  // false, so an unparseable lastRun currently reads as NOT stale — the
  // poller silently reads healthy instead of red, which is what
  // pollWatchdogDecision (apps/order-bot/src/jobs/index.ts:202-203) also
  // does today (`now - NaN > staleMs` is false there too). This test pins
  // that behavior deliberately so a future refactor can't silently change
  // it; see the task report for why this may be the wrong call and why it
  // is being left alone here regardless.
  it("an unparseable lastRun reads green (elapsed is NaN, not > staleMs) — matches the watchdog's own NaN behavior, pinned deliberately", () => {
    const result = evaluatePollHealth(
      heartbeat({ lastRun: "not-a-real-timestamp", consecutiveFailures: 0 }),
      { enabled: true, now: NOW },
    );
    expect(result.status).toBe("green");
    expect(result.paging).toBe(false);
    expect(Number.isNaN(result.staleMs)).toBe(true);
    // detail must degrade to readable text, not the literal "NaN".
    expect(result.detail).not.toMatch(/NaN/);
  });

  it("an unparseable backoffUntil is treated as no live backoff (NaN guard on rule 2) and falls through to the rules below", () => {
    const result = evaluatePollHealth(
      heartbeat({
        lastRun: new Date(NOW - MINUTE).toISOString(),
        backoffUntil: "not-a-real-timestamp",
        consecutiveFailures: 0,
      }),
      { enabled: true, now: NOW },
    );
    expect(result.status).toBe("green");
    expect(result.paging).toBe(false);
  });
});

describe("evaluatePollHealth — staleMs field on the result", () => {
  it("reports milliseconds elapsed since lastRun when a lastRun exists", () => {
    const result = evaluatePollHealth(
      heartbeat({ lastRun: new Date(NOW - 90_000).toISOString(), consecutiveFailures: 0 }),
      { enabled: true, now: NOW },
    );
    expect(result.staleMs).toBe(90_000);
  });

  it("is null when there is no lastRun to measure from", () => {
    const result = evaluatePollHealth(heartbeat({ lastRun: null }), { enabled: true, now: NOW });
    expect(result.staleMs).toBeNull();
  });

  it("is null when unmonitored", () => {
    const result = evaluatePollHealth(null, { enabled: true, now: NOW });
    expect(result.staleMs).toBeNull();
  });
});
