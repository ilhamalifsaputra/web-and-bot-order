import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { getPayMethodDisplayFlags, getXenditCreds, setSetting } from "@app/db";

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

const xendit = async (qris: string, card: string) => {
  await setSetting(prisma, "xendit_secret_key", "xnd_development_k");
  await setSetting(prisma, "xendit_callback_token", "tok");
  await setSetting(prisma, "xendit_qris_enabled", qris);
  await setSetting(prisma, "xendit_card_enabled", card);
};

describe("getPayMethodDisplayFlags", () => {
  it("both false when nothing is configured", async () => {
    expect(await getPayMethodDisplayFlags(prisma)).toEqual({ qris: false, card: false });
  });

  it("TokoPay or PayDisini alone enables qris; a missing half does not", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    expect(await getPayMethodDisplayFlags(prisma)).toEqual({ qris: false, card: false });
    await setSetting(prisma, "tokopay_secret", "s");
    expect(await getPayMethodDisplayFlags(prisma)).toEqual({ qris: true, card: false });
    await setSetting(prisma, "tokopay_enabled", "false");
    expect(await getPayMethodDisplayFlags(prisma)).toEqual({ qris: false, card: false });
    await setSetting(prisma, "paydisini_userkey", "u");
    await setSetting(prisma, "paydisini_apikey", "a");
    expect(await getPayMethodDisplayFlags(prisma)).toEqual({ qris: true, card: false });
  });

  it("Xendit qris/card follow their switches and the master switch", async () => {
    await xendit("true", "false");
    expect(await getPayMethodDisplayFlags(prisma)).toEqual({ qris: true, card: false });
    await xendit("false", "true");
    expect(await getPayMethodDisplayFlags(prisma)).toEqual({ qris: false, card: true });
    await xendit("true", "true");
    expect(await getPayMethodDisplayFlags(prisma)).toEqual({ qris: true, card: true });
    await setSetting(prisma, "xendit_enabled", "false");
    expect(await getPayMethodDisplayFlags(prisma)).toEqual({ qris: false, card: false });
  });

  it("does not throw on an undecryptable secret (unlike getXenditCreds)", async () => {
    await xendit("true", "true");
    await setSetting(prisma, "xendit_secret_key", '{"keyVersion":1,"iv":"x","ciphertext":"x","authTag":"x"}');
    await expect(getXenditCreds(prisma)).rejects.toThrow();
    expect(await getPayMethodDisplayFlags(prisma)).toEqual({ qris: true, card: true });
  });
});
