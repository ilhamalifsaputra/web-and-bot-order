import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { getSetting, setSetting, deleteSetting, setEncryptedSetting, getDecryptedSetting } from "./settings";
import { isEncryptedCredentialEnvelope } from "@app/core/credentialCrypto";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("getSetting caching", () => {
  it("returns null for a missing key", async () => {
    expect(await getSetting(prisma, "does_not_exist_key")).toBeNull();
  });

  it("setSetting is immediately visible to getSetting (write-through, not stale for the TTL window)", async () => {
    await setSetting(prisma, "banner_url", "https://example.com/a.png");
    expect(await getSetting(prisma, "banner_url")).toBe("https://example.com/a.png");

    await setSetting(prisma, "banner_url", "https://example.com/b.png");
    expect(await getSetting(prisma, "banner_url")).toBe("https://example.com/b.png");
  });

  it("serves a cached value without hitting the DB again within the TTL, even after the row changes underneath it", async () => {
    await setSetting(prisma, "fx_rate", "15000");
    expect(await getSetting(prisma, "fx_rate")).toBe("15000");

    // Bypass setSetting to simulate a change the cache wouldn't know about.
    await prisma.setting.update({ where: { key: "fx_rate" }, data: { value: "16000" } });
    expect(await getSetting(prisma, "fx_rate")).toBe("15000"); // still cached
  });

  it("re-reads from the DB once the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await setSetting(prisma, "ttl_key", "first");
    expect(await getSetting(prisma, "ttl_key")).toBe("first");

    await prisma.setting.update({ where: { key: "ttl_key" }, data: { value: "second" } });
    vi.setSystemTime(31_000); // past the 30s TTL
    expect(await getSetting(prisma, "ttl_key")).toBe("second");
  });

  it("deleteSetting invalidates the cache immediately", async () => {
    await setSetting(prisma, "to_delete", "value");
    expect(await getSetting(prisma, "to_delete")).toBe("value");

    await deleteSetting(prisma, "to_delete");
    expect(await getSetting(prisma, "to_delete")).toBeNull();
  });
});

describe("setEncryptedSetting / getDecryptedSetting", () => {
  it("round-trips a plaintext value correctly", async () => {
    await setEncryptedSetting(prisma, "encrypted_roundtrip_key", "top-secret-value");
    expect(await getDecryptedSetting(prisma, "encrypted_roundtrip_key")).toBe("top-secret-value");
  });

  it("returns null for a missing key", async () => {
    expect(await getDecryptedSetting(prisma, "encrypted_missing_key")).toBeNull();
  });

  it("decrypts a legacy plaintext row written via raw setSetting (backward compat)", async () => {
    await setSetting(prisma, "encrypted_legacy_key", "legacy-plaintext-value");
    expect(await getDecryptedSetting(prisma, "encrypted_legacy_key")).toBe("legacy-plaintext-value");
  });

  it("actually encrypts the value at rest — the raw stored row is not the plaintext", async () => {
    await setEncryptedSetting(prisma, "encrypted_at_rest_key", "another-secret-value");
    const row = await prisma.setting.findUnique({ where: { key: "encrypted_at_rest_key" } });
    expect(row).not.toBeNull();
    expect(row!.value).not.toBe("another-secret-value");
    expect(isEncryptedCredentialEnvelope(row!.value)).toBe(true);
  });
});
