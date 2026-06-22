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
      lastTxCount: null,
      backoffUntil: null,
      consecutiveRateLimitHits: null,
      lastRateLimitAt: null,
    });
  });

  it("round-trips lastTxCount/backoffUntil/consecutiveRateLimitHits on a healthy cycle", async () => {
    const db = mutableStubDb();
    await recordBinancePollHealth(db, { lastTxCount: 2, backoffUntil: null });
    const health = await getBinancePollHealth(db);
    expect(health.lastTxCount).toBe(2);
    expect(health.backoffUntil).toBeNull();
    expect(health.consecutiveRateLimitHits).toBe(0);
    expect(health.lastRateLimitAt).toBeNull();
  });

  it("carries lastRateLimitAt forward (sticky) once the poller recovers", async () => {
    const db = mutableStubDb();
    await recordBinancePollHealth(db, { lastTxCount: 0, backoffUntil: Date.now() + 3_000, consecutiveRateLimitHits: 1, rateLimited: true });
    const { lastRateLimitAt: hitAt } = await getBinancePollHealth(db);
    expect(hitAt).not.toBeNull();

    await recordBinancePollHealth(db, { lastTxCount: 4, backoffUntil: null });
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
  });
});
