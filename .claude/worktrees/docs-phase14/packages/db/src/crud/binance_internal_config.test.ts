import { describe, it, expect, vi } from "vitest";

vi.mock("@app/core/config", () => ({
  config: {
    LOG_LEVEL: "info",
    BINANCE_RECEIVE_UID: "env-uid",
    BINANCE_API_KEY: "env-api-key",
    BINANCE_API_SECRET: "env-api-secret",
    BINANCE_API_BASE: "https://api.binance.com",
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

  it("enabled is false when the apiSecret is missing", async () => {
    vi.doMock("@app/core/config", () => ({
      config: {
        LOG_LEVEL: "info",
        BINANCE_RECEIVE_UID: "env-uid",
        BINANCE_API_KEY: "env-api-key",
        BINANCE_API_SECRET: undefined,
        BINANCE_API_BASE: "https://api.binance.com",
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
