/**
 * Tests for getMelostoreCreds — mirrors crud/kokinpay.test.ts's shape.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { getMelostoreCreds, setSetting, deleteSetting, MELOSTORE_API_KEY_KEY, MELOSTORE_SECRET_KEY_KEY } from "@app/db";
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

describe("getMelostoreCreds", () => {
  it("returns credentials when both API key and secret key are set", async () => {
    await setSetting(prisma, MELOSTORE_API_KEY_KEY, "melo-api-key");
    await setSetting(prisma, MELOSTORE_SECRET_KEY_KEY, "melo-secret-key");
    expect(await getMelostoreCreds(prisma)).toEqual({ apiKey: "melo-api-key", secretKey: "melo-secret-key" });
  });

  it("returns null when API key is missing", async () => {
    await setSetting(prisma, MELOSTORE_SECRET_KEY_KEY, "melo-secret-key");
    await deleteSetting(prisma, MELOSTORE_API_KEY_KEY);
    expect(await getMelostoreCreds(prisma)).toBeNull();
  });

  it("returns null when secret key is missing", async () => {
    await setSetting(prisma, MELOSTORE_API_KEY_KEY, "melo-api-key");
    await deleteSetting(prisma, MELOSTORE_SECRET_KEY_KEY);
    expect(await getMelostoreCreds(prisma)).toBeNull();
  });

  it("returns null when both keys are missing", async () => {
    await deleteSetting(prisma, MELOSTORE_API_KEY_KEY);
    await deleteSetting(prisma, MELOSTORE_SECRET_KEY_KEY);
    expect(await getMelostoreCreds(prisma)).toBeNull();
  });

  it("decrypts both the API key and secret key when stored as encrypted envelopes (Task 13)", async () => {
    await setSetting(prisma, MELOSTORE_API_KEY_KEY, encryptCredentials("real-melostore-apikey"));
    await setSetting(prisma, MELOSTORE_SECRET_KEY_KEY, encryptCredentials("real-melostore-secretkey"));
    expect(await getMelostoreCreds(prisma)).toEqual({ apiKey: "real-melostore-apikey", secretKey: "real-melostore-secretkey" });
  });
});
