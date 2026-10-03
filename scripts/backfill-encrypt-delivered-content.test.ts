/**
 * The delivered-content backfill must encrypt every legacy plaintext row,
 * leave encrypted rows alone (idempotent), count but never rewrite a corrupt
 * envelope, write nothing on a dry run, and never print content.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  decryptDeliveredContent,
  credentialEnvelopeVersion,
  encryptDeliveredContent,
  isEncryptedCredentialEnvelope,
} from "@app/core/credentialCrypto";
import { makeTestDb, type TestDb } from "../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../tests/helpers/sampleData";
import { createOrderDirect } from "../packages/db/src/crud/orders";
import { backfillEncryptDeliveredContent } from "./backfill-encrypt-delivered-content";
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
  await prisma.order.update({ where: { id: order.id }, data: { deliveredContent: stored } });
  return order.id;
}

function corruptEnvelope(): string {
  const good = JSON.parse(encryptLegacyV1("user:c pass:Corrupt9")) as Record<string, unknown>;
  return JSON.stringify({ ...good, authTag: Buffer.alloc(16).toString("base64") });
}

async function rawContent(id: number) {
  return (await prisma.order.findUniqueOrThrow({ where: { id } })).deliveredContent;
}

describe("backfillEncryptDeliveredContent", () => {
  it("encrypts plaintext rows, skips encrypted and null rows, and counts a corrupt envelope without touching it", async () => {
    const legacyA = await orderWithStored("SN-LEGACY-A");
    const legacyB = await orderWithStored("user: acc1\npass: Hunter2");
    const already = encryptLegacyV1("SN-NEW");
    const alreadyId = await orderWithStored(already);
    const corrupt = corruptEnvelope();
    const corruptId = await orderWithStored(corrupt);
    const nullId = await orderWithStored(null);

    const report = await backfillEncryptDeliveredContent(prisma);

    expect(report).toEqual({ scanned: 4, plaintext: 2, encrypted: 2, alreadyEncrypted: 1, corrupt: 1, changedDuringRun: 0 });
    for (const [id, plain] of [[legacyA, "SN-LEGACY-A"], [legacyB, "user: acc1\npass: Hunter2"]] as const) {
      const stored = await rawContent(id);
      expect(isEncryptedCredentialEnvelope(stored!)).toBe(true);
      expect(decryptDeliveredContent(stored, id)).toBe(plain);
    }
    expect(await rawContent(alreadyId)).toBe(already);
    expect(await rawContent(corruptId)).toBe(corrupt);
    expect(await rawContent(nullId)).toBeNull();
  });

  it("is idempotent: a second run rewrites nothing", async () => {
    const id = await orderWithStored("SN-ONCE");
    await backfillEncryptDeliveredContent(prisma);
    const afterFirst = await rawContent(id);

    const second = await backfillEncryptDeliveredContent(prisma);

    expect(second).toEqual({ scanned: 1, plaintext: 0, encrypted: 0, alreadyEncrypted: 1, corrupt: 0, changedDuringRun: 0 });
    expect(await rawContent(id)).toBe(afterFirst);
  });

  it("dry run counts plaintext rows but writes nothing", async () => {
    const id = await orderWithStored("SN-DRY");

    const report = await backfillEncryptDeliveredContent(prisma, { dryRun: true });

    expect(report).toMatchObject({ scanned: 1, plaintext: 1, encrypted: 0 });
    expect(await rawContent(id)).toBe("SN-DRY");
  });

  it("never prints delivered content", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await orderWithStored("SN-SECRET-PRINT");
      await backfillEncryptDeliveredContent(prisma);
      expect(JSON.stringify([log.mock.calls, error.mock.calls])).not.toContain("SN-SECRET-PRINT");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe.each([false, true])("backfillEncryptDeliveredContent with CREDENTIAL_ENVELOPE_WRITE_V2 %s (Fase 6d)", (on) => {
  useEnvelopeWriteV2(on);

  it("writes the flag's envelope version bound to the order, and counts an envelope bound to its own order as encrypted", async () => {
    const legacyId = await orderWithStored("SN-6D-LEGACY");
    const boundId = await orderWithStored(null);
    await prisma.order.update({ where: { id: boundId }, data: { deliveredContent: encryptDeliveredContent("SN-6D-BOUND", boundId) } });

    const report = await backfillEncryptDeliveredContent(prisma);

    expect(report).toMatchObject({ plaintext: 1, encrypted: 1, alreadyEncrypted: 1, corrupt: 0 });
    const stored = (await rawContent(legacyId))!;
    expect(credentialEnvelopeVersion(stored)).toBe(on ? 2 : 1);
    expect(decryptDeliveredContent(stored, legacyId)).toBe("SN-6D-LEGACY");
  });
});
