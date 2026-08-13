import { describe, it, expect } from "vitest";
import { getPollHealth, recordPollHealth, POLL_HEALTH_KEYS } from "./poll_health";
import { getBinancePollHealth, recordBinancePollHealth, BINANCE_POLL_HEALTH_KEY } from "./binance_internal";
import type { Db } from "./_types";

/** Mutable in-memory Setting store backing both `findUnique` and `upsert`,
 * needed by recordPollHealth (writes) + getPollHealth (reads). Mirrors the
 * stub in binance_internal_poll_health.test.ts so the same semantics can be
 * pinned against the generic API. */
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

describe("Generic poll health — rate-limit tracking fields", () => {
  it("getPollHealth on a never-run poller is all-null", async () => {
    const health = await getPollHealth(mutableStubDb(), "tokopay");
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
    await recordPollHealth(db, "tokopay", { lastTxCount: 2, backoffUntil: null, success: true });
    const health = await getPollHealth(db, "tokopay");
    expect(health.lastTxCount).toBe(2);
    expect(health.backoffUntil).toBeNull();
    expect(health.consecutiveRateLimitHits).toBe(0);
    expect(health.lastRateLimitAt).toBeNull();
    expect(health.lastSuccessAt).toBe(health.lastRun);
    expect(health.consecutiveFailures).toBe(0);
  });

  it("carries lastRateLimitAt forward (sticky) once the poller recovers", async () => {
    const db = mutableStubDb();
    await recordPollHealth(db, "tokopay", {
      lastTxCount: 0,
      backoffUntil: Date.now() + 3_000,
      consecutiveRateLimitHits: 1,
      rateLimited: true,
      success: false,
      error: "TokoPay rate limited (HTTP 429)",
    });
    const { lastRateLimitAt: hitAt } = await getPollHealth(db, "tokopay");
    expect(hitAt).not.toBeNull();

    await recordPollHealth(db, "tokopay", { lastTxCount: 4, backoffUntil: null, success: true });
    const health = await getPollHealth(db, "tokopay");
    expect(health.consecutiveRateLimitHits).toBe(0);
    expect(health.lastRateLimitAt).toBe(hitAt);
  });

  it("getPollHealth defaults missing new fields to null (backward-compat with old JSON)", async () => {
    const db = mutableStubDb({
      [POLL_HEALTH_KEYS.tokopay]: JSON.stringify({ lastRun: "2026-01-01T00:00:00.000Z", lastTxCount: 1, backoffUntil: null }),
    });
    const health = await getPollHealth(db, "tokopay");
    expect(health.lastRun).toBe("2026-01-01T00:00:00.000Z");
    expect(health.lastTxCount).toBe(1);
    expect(health.consecutiveRateLimitHits).toBeNull();
    expect(health.lastRateLimitAt).toBeNull();
    expect(health.lastSuccessAt).toBeNull();
    expect(health.consecutiveFailures).toBeNull();
    expect(health.lastError).toBeNull();
  });
});

describe("Generic poll health — non-rate-limit failure streak (consecutiveFailures/lastSuccessAt/lastError)", () => {
  it("increments consecutiveFailures and records lastError on a network/HTTP failure", async () => {
    const db = mutableStubDb();
    await recordPollHealth(db, "paydisini", { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    const health = await getPollHealth(db, "paydisini");
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBe("fetch failed: Connect Timeout Error");
    expect(health.lastSuccessAt).toBeNull(); // never succeeded yet

    await recordPollHealth(db, "paydisini", { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    expect((await getPollHealth(db, "paydisini")).consecutiveFailures).toBe(2);
  });

  it("resets consecutiveFailures to 0 on the next success, but keeps lastError sticky", async () => {
    const db = mutableStubDb();
    await recordPollHealth(db, "paydisini", { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    await recordPollHealth(db, "paydisini", { lastTxCount: 1, success: true });
    const health = await getPollHealth(db, "paydisini");
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastError).toBe("fetch failed: Connect Timeout Error"); // sticky for diagnostics
    expect(health.lastSuccessAt).toBe(health.lastRun);
  });

  it("a rate-limited failure neither increments nor resets consecutiveFailures (it has its own counter)", async () => {
    const db = mutableStubDb();
    await recordPollHealth(db, "paydisini", { lastTxCount: 0, success: false, error: "network error" });
    expect((await getPollHealth(db, "paydisini")).consecutiveFailures).toBe(1);

    await recordPollHealth(db, "paydisini", {
      lastTxCount: 0,
      success: false,
      rateLimited: true,
      consecutiveRateLimitHits: 1,
      error: "PayDisini rate limited (HTTP 429)",
    });
    const health = await getPollHealth(db, "paydisini");
    expect(health.consecutiveFailures).toBe(1); // unchanged by the rate-limit hit
    expect(health.consecutiveRateLimitHits).toBe(1);
  });

  it("lastSuccessAt only advances on success, even while lastRun keeps ticking on every failed cycle", async () => {
    const db = mutableStubDb();
    await recordPollHealth(db, "paydisini", { lastTxCount: 2, success: true });
    const firstSuccess = (await getPollHealth(db, "paydisini")).lastSuccessAt;

    await recordPollHealth(db, "paydisini", { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    const health = await getPollHealth(db, "paydisini");
    expect(health.lastSuccessAt).toBe(firstSuccess); // unchanged by the failed cycle
  });
});

describe("Generic poll health — multi-rail isolation and backward compatibility", () => {
  it("two rails keep independent heartbeats", async () => {
    const db = mutableStubDb();
    await recordPollHealth(db, "tokopay", { lastTxCount: 3, success: true });
    await recordPollHealth(db, "paydisini", { lastTxCount: 0, success: false, error: "gateway timeout" });

    const tokopay = await getPollHealth(db, "tokopay");
    const paydisini = await getPollHealth(db, "paydisini");

    expect(tokopay.lastTxCount).toBe(3);
    expect(tokopay.consecutiveFailures).toBe(0);
    expect(tokopay.lastError).toBeNull();

    expect(paydisini.lastTxCount).toBe(0);
    expect(paydisini.consecutiveFailures).toBe(1);
    expect(paydisini.lastError).toBe("gateway timeout");

    // Untouched rails stay all-null.
    expect(await getPollHealth(db, "nowpayments")).toEqual({
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

  it("reads a heartbeat blob written by the old per-rail writer", async () => {
    // Existing production key/writer (packages/db/src/crud/binance_internal.ts)
    // must keep working through the new generic reader with no migration.
    expect(POLL_HEALTH_KEYS.binance).toBe(BINANCE_POLL_HEALTH_KEY);

    const db = mutableStubDb();
    await recordBinancePollHealth(db, {
      lastTxCount: 5,
      backoffUntil: Date.now() + 10_000,
      consecutiveRateLimitHits: 1,
      rateLimited: true,
      success: false,
      error: "Binance rate limited (HTTP 429)",
    });

    const viaOldReader = await getBinancePollHealth(db);
    const viaGenericReader = await getPollHealth(db, "binance");
    expect(viaGenericReader).toEqual(viaOldReader);
  });
});
