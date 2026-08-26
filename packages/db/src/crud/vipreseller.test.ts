/**
 * Tests for getVipResellerCreds — mirrors crud/kokinpay.test.ts's shape,
 * except VIP-Reseller needs TWO credential values (api_id + api_key), both
 * required.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { getVipResellerCreds, setSetting, deleteSetting, VIPRESELLER_API_ID_KEY, VIPRESELLER_API_KEY_KEY } from "@app/db";
import { encryptCredentials } from "@app/core/credentialCrypto";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
});

describe("getVipResellerCreds", () => {
  it("returns credentials when both api_id and api_key are set", async () => {
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-api-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-api-key");
    expect(await getVipResellerCreds(prisma)).toEqual({ apiId: "vip-api-id", apiKey: "vip-api-key" });
  });

  it("returns null when api_id is missing", async () => {
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-api-key");
    await deleteSetting(prisma, VIPRESELLER_API_ID_KEY);
    expect(await getVipResellerCreds(prisma)).toBeNull();
  });

  it("returns null when api_key is missing", async () => {
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-api-id");
    await deleteSetting(prisma, VIPRESELLER_API_KEY_KEY);
    expect(await getVipResellerCreds(prisma)).toBeNull();
  });

  it("returns null when both are missing", async () => {
    await deleteSetting(prisma, VIPRESELLER_API_ID_KEY);
    await deleteSetting(prisma, VIPRESELLER_API_KEY_KEY);
    expect(await getVipResellerCreds(prisma)).toBeNull();
  });

  it("decrypts the API key when stored as an encrypted envelope, api_id stays plain (Task 13)", async () => {
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-api-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, encryptCredentials("real-vipreseller-apikey"));
    expect(await getVipResellerCreds(prisma)).toEqual({ apiId: "vip-api-id", apiKey: "real-vipreseller-apikey" });
  });
});
