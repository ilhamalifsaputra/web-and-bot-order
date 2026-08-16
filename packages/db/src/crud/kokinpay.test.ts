/**
 * Tests for getKokinpayCreds — mirrors crud/digiflazz.test.ts's
 * getDigiflazzCreds tests (makeTestDb + resetDb shape).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { getKokinpayCreds, setSetting, deleteSetting, KOKINPAY_API_KEY_KEY } from "@app/db";

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

describe("getKokinpayCreds", () => {
  it("returns credentials when the API key is set", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    expect(await getKokinpayCreds(prisma)).toEqual({ apiKey: "kp-key" });
  });

  it("returns null when no API key is configured", async () => {
    await deleteSetting(prisma, KOKINPAY_API_KEY_KEY);
    expect(await getKokinpayCreds(prisma)).toBeNull();
  });
});
