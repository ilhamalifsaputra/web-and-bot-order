/**
 * The customer-data backfill must encrypt every legacy plaintext row, leave
 * encrypted rows alone (idempotent), count but never rewrite a corrupt
 * envelope, write nothing on a dry run, and never print the answers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  credentialEnvelopeVersion,
  decryptCustomerData,
  encryptCustomerData,
  isEncryptedCredentialEnvelope,
} from "@app/core/credentialCrypto";
import { makeTestDb, type TestDb } from "../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../tests/helpers/sampleData";
import { createOrderDirect } from "../packages/db/src/crud/orders";
import { backfillEncryptCustomerData } from "./backfill-encrypt-customer-data";
import { useEnvelopeWriteV2, encryptLegacyV1 } from "../tests/helpers/envelopeFlag";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

async function orderWithStored(stored: string | null): Promise<number> {
  const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1, channel: "bot" }))!;
  await prisma.order.update({ where: { id: order.id }, data: { customerData: stored } });
  return order.id;
}

function corruptEnvelope(): string {
  const good = JSON.parse(encryptLegacyV1('[{"game_id":"Corrupt9"}]')) as Record<string, unknown>;
  return JSON.stringify({ ...good, authTag: Buffer.alloc(16).toString("base64") });
}

async function rawAnswers(id: number) {
  return (await prisma.order.findUniqueOrThrow({ where: { id } })).customerData;
}

describe("backfillEncryptCustomerData", () => {
  it("encrypts plaintext rows, skips encrypted and null rows, and counts a corrupt envelope without touching it", async () => {
    const legacyA = await orderWithStored('[{"game_id":"111"}]');
    const legacyB = await orderWithStored('[{"email":"buyer@example.com"},{"email":"two@example.com"}]');
    const already = encryptLegacyV1('[{"game_id":"222"}]');
    const alreadyId = await orderWithStored(already);
    const corrupt = corruptEnvelope();
    const corruptId = await orderWithStored(corrupt);
    const nullId = await orderWithStored(null);

    const report = await backfillEncryptCustomerData(prisma);

    expect(report).toEqual({ scanned: 4, plaintext: 2, encrypted: 2, alreadyEncrypted: 1, corrupt: 1, changedDuringRun: 0 });
    for (const [id, plain] of [[legacyA, '[{"game_id":"111"}]'], [legacyB, '[{"email":"buyer@example.com"},{"email":"two@example.com"}]']] as const) {
      const stored = await rawAnswers(id);
      expect(isEncryptedCredentialEnvelope(stored!)).toBe(true);
      expect(decryptCustomerData(stored, id)).toBe(plain);
    }
    expect(await rawAnswers(alreadyId)).toBe(already);
    expect(await rawAnswers(corruptId)).toBe(corrupt);
    expect(await rawAnswers(nullId)).toBeNull();
  });

  it("is idempotent: a second run rewrites nothing", async () => {
    const id = await orderWithStored('[{"game_id":"333"}]');
    await backfillEncryptCustomerData(prisma);
    const afterFirst = await rawAnswers(id);

    const second = await backfillEncryptCustomerData(prisma);

    expect(second).toEqual({ scanned: 1, plaintext: 0, encrypted: 0, alreadyEncrypted: 1, corrupt: 0, changedDuringRun: 0 });
    expect(await rawAnswers(id)).toBe(afterFirst);
  });

  it("dry run counts plaintext rows but writes nothing", async () => {
    const id = await orderWithStored('[{"game_id":"444"}]');

    const report = await backfillEncryptCustomerData(prisma, { dryRun: true });

    expect(report).toMatchObject({ scanned: 1, plaintext: 1, encrypted: 0 });
    expect(await rawAnswers(id)).toBe('[{"game_id":"444"}]');
  });

  it("never prints the answers", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await orderWithStored('[{"game_id":"SECRET-ANSWER-555"}]');
      await backfillEncryptCustomerData(prisma);
      expect(JSON.stringify([log.mock.calls, error.mock.calls])).not.toContain("SECRET-ANSWER-555");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe.each([false, true])("backfillEncryptCustomerData with CREDENTIAL_ENVELOPE_WRITE_V2 %s", (on) => {
  useEnvelopeWriteV2(on);

  it("writes the flag's envelope version bound to the order, and counts an envelope bound to its own order as encrypted", async () => {
    const legacyId = await orderWithStored('[{"game_id":"666"}]');
    const boundId = await orderWithStored(null);
    await prisma.order.update({ where: { id: boundId }, data: { customerData: encryptCustomerData('[{"game_id":"777"}]', boundId) } });

    const report = await backfillEncryptCustomerData(prisma);

    expect(report).toMatchObject({ plaintext: 1, encrypted: 1, alreadyEncrypted: 1, corrupt: 0 });
    const stored = (await rawAnswers(legacyId))!;
    expect(credentialEnvelopeVersion(stored)).toBe(on ? 2 : 1);
    expect(decryptCustomerData(stored, legacyId)).toBe('[{"game_id":"666"}]');
  });
});
