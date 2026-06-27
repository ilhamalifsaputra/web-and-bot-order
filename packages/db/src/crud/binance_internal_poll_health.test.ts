import { describe, it, expect } from "vitest";
import { getBinancePollHealth, recordBinancePollHealth } from "./binance_internal";
import type { Db } from "./_types";

/** Mutable in-memory Setting store backing both `findUnique` and `upsert`,
 * needed by recordBinancePollHealth (writes) + getBinancePollHealth (reads). */
function mutableStubDb(initial: Record<string, string> = {}): Db {
  const store = new Map(Object.entries(initial));
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        store.set(where.key, create.value);
        return { key: where.key, value: create.value };
      },
    },
  } as unknown as Db;
}

describe("Binance poll health — rate-limit tracking fields", () => {
  it("getBinancePollHealth on a never-run poller is all-null", async () => {
    const health = await getBinancePollHealth(mutableStubDb());
    expect(health).toEqual({
      lastRun: null,
      lastSuccessAt: null,
      lastTxCount: null,
      backoffUntil: null,
      consecutiveRateLimitHits: null,
      lastRateLimitAt: null,
      consecutiveFailures: null,
      lastError: null,
    });
  });

  it("round-trips lastTxCount/backoffUntil/consecutiveRateLimitHits on a healthy cycle", async () => {
    const db = mutableStubDb();
    await recordBinancePollHealth(db, { lastTxCount: 2, backoffUntil: null, success: true });
    const health = await getBinancePollHealth(db);
    expect(health.lastTxCount).toBe(2);
    expect(health.backoffUntil).toBeNull();
    expect(health.consecutiveRateLimitHits).toBe(0);
    expect(health.lastRateLimitAt).toBeNull();
    expect(health.lastSuccessAt).toBe(health.lastRun);
    expect(health.consecutiveFailures).toBe(0);
  });

  it("carries lastRateLimitAt forward (sticky) once the poller recovers", async () => {
    const db = mutableStubDb();
    await recordBinancePollHealth(db, {
      lastTxCount: 0,
      backoffUntil: Date.now() + 3_000,
      consecutiveRateLimitHits: 1,
      rateLimited: true,
      success: false,
      error: "Binance rate limited (HTTP 429)",
    });
    const { lastRateLimitAt: hitAt } = await getBinancePollHealth(db);
    expect(hitAt).not.toBeNull();

    await recordBinancePollHealth(db, { lastTxCount: 4, backoffUntil: null, success: true });
    const health = await getBinancePollHealth(db);
    expect(health.consecutiveRateLimitHits).toBe(0);
    expect(health.lastRateLimitAt).toBe(hitAt);
  });

  it("getBinancePollHealth defaults missing new fields to null (backward-compat with old JSON)", async () => {
    const db = mutableStubDb({
      binance_poll_health: JSON.stringify({ lastRun: "2026-01-01T00:00:00.000Z", lastTxCount: 1, backoffUntil: null }),
    });
    const health = await getBinancePollHealth(db);
    expect(health.lastRun).toBe("2026-01-01T00:00:00.000Z");
    expect(health.lastTxCount).toBe(1);
    expect(health.consecutiveRateLimitHits).toBeNull();
    expect(health.lastRateLimitAt).toBeNull();
    expect(health.lastSuccessAt).toBeNull();
    expect(health.consecutiveFailures).toBeNull();
    expect(health.lastError).toBeNull();
  });
});

describe("Binance poll health — non-rate-limit failure streak (consecutiveFailures/lastSuccessAt/lastError)", () => {
  it("increments consecutiveFailures and records lastError on a network/HTTP failure", async () => {
    const db = mutableStubDb();
    await recordBinancePollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    const health = await getBinancePollHealth(db);
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBe("fetch failed: Connect Timeout Error");
    expect(health.lastSuccessAt).toBeNull(); // never succeeded yet

    await recordBinancePollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    expect((await getBinancePollHealth(db)).consecutiveFailures).toBe(2);
  });

  it("resets consecutiveFailures to 0 on the next success, but keeps lastError sticky", async () => {
    const db = mutableStubDb();
    await recordBinancePollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    await recordBinancePollHealth(db, { lastTxCount: 1, success: true });
    const health = await getBinancePollHealth(db);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastError).toBe("fetch failed: Connect Timeout Error"); // sticky for diagnostics
    expect(health.lastSuccessAt).toBe(health.lastRun);
  });

  it("a rate-limited failure neither increments nor resets consecutiveFailures (it has its own counter)", async () => {
    const db = mutableStubDb();
    await recordBinancePollHealth(db, { lastTxCount: 0, success: false, error: "network error" });
    expect((await getBinancePollHealth(db)).consecutiveFailures).toBe(1);

    await recordBinancePollHealth(db, {
      lastTxCount: 0,
      success: false,
      rateLimited: true,
      consecutiveRateLimitHits: 1,
      error: "Binance rate limited (HTTP 429)",
    });
    const health = await getBinancePollHealth(db);
    expect(health.consecutiveFailures).toBe(1); // unchanged by the rate-limit hit
    expect(health.consecutiveRateLimitHits).toBe(1);
  });

  it("lastSuccessAt only advances on success, even while lastRun keeps ticking on every failed cycle", async () => {
    const db = mutableStubDb();
    await recordBinancePollHealth(db, { lastTxCount: 2, success: true });
    const firstSuccess = (await getBinancePollHealth(db)).lastSuccessAt;

    await recordBinancePollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    const health = await getBinancePollHealth(db);
    expect(health.lastSuccessAt).toBe(firstSuccess); // unchanged by the failed cycle
  });
});
