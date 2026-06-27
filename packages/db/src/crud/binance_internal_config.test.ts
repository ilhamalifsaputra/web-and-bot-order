import { describe, it, expect, vi } from "vitest";

vi.mock("@app/core/config", () => ({
  config: {
    LOG_LEVEL: "info",
    BINANCE_RECEIVE_UID: "env-uid",
    BINANCE_API_KEY: "env-api-key",
    BINANCE_API_SECRET: "env-api-secret",
    BINANCE_API_BASE: "https://api.binance.com",
    BINANCE_API_BASE_FALLBACKS: "https://api1.binance.com,https://api2.binance.com,https://api3.binance.com,https://api4.binance.com,https://api-gcp.binance.com",
    CURRENCY: "USDT",
    POLL_INTERVAL_SECONDS: 10,
    INTERNAL_PAYMENT_WINDOW_MINUTES: 15,
  },
}));

import { resolveBinanceInternalConfig } from "./binance_internal";
import type { Db } from "./_types";

/** In-memory Setting store as a Db stub (only `setting.findUnique` is used). */
function stubDb(values: Record<string, string>): Db {
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        values[where.key] != null ? { key: where.key, value: values[where.key] } : null,
    },
  } as unknown as Db;
}

describe("resolveBinanceInternalConfig", () => {
  it("DB Settings win over env fallback", async () => {
    const cfg = await resolveBinanceInternalConfig(
      stubDb({
        binance_receive_uid: "db-uid",
        binance_api_key: "db-api-key",
        binance_api_secret: "db-api-secret",
      }),
    );
    expect(cfg.receiveUid).toBe("db-uid");
    expect(cfg.apiKey).toBe("db-api-key");
    expect(cfg.apiSecret).toBe("db-api-secret");
    expect(cfg.enabled).toBe(true);
  });

  it("falls back to env config when DB settings are absent", async () => {
    const cfg = await resolveBinanceInternalConfig(stubDb({}));
    expect(cfg.receiveUid).toBe("env-uid");
    expect(cfg.apiKey).toBe("env-api-key");
    expect(cfg.apiSecret).toBe("env-api-secret");
    expect(cfg.enabled).toBe(true);
  });

  it("falls back to env config when DB settings are blank strings", async () => {
    const cfg = await resolveBinanceInternalConfig(
      stubDb({ binance_receive_uid: "  ", binance_api_key: "", binance_api_secret: "  " }),
    );
    expect(cfg.receiveUid).toBe("env-uid");
    expect(cfg.apiKey).toBe("env-api-key");
    expect(cfg.apiSecret).toBe("env-api-secret");
    expect(cfg.enabled).toBe(true);
  });

  it("carries env-only fields through unchanged", async () => {
    const cfg = await resolveBinanceInternalConfig(stubDb({}));
    expect(cfg.apiBase).toBe("https://api.binance.com");
    expect(cfg.apiBaseFallbacks).toEqual([
      "https://api1.binance.com",
      "https://api2.binance.com",
      "https://api3.binance.com",
      "https://api4.binance.com",
      "https://api-gcp.binance.com",
    ]);
    expect(cfg.currency).toBe("USDT");
    expect(cfg.pollIntervalSeconds).toBe(10);
    expect(cfg.windowMinutes).toBe(15);
  });

  it("enabled is false when the uid is missing", async () => {
    vi.doMock("@app/core/config", () => ({
      config: {
        LOG_LEVEL: "info",
        BINANCE_RECEIVE_UID: undefined,
        BINANCE_API_KEY: "env-api-key",
        BINANCE_API_SECRET: "env-api-secret",
        BINANCE_API_BASE: "https://api.binance.com",
        BINANCE_API_BASE_FALLBACKS: "https://api1.binance.com,https://api2.binance.com",
        CURRENCY: "USDT",
        POLL_INTERVAL_SECONDS: 10,
        INTERNAL_PAYMENT_WINDOW_MINUTES: 15,
      },
    }));
    vi.resetModules();
    const { resolveBinanceInternalConfig: resolveWithMissingUid } = await import("./binance_internal");
    const cfg = await resolveWithMissingUid(stubDb({}));
    expect(cfg.receiveUid).toBe("");
    expect(cfg.enabled).toBe(false);
  });

  it("enabled is false when the apiKey is missing", async () => {
    vi.doMock("@app/core/config", () => ({
      config: {
        LOG_LEVEL: "info",
        BINANCE_RECEIVE_UID: "env-uid",
        BINANCE_API_KEY: undefined,
        BINANCE_API_SECRET: "env-api-secret",
        BINANCE_API_BASE: "https://api.binance.com",
        BINANCE_API_BASE_FALLBACKS: "https://api1.binance.com,https://api2.binance.com",
        CURRENCY: "USDT",
        POLL_INTERVAL_SECONDS: 10,
        INTERNAL_PAYMENT_WINDOW_MINUTES: 15,
      },
    }));
    vi.resetModules();
    const { resolveBinanceInternalConfig: resolveWithMissingKey } = await import("./binance_internal");
    const cfg = await resolveWithMissingKey(stubDb({}));
    expect(cfg.apiKey).toBe("");
    expect(cfg.enabled).toBe(false);
  });

  // ---- On/off toggle flag matrix (binance_internal_enabled) ----
  const CREDS = {
    binance_receive_uid: "db-uid",
    binance_api_key: "db-api-key",
    binance_api_secret: "db-api-secret",
  };

  it("enabled when creds present and flag is unset (default ON)", async () => {
    const cfg = await resolveBinanceInternalConfig(stubDb({ ...CREDS }));
    expect(cfg.enabled).toBe(true);
  });

  it('enabled when creds present and flag is "true"', async () => {
    const cfg = await resolveBinanceInternalConfig(stubDb({ ...CREDS, binance_internal_enabled: "true" }));
    expect(cfg.enabled).toBe(true);
  });

  it('disabled when flag is "false" even with creds present', async () => {
    const cfg = await resolveBinanceInternalConfig(stubDb({ ...CREDS, binance_internal_enabled: "false" }));
    expect(cfg.enabled).toBe(false);
  });

  it('disabled when flag is "FALSE " (trimmed + case-insensitive)', async () => {
    const cfg = await resolveBinanceInternalConfig(stubDb({ ...CREDS, binance_internal_enabled: "FALSE " }));
    expect(cfg.enabled).toBe(false);
  });

  it("enabled when flag is blank (empty string is still default ON)", async () => {
    const cfg = await resolveBinanceInternalConfig(stubDb({ ...CREDS, binance_internal_enabled: "" }));
    expect(cfg.enabled).toBe(true);
  });

  it("enabled is false when the apiSecret is missing", async () => {
    vi.doMock("@app/core/config", () => ({
      config: {
        LOG_LEVEL: "info",
        BINANCE_RECEIVE_UID: "env-uid",
        BINANCE_API_KEY: "env-api-key",
        BINANCE_API_SECRET: undefined,
        BINANCE_API_BASE: "https://api.binance.com",
        BINANCE_API_BASE_FALLBACKS: "https://api1.binance.com,https://api2.binance.com",
        CURRENCY: "USDT",
        POLL_INTERVAL_SECONDS: 10,
        INTERNAL_PAYMENT_WINDOW_MINUTES: 15,
      },
    }));
    vi.resetModules();
    const { resolveBinanceInternalConfig: resolveWithMissingSecret } = await import("./binance_internal");
    const cfg = await resolveWithMissingSecret(stubDb({}));
    expect(cfg.apiSecret).toBe("");
    expect(cfg.enabled).toBe(false);
  });
});

describe("resolveBinanceInternalConfig — apiBaseFallbacks CSV parsing", () => {
  it("parses the default 5-mirror CSV into trimmed URLs, in order", async () => {
    const cfg = await resolveBinanceInternalConfig(stubDb({}));
    expect(cfg.apiBaseFallbacks).toEqual([
      "https://api1.binance.com",
      "https://api2.binance.com",
      "https://api3.binance.com",
      "https://api4.binance.com",
      "https://api-gcp.binance.com",
    ]);
  });

  it("trims whitespace around each entry", async () => {
    vi.doMock("@app/core/config", () => ({
      config: {
        LOG_LEVEL: "info",
        BINANCE_RECEIVE_UID: "env-uid",
        BINANCE_API_KEY: "env-api-key",
        BINANCE_API_SECRET: "env-api-secret",
        BINANCE_API_BASE: "https://api.binance.com",
        BINANCE_API_BASE_FALLBACKS: " https://a.com , https://b.com ",
        CURRENCY: "USDT",
        POLL_INTERVAL_SECONDS: 10,
        INTERNAL_PAYMENT_WINDOW_MINUTES: 15,
      },
    }));
    vi.resetModules();
    const { resolveBinanceInternalConfig: resolveWithWhitespace } = await import("./binance_internal");
    const cfg = await resolveWithWhitespace(stubDb({}));
    expect(cfg.apiBaseFallbacks).toEqual(["https://a.com", "https://b.com"]);
  });

  it("parses an empty string into an empty array (fallback disabled)", async () => {
    vi.doMock("@app/core/config", () => ({
      config: {
        LOG_LEVEL: "info",
        BINANCE_RECEIVE_UID: "env-uid",
        BINANCE_API_KEY: "env-api-key",
        BINANCE_API_SECRET: "env-api-secret",
        BINANCE_API_BASE: "https://api.binance.com",
        BINANCE_API_BASE_FALLBACKS: "",
        CURRENCY: "USDT",
        POLL_INTERVAL_SECONDS: 10,
        INTERNAL_PAYMENT_WINDOW_MINUTES: 15,
      },
    }));
    vi.resetModules();
    const { resolveBinanceInternalConfig: resolveWithEmpty } = await import("./binance_internal");
    const cfg = await resolveWithEmpty(stubDb({}));
    expect(cfg.apiBaseFallbacks).toEqual([]);
  });

  it("filters out empty segments from stray/double commas", async () => {
    vi.doMock("@app/core/config", () => ({
      config: {
        LOG_LEVEL: "info",
        BINANCE_RECEIVE_UID: "env-uid",
        BINANCE_API_KEY: "env-api-key",
        BINANCE_API_SECRET: "env-api-secret",
        BINANCE_API_BASE: "https://api.binance.com",
        BINANCE_API_BASE_FALLBACKS: "https://a.com,,https://b.com,",
        CURRENCY: "USDT",
        POLL_INTERVAL_SECONDS: 10,
        INTERNAL_PAYMENT_WINDOW_MINUTES: 15,
      },
    }));
    vi.resetModules();
    const { resolveBinanceInternalConfig: resolveWithStrayCommas } = await import("./binance_internal");
    const cfg = await resolveWithStrayCommas(stubDb({}));
    expect(cfg.apiBaseFallbacks).toEqual(["https://a.com", "https://b.com"]);
  });
});
