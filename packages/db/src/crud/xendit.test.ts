import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { getXenditCreds, setSetting, setEncryptedSetting, ENCRYPTED_SETTING_KEYS } from "@app/db";
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

describe("getXenditCreds", () => {
  it("is null when nothing is configured", async () => {
    expect(await getXenditCreds(prisma)).toBeNull();
  });

  it("is null when the callback token is missing", async () => {
    await setSetting(prisma, "xendit_secret_key", "xnd_development_k");
    expect(await getXenditCreds(prisma)).toBeNull();
  });

  it("is null when the secret key is missing", async () => {
    await setSetting(prisma, "xendit_callback_token", "tok");
    expect(await getXenditCreds(prisma)).toBeNull();
  });

  it("is null when explicitly disabled", async () => {
    await setSetting(prisma, "xendit_secret_key", "xnd_development_k");
    await setSetting(prisma, "xendit_callback_token", "tok");
    await setSetting(prisma, "xendit_enabled", "false");
    expect(await getXenditCreds(prisma)).toBeNull();
  });

  it("lists both secrets as encrypted-at-rest keys", () => {
    expect(ENCRYPTED_SETTING_KEYS.has("xendit_secret_key")).toBe(true);
    expect(ENCRYPTED_SETTING_KEYS.has("xendit_callback_token")).toBe(true);
  });

  it("decrypts encrypted values and defaults channel flags to false", async () => {
    await setEncryptedSetting(prisma, "xendit_secret_key", "xnd_development_k");
    await setSetting(prisma, "xendit_callback_token", encryptCredentials("tok", settingValueAad("xendit_callback_token")));
    expect(await getXenditCreds(prisma)).toEqual({
      secretKey: "xnd_development_k",
      callbackToken: "tok",
      qrisEnabled: false,
      cardEnabled: false,
    });
  });

  it("reads the channel switches", async () => {
    await setSetting(prisma, "xendit_secret_key", "xnd_production_k");
    await setSetting(prisma, "xendit_callback_token", "tok");
    await setSetting(prisma, "xendit_qris_enabled", "true");
    await setSetting(prisma, "xendit_card_enabled", "false");
    const creds = await getXenditCreds(prisma);
    expect(creds?.qrisEnabled).toBe(true);
    expect(creds?.cardEnabled).toBe(false);
  });
});
