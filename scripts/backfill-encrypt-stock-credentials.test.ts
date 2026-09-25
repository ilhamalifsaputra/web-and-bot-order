/**
 * The plaintext-credential backfill must encrypt every legacy row, leave rows
 * that are already encrypted alone, and record a REENCRYPTED event (actor
 * SYSTEM) for exactly the rows it rewrote — in the same transaction as the
 * rewrite, so a row is never changed without its trace or traced without its
 * change.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { StockActorType, StockEventType } from "@app/core/enums";
import { credentialEnvelopeVersion, decryptStockCredentials, isEncryptedCredentialEnvelope } from "@app/core/credentialCrypto";
import { useEnvelopeWriteV2 } from "../tests/helpers/envelopeFlag";
import { makeTestDb, type TestDb } from "../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../tests/helpers/sampleData";
import { backfillEncryptStockCredentials } from "./backfill-encrypt-stock-credentials";

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
  sample = await buildSampleData(prisma); // 5 rows, already encrypted
});

async function addLegacyPlaintextRows(plaintexts: string[]) {
  const ids: number[] = [];
  for (const credentials of plaintexts) {
    const row = await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials, status: "AVAILABLE" },
    });
    ids.push(row.id);
  }
  return ids;
}

describe("backfillEncryptStockCredentials", () => {
  it("encrypts each plaintext row and writes one REENCRYPTED event per rewritten row", async () => {
    const ids = await addLegacyPlaintextRows(["legacy1@x:pw", "legacy2@x:pw"]);
    const eventsBefore = await prisma.stockItemEvent.count();

    const report = await backfillEncryptStockCredentials(prisma);

    expect(report).toEqual({ scanned: 7, encrypted: 2, alreadyEncrypted: 5 });
    for (const [i, id] of ids.entries()) {
      const row = await prisma.stockItem.findUniqueOrThrow({ where: { id } });
      expect(isEncryptedCredentialEnvelope(row.credentials)).toBe(true);
      expect(decryptStockCredentials(row.credentials, id)).toBe(`legacy${i + 1}@x:pw`);
      const events = await prisma.stockItemEvent.findMany({ where: { stockItemId: id } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: StockEventType.REENCRYPTED,
        actorType: StockActorType.SYSTEM,
        actorAdminId: null,
        actorCustomerId: null,
        fromStatus: null,
        toStatus: null,
      });
      expect(JSON.stringify(events)).not.toContain(`legacy${i + 1}@x:pw`);
    }
    expect(await prisma.stockItemEvent.count()).toBe(eventsBefore + 2);
  });

  it("writes no event for rows that were already encrypted, and is idempotent on a re-run", async () => {
    await addLegacyPlaintextRows(["legacy@x:pw"]);
    await backfillEncryptStockCredentials(prisma);
    const eventsAfterFirstRun = await prisma.stockItemEvent.count();

    const second = await backfillEncryptStockCredentials(prisma);

    expect(second).toEqual({ scanned: 6, encrypted: 0, alreadyEncrypted: 6 });
    expect(await prisma.stockItemEvent.count()).toBe(eventsAfterFirstRun);
  });

  it("also encrypts a soft-deleted plaintext row — the column still holds the secret", async () => {
    const [id] = await addLegacyPlaintextRows(["deleted-legacy@x:pw"]);
    await prisma.stockItem.update({
      where: { id: id! },
      data: { deletedAt: new Date(), deletedByAdminId: sample.user.id },
    });

    const report = await backfillEncryptStockCredentials(prisma);

    expect(report.encrypted).toBe(1);
    const row = await prisma.stockItem.findUniqueOrThrow({ where: { id: id! } });
    expect(isEncryptedCredentialEnvelope(row.credentials)).toBe(true);
    expect(await prisma.stockItemEvent.count({ where: { stockItemId: id!, eventType: StockEventType.REENCRYPTED } })).toBe(1);
  });
});

describe.each([false, true])("backfillEncryptStockCredentials with CREDENTIAL_ENVELOPE_WRITE_V2 %s (Fase 6d)", (on) => {
  useEnvelopeWriteV2(on);

  it("writes the flag's envelope version bound to each row's own id", async () => {
    const [id] = await addLegacyPlaintextRows(["legacy-6d@x:pw"]);
    await backfillEncryptStockCredentials(prisma);
    const row = await prisma.stockItem.findUniqueOrThrow({ where: { id: id! } });
    expect(credentialEnvelopeVersion(row.credentials)).toBe(on ? 2 : 1);
    expect(decryptStockCredentials(row.credentials, id!)).toBe("legacy-6d@x:pw");
  });
});
