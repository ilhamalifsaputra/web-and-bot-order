/**
 * Tests for getDigiflazzWebhookSecret — same makeTestDb + resetDb shape as
 * kokinpay.test.ts / digiflazz.test.ts's getDigiflazzCreds tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import {
  getDigiflazzWebhookSecret,
  setSetting,
  deleteSetting,
  setEncryptedSetting,
  ENCRYPTED_SETTING_KEYS,
  DIGIFLAZZ_WEBHOOK_SECRET_KEY,
} from "@app/db";
import { encryptCredentials, settingValueAad } from "@app/core/credentialCrypto";

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

describe("getDigiflazzWebhookSecret", () => {
  it("uses the digiflazz_webhook_secret setting key and stores it encrypted at rest", () => {
    expect(DIGIFLAZZ_WEBHOOK_SECRET_KEY).toBe("digiflazz_webhook_secret");
    expect(ENCRYPTED_SETTING_KEYS.has(DIGIFLAZZ_WEBHOOK_SECRET_KEY)).toBe(true);
  });

  it("returns null when no webhook secret is configured", async () => {
    await deleteSetting(prisma, DIGIFLAZZ_WEBHOOK_SECRET_KEY);
    expect(await getDigiflazzWebhookSecret(prisma)).toBeNull();
  });

  it("returns null for a blank stored value", async () => {
    await setSetting(prisma, DIGIFLAZZ_WEBHOOK_SECRET_KEY, "   ");
    expect(await getDigiflazzWebhookSecret(prisma)).toBeNull();
  });

  it("decrypts a secret stored as an encrypted envelope", async () => {
    await setSetting(
      prisma,
      DIGIFLAZZ_WEBHOOK_SECRET_KEY,
      encryptCredentials("real-webhook-secret", settingValueAad(DIGIFLAZZ_WEBHOOK_SECRET_KEY)),
    );
    expect(await getDigiflazzWebhookSecret(prisma)).toBe("real-webhook-secret");
  });

  it("round-trips through setEncryptedSetting without the raw secret landing in the row", async () => {
    await setEncryptedSetting(prisma, DIGIFLAZZ_WEBHOOK_SECRET_KEY, "rotated-secret");
    const row = await prisma.setting.findUnique({ where: { key: DIGIFLAZZ_WEBHOOK_SECRET_KEY } });
    expect(row?.value).not.toContain("rotated-secret");
    expect(await getDigiflazzWebhookSecret(prisma)).toBe("rotated-secret");
  });
});
