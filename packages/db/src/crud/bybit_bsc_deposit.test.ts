import { describe, it, expect, vi } from "vitest";

vi.mock("@app/core/config", () => ({
  config: {
    LOG_LEVEL: "info",
    BYBIT_DEPOSIT_ADDRESS: "env-deposit-address",
    BYBIT_DEPOSIT_CHAIN: "BSC",
    BYBIT_API_KEY: "env-api-key",
    BYBIT_API_SECRET: "env-api-secret",
    BYBIT_API_BASE: "https://api.bybit.com",
    BYBIT_BSC_PAYMENT_WINDOW_MINUTES: 15,
    BSCSCAN_API_BASE: "https://api.bscscan.com/api",
    BSCSCAN_API_KEY: "env-bscscan-key",
    BYBIT_BSC_REQUIRED_CONFIRMATIONS: 15,
  },
}));

import {
  resolveBybitBscConfig,
  resolveBybitBscTrackerConfig,
  getBybitBscPollHealth,
  recordBybitBscPollHealth,
} from "./bybit_bsc_deposit";
import type { Db } from "./_types";

/** Mutable in-memory Setting store backing both `findUnique` and `upsert`,
 * needed by recordBybitBscPollHealth (writes) + getBybitBscPollHealth (reads). */
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

/** In-memory Setting store as a Db stub (only `setting.findUnique` is used). */
function stubDb(values: Record<string, string>): Db {
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        values[where.key] != null ? { key: where.key, value: values[where.key] } : null,
    },
  } as unknown as Db;
}

const CREDS = {
  bybit_bsc_deposit_address: "db-deposit-address",
  bybit_api_key: "db-api-key",
  bybit_api_secret: "db-api-secret",
};

describe("resolveBybitBscConfig — enabled flag matrix", () => {
  it("enabled when creds present and flag is unset (default ON)", async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS }));
    expect(cfg.enabled).toBe(true);
  });

  it('enabled when creds present and flag is "true"', async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_enabled: "true" }));
    expect(cfg.enabled).toBe(true);
  });

  it('disabled when flag is "false" even with creds present', async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_enabled: "false" }));
    expect(cfg.enabled).toBe(false);
  });

  it('disabled when flag is "FALSE " (trimmed + case-insensitive)', async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_enabled: "FALSE " }));
    expect(cfg.enabled).toBe(false);
  });

  it('enabled when flag is blank (empty string is still default ON)', async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_enabled: "" }));
    expect(cfg.enabled).toBe(true);
  });

  it('disabled when creds missing (env fallback also empty) regardless of flag "true"', async () => {
    vi.doMock("@app/core/config", () => ({
      config: {
        LOG_LEVEL: "info",
        BYBIT_DEPOSIT_ADDRESS: undefined,
        BYBIT_DEPOSIT_CHAIN: "BSC",
        BYBIT_API_KEY: undefined,
        BYBIT_API_SECRET: undefined,
        BYBIT_API_BASE: "https://api.bybit.com",
        BYBIT_BSC_PAYMENT_WINDOW_MINUTES: 15,
      },
    }));
    vi.resetModules();
    const { resolveBybitBscConfig: resolveNoCreds } = await import("./bybit_bsc_deposit");
    const cfg = await resolveNoCreds(stubDb({ bybit_bsc_enabled: "true" }));
    expect(cfg.depositAddress).toBe("");
    expect(cfg.enabled).toBe(false);
  });
});

describe("resolveBybitBscConfig — minAmount", () => {
  it("defaults to null when unset", async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS }));
    expect(cfg.minAmount).toBeNull();
  });

  it("parses a configured positive value", async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_min_amount: "12.5" }));
    expect(cfg.minAmount?.toString()).toBe("12.5");
  });

  it("treats a non-numeric or non-positive value as null (never throws)", async () => {
    expect((await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_min_amount: "not-a-number" }))).minAmount).toBeNull();
    expect((await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_min_amount: "0" }))).minAmount).toBeNull();
    expect((await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_min_amount: "-5" }))).minAmount).toBeNull();
  });
});

describe("resolveBybitBscTrackerConfig", () => {
  it("falls back to the env BscScan key and the default required-confirmations when no Setting is configured", async () => {
    const cfg = await resolveBybitBscTrackerConfig(stubDb({}));
    expect(cfg.apiKey).toBe("env-bscscan-key");
    expect(cfg.requiredConfirmations).toBe(15);
    expect(cfg.apiBase).toBe("https://api.bscscan.com/api");
  });

  it("Setting wins over the env fallback for both the key and the confirmation count", async () => {
    const cfg = await resolveBybitBscTrackerConfig(
      stubDb({ bscscan_api_key: "db-bscscan-key", bybit_bsc_required_confirmations: "20" }),
    );
    expect(cfg.apiKey).toBe("db-bscscan-key");
    expect(cfg.requiredConfirmations).toBe(20);
  });

  it("treats a non-numeric or non-positive required-confirmations Setting as the env/default instead of throwing", async () => {
    expect((await resolveBybitBscTrackerConfig(stubDb({ bybit_bsc_required_confirmations: "not-a-number" }))).requiredConfirmations).toBe(15);
    expect((await resolveBybitBscTrackerConfig(stubDb({ bybit_bsc_required_confirmations: "0" }))).requiredConfirmations).toBe(15);
    expect((await resolveBybitBscTrackerConfig(stubDb({ bybit_bsc_required_confirmations: "-3" }))).requiredConfirmations).toBe(15);
  });
});

describe("Bybit BSC poll health — rate-limit tracking fields", () => {
  it("getBybitBscPollHealth on a never-run poller is all-null", async () => {
    const health = await getBybitBscPollHealth(mutableStubDb());
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
    await recordBybitBscPollHealth(db, { lastTxCount: 3, backoffUntil: null, success: true });
    const health = await getBybitBscPollHealth(db);
    expect(health.lastTxCount).toBe(3);
    expect(health.backoffUntil).toBeNull();
    expect(health.consecutiveRateLimitHits).toBe(0);
    expect(health.lastRateLimitAt).toBeNull();
    expect(health.lastSuccessAt).toBe(health.lastRun);
    expect(health.consecutiveFailures).toBe(0);
  });

  it("records lastRateLimitAt when rateLimited is true", async () => {
    const db = mutableStubDb();
    const until = Date.now() + 6_000;
    await recordBybitBscPollHealth(db, {
      lastTxCount: 0,
      backoffUntil: until,
      consecutiveRateLimitHits: 2,
      rateLimited: true,
      success: false,
      error: "Bybit rate limited (HTTP 429)",
    });
    const health = await getBybitBscPollHealth(db);
    expect(health.consecutiveRateLimitHits).toBe(2);
    expect(health.backoffUntil).toBe(new Date(until).toISOString());
    expect(health.lastRateLimitAt).not.toBeNull();
  });
});

describe("Bybit BSC poll health — non-rate-limit failure streak", () => {
  it("increments consecutiveFailures and records lastError on a network/HTTP failure", async () => {
    const db = mutableStubDb();
    await recordBybitBscPollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    const health = await getBybitBscPollHealth(db);
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBe("fetch failed: Connect Timeout Error");
    expect(health.lastSuccessAt).toBeNull(); // never succeeded yet
  });

  it("resets consecutiveFailures to 0 on the next success, but keeps lastError sticky", async () => {
    const db = mutableStubDb();
    await recordBybitBscPollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    await recordBybitBscPollHealth(db, { lastTxCount: 1, success: true });
    const health = await getBybitBscPollHealth(db);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastError).toBe("fetch failed: Connect Timeout Error"); // sticky for diagnostics
    expect(health.lastSuccessAt).toBe(health.lastRun);
  });
});
