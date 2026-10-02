/**
 * The v1 -> v2 re-encrypt (Fase 6d) must rewrite every v1 envelope in the
 * three encrypted columns as a v2 envelope bound to its own row, leave
 * plaintext/corrupt/already-v2 values alone, trace each stock rewrite with a
 * REENCRYPTED event (actor SYSTEM), never overwrite a concurrent write, be
 * idempotent, write nothing on a dry run, and refuse a real run while the v2
 * write flag is off.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { StockActorType, StockEventType, StockStatus } from "@app/core/enums";
import {
  credentialEnvelopeVersion,
  decryptDeliveredContent,
  decryptStockCredentials,
  encryptDeliveredContent,
  encryptStockCredentials,
} from "@app/core/credentialCrypto";
import { makeTestDb, type TestDb } from "../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../tests/helpers/sampleData";
import { encryptLegacyV1, useEnvelopeWriteV2 } from "../tests/helpers/envelopeFlag";
import { createOrderDirect } from "../packages/db/src/crud/orders";
import { getDecryptedSetting, setSetting, __clearSettingsCacheForTests } from "../packages/db/src/crud/settings";
import { reencryptCredentialsV2, ReencryptRefusedError } from "./reencrypt-credentials-v2";

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
  __clearSettingsCacheForTests(prisma);
  sample = await buildSampleData(prisma); // 5 stock rows, v1 (the flag is unset while it runs)
});

function corrupt(stored: string): string {
  return JSON.stringify({ ...(JSON.parse(stored) as object), authTag: Buffer.alloc(16).toString("base64") });
}

async function stockRow(credentials: string) {
  return prisma.stockItem.create({ data: { productId: sample.product.id, credentials, status: StockStatus.AVAILABLE } });
}

async function orderWith(deliveredContent: string | null) {
  const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1, channel: "bot" }))!;
  await prisma.order.update({ where: { id: order.id }, data: { deliveredContent } });
  return order.id;
}

describe("reencryptCredentialsV2 with the write flag off", () => {
  useEnvelopeWriteV2(false);

  it("refuses a real run and writes nothing", async () => {
    const before = await prisma.stockItem.findMany({ orderBy: { id: "asc" } });
    await expect(reencryptCredentialsV2(prisma)).rejects.toThrow(ReencryptRefusedError);
    expect(await prisma.stockItem.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });

  it("allows a dry run, which only counts", async () => {
    const before = await prisma.stockItem.findMany({ orderBy: { id: "asc" } });
    const report = await reencryptCredentialsV2(prisma, { dryRun: true });
    expect(report.stock).toMatchObject({ scanned: 5, v1: 5, reencrypted: 0, alreadyV2: 0 });
    expect(await prisma.stockItem.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });
});

describe("reencryptCredentialsV2 with the write flag on", () => {
  useEnvelopeWriteV2(true);

  it("rewrites every v1 value as v2 bound to its own row, and leaves the rest alone", async () => {
    const plain = await stockRow("legacy-plain@x.com:pw");
    const broken = await stockRow(corrupt(encryptLegacyV1("broken@x.com:pw")));
    const v2Stock = await stockRow(encryptLegacyV1("placeholder"));
    await prisma.stockItem.update({
      where: { id: v2Stock.id },
      data: { credentials: encryptStockCredentials("already-v2@x.com:pw", v2Stock.id) },
    });
    const v1Rows = await prisma.stockItem.findMany({
      where: { id: { notIn: [plain.id, broken.id, v2Stock.id] } },
      orderBy: { id: "asc" },
    });
    const v1Plain = new Map(v1Rows.map((r) => [r.id, decryptStockCredentials(r.credentials, r.id)]));

    const v1Order = await orderWith(encryptLegacyV1("SN-V1"));
    const plainOrder = await orderWith("SN-PLAINTEXT");
    const nullOrder = await orderWith(null);

    await setSetting(prisma, "smtp_pass", encryptLegacyV1("smtp-v1-secret"));
    await setSetting(prisma, "tokopay_secret", "tokopay-plaintext");
    await setSetting(prisma, "not_a_secret_key", encryptLegacyV1("ignored"));

    const report = await reencryptCredentialsV2(prisma);

    expect(report.dryRun).toBe(false);
    expect(report.stock).toEqual({
      scanned: 8,
      v1: 5,
      reencrypted: 5,
      alreadyV2: 1,
      notEncrypted: 1,
      unreadable: 1,
      changedDuringRun: 0,
    });
    expect(report.deliveredContent).toMatchObject({ scanned: 2, v1: 1, reencrypted: 1, notEncrypted: 1, unreadable: 0 });
    expect(report.settings).toMatchObject({ scanned: 2, v1: 1, reencrypted: 1, notEncrypted: 1, unreadable: 0 });

    for (const [id, expected] of v1Plain) {
      const row = await prisma.stockItem.findUniqueOrThrow({ where: { id } });
      const before = v1Rows.find((r) => r.id === id)!;
      expect(credentialEnvelopeVersion(row.credentials)).toBe(2);
      expect(decryptStockCredentials(row.credentials, id)).toBe(expected);
      expect(row.credentialKeyVersion).toBe(1);
      // Fingerprints and the claim key are plaintext-derived and must not move.
      expect(row.credentialFingerprint).toBe(before.credentialFingerprint);
      expect(row.identityFingerprint).toBe(before.identityFingerprint);
      expect(row.activeCredentialKey).toBe(before.activeCredentialKey);
      const events = await prisma.stockItemEvent.findMany({ where: { stockItemId: id, eventType: StockEventType.REENCRYPTED } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorType: StockActorType.SYSTEM, fromStatus: null, toStatus: null });
      expect(JSON.stringify(events)).not.toContain(expected);
    }
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: plain.id } })).credentials).toBe("legacy-plain@x.com:pw");
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: broken.id } })).credentials).toBe(broken.credentials);
    for (const id of [plain.id, broken.id, v2Stock.id]) {
      expect(await prisma.stockItemEvent.count({ where: { stockItemId: id, eventType: StockEventType.REENCRYPTED } })).toBe(0);
    }

    const orderRaw = (await prisma.order.findUniqueOrThrow({ where: { id: v1Order } })).deliveredContent!;
    expect(credentialEnvelopeVersion(orderRaw)).toBe(2);
    expect(decryptDeliveredContent(orderRaw, v1Order)).toBe("SN-V1");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: plainOrder } })).deliveredContent).toBe("SN-PLAINTEXT");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: nullOrder } })).deliveredContent).toBeNull();

    __clearSettingsCacheForTests(prisma);
    const smtpRaw = (await prisma.setting.findUniqueOrThrow({ where: { key: "smtp_pass" } })).value;
    expect(credentialEnvelopeVersion(smtpRaw)).toBe(2);
    expect(await getDecryptedSetting(prisma, "smtp_pass")).toBe("smtp-v1-secret");
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: "tokopay_secret" } })).value).toBe("tokopay-plaintext");
    expect(credentialEnvelopeVersion((await prisma.setting.findUniqueOrThrow({ where: { key: "not_a_secret_key" } })).value)).toBe(1);
  });

  it("is idempotent: a second run rewrites nothing and records no new event", async () => {
    await orderWith(encryptLegacyV1("SN-IDEM"));
    await reencryptCredentialsV2(prisma);
    const events = await prisma.stockItemEvent.count();
    const stockAfterFirst = await prisma.stockItem.findMany({ orderBy: { id: "asc" } });

    const second = await reencryptCredentialsV2(prisma);

    expect(second.stock).toMatchObject({ scanned: 5, v1: 0, reencrypted: 0, alreadyV2: 5 });
    expect(second.deliveredContent).toMatchObject({ v1: 0, reencrypted: 0, alreadyV2: 1 });
    expect(await prisma.stockItemEvent.count()).toBe(events);
    expect(await prisma.stockItem.findMany({ orderBy: { id: "asc" } })).toEqual(stockAfterFirst);
  });

  it("counts a v2 value that does not read under its own row's context as unreadable, and leaves it", async () => {
    const [a, b] = await prisma.stockItem.findMany({ orderBy: { id: "asc" }, take: 2 });
    const misplaced = encryptStockCredentials("misplaced@x.com:pw", a!.id);
    await prisma.stockItem.update({ where: { id: b!.id }, data: { credentials: misplaced } });

    const report = await reencryptCredentialsV2(prisma);

    expect(report.stock).toMatchObject({ unreadable: 1, alreadyV2: 0, reencrypted: 4 });
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: b!.id } })).credentials).toBe(misplaced);
  });

  it("dry run counts what it would rewrite and writes nothing", async () => {
    await orderWith(encryptLegacyV1("SN-DRY"));
    const before = await prisma.stockItem.findMany({ orderBy: { id: "asc" } });
    const report = await reencryptCredentialsV2(prisma, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.stock).toMatchObject({ v1: 5, reencrypted: 0 });
    expect(report.deliveredContent).toMatchObject({ v1: 1, reencrypted: 0 });
    expect(await prisma.stockItem.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.stockItemEvent.count({ where: { eventType: StockEventType.REENCRYPTED } })).toBe(0);
  });

  it("never overwrites a value that changed between the read and the rewrite (compare-and-set)", async () => {
    const orderId = await orderWith(encryptLegacyV1("SN-OLD"));
    const concurrent = encryptDeliveredContent("SN-CONCURRENT", orderId);
    // A client whose order.updateMany first lets another writer change the row.
    const racing = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== "order") return Reflect.get(target, prop, receiver);
        return new Proxy(target.order, {
          get(orderDelegate, method, r) {
            if (method !== "updateMany") return Reflect.get(orderDelegate, method, r);
            return async (args: Parameters<typeof target.order.updateMany>[0]) => {
              await target.order.update({ where: { id: orderId }, data: { deliveredContent: concurrent } });
              return target.order.updateMany(args);
            };
          },
        });
      },
    });

    const report = await reencryptCredentialsV2(racing);

    expect(report.deliveredContent).toMatchObject({ v1: 1, reencrypted: 0, changedDuringRun: 1 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).deliveredContent).toBe(concurrent);
  });
});
