/**
 * Stock-traceability backfill (Fase 2): legacy StockItem rows get their
 * fingerprints, credentialKeyVersion, soldTo* pointers and a synthetic
 * SYSTEM event history reconstructed from their own timestamps — idempotently,
 * without ever surfacing credential text, and ending in a state the Fase 4a
 * integrity checker accepts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { StockActorType, StockEventType, StockStatus, OrderStatus } from "@app/core/enums";
import {
  encryptCredentials,
  computeIdentityFingerprint,
  computeCredentialFingerprint,
} from "@app/core/credentialCrypto";
import { checkStockIntegrity, recordStockEvent } from "@app/db";
import { makeTestDb, type TestDb } from "../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../tests/helpers/sampleData";
import { runBackfill } from "./backfill-stock-traceability";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let consoleSpies: MockInstance[] = [];
let orderSeq = 0;

const T_ADDED = new Date("2025-01-01T00:00:00Z");
const T_RESERVED = new Date("2025-01-02T00:00:00Z");
const T_SOLD = new Date("2025-01-03T00:00:00Z");

// Every plaintext used below, so the leak assertion can check all of them.
const PLAINTEXTS: string[] = [];
function plain(label: string): string {
  const password = `Secret-${label}`;
  const value = `${label}@legacy.example:${password}`;
  // The password alone must never leak either, not only the full credential.
  PLAINTEXTS.push(value, password);
  return value;
}

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
  // The sample rows come from bulkAddStock (already traced); drop them so each
  // test's counts describe only the legacy rows it seeds itself.
  await prisma.stockItemEvent.deleteMany();
  await prisma.stockItem.deleteMany();
  consoleSpies = (["log", "warn", "error", "info"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});
afterEach(() => {
  const logged = JSON.stringify(consoleSpies.flatMap((s) => s.mock.calls));
  for (const p of PLAINTEXTS) expect(logged).not.toContain(p);
  vi.restoreAllMocks();
});

async function legacyRow(data: {
  credentials: string;
  status?: string;
  orderId?: number | null;
  reservedAt?: Date | null;
  soldAt?: Date | null;
  deletedAt?: Date | null;
}) {
  return prisma.stockItem.create({
    data: {
      productId: sample.product.id,
      credentials: data.credentials,
      status: data.status ?? StockStatus.AVAILABLE,
      orderId: data.orderId ?? null,
      addedAt: T_ADDED,
      reservedAt: data.reservedAt ?? null,
      soldAt: data.soldAt ?? null,
      deletedAt: data.deletedAt ?? null,
    },
  });
}

async function rawOrder(status: string = OrderStatus.DELIVERED) {
  orderSeq += 1;
  return prisma.order.create({
    data: {
      orderCode: `BF-${Date.now()}-${orderSeq}`,
      userId: sample.user.id,
      status,
      subtotalAmount: "5.0000",
      totalAmount: "5.0000",
    },
  });
}

async function rawOrderItem(orderId: number, stockItemId: number) {
  return prisma.orderItem.create({
    data: { orderId, productId: sample.product.id, stockItemId, quantity: 1, unitPrice: "5.0000", warrantyDaysSnapshot: 30 },
  });
}

async function eventsOf(stockItemId: number) {
  return prisma.stockItemEvent.findMany({ where: { stockItemId }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] });
}

async function soldLegacyRowWithOrder(label: string) {
  const order = await rawOrder();
  const row = await legacyRow({
    credentials: encryptCredentials(plain(label)),
    status: StockStatus.SOLD,
    orderId: order.id,
    reservedAt: T_RESERVED,
    soldAt: T_SOLD,
  });
  const item = await rawOrderItem(order.id, row.id);
  return { order, row, item };
}

describe("runBackfill — fingerprints, key version and events for a fresh row", () => {
  it("fingerprints an AVAILABLE row, stamps key version 1 and gives it one IMPORTED event", async () => {
    const p = plain("fresh");
    const row = await legacyRow({ credentials: encryptCredentials(p) });

    const summary = await runBackfill(prisma, { dryRun: false });

    const after = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.identityFingerprint).toBe(computeIdentityFingerprint(p));
    expect(after.credentialFingerprint).toBe(computeCredentialFingerprint(p));
    expect(after.credentialKeyVersion).toBe(1);
    expect(after.credentials).toBe(row.credentials);

    const events = await eventsOf(row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: StockEventType.IMPORTED,
      fromStatus: null,
      toStatus: StockStatus.AVAILABLE,
      actorType: StockActorType.SYSTEM,
      actorAdminId: null,
      actorCustomerId: null,
      meta: { backfilled: true },
      occurredAt: T_ADDED,
    });

    expect(summary).toMatchObject({
      dryRun: false,
      scanned: 1,
      batches: 1,
      fingerprints: { computed: 1, alreadyPresent: 0, decryptFailed: 0 },
      keyVersion: { backfilled: 1, legacyPlaintext: 0 },
      events: { rowsBackfilled: 1, eventsCreated: 1, rowsAlreadyTraced: 0 },
    });
  });
});

describe("runBackfill — soldToOrderId and the SOLD event chain", () => {
  it("backfills soldTo* from the matching OrderItem and writes IMPORTED → RESERVED → SOLD", async () => {
    const { order, row, item } = await soldLegacyRowWithOrder("sold");

    const summary = await runBackfill(prisma, { dryRun: false });

    const after = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.soldToOrderId).toBe(order.id);
    expect(after.soldToOrderItemId).toBe(item.id);
    expect(summary.soldTo).toEqual({ backfilled: 1, soldWithNoOrderId: 0, soldWithNoOrderItem: 0, soldOrderMismatch: 0 });

    const events = await eventsOf(row.id);
    expect(events.map((e) => [e.eventType, e.fromStatus, e.toStatus, e.occurredAt.toISOString()])).toEqual([
      [StockEventType.IMPORTED, null, StockStatus.AVAILABLE, T_ADDED.toISOString()],
      [StockEventType.RESERVED, StockStatus.AVAILABLE, StockStatus.RESERVED, T_RESERVED.toISOString()],
      [StockEventType.SOLD, StockStatus.RESERVED, StockStatus.SOLD, T_SOLD.toISOString()],
    ]);
    expect(events[1]).toMatchObject({ orderId: order.id, orderItemId: null });
    expect(events[2]).toMatchObject({ orderId: order.id, orderItemId: item.id });
  });

  it("counts a SOLD row with no orderId and leaves soldToOrderId null", async () => {
    const row = await legacyRow({
      credentials: encryptCredentials(plain("orphan")),
      status: StockStatus.SOLD,
      reservedAt: T_RESERVED,
      soldAt: T_SOLD,
    });

    const summary = await runBackfill(prisma, { dryRun: false });

    expect(summary.soldTo).toMatchObject({ backfilled: 0, soldWithNoOrderId: 1, soldWithNoOrderItem: 1 });
    const after = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.soldToOrderId).toBeNull();
    expect(after.soldToOrderItemId).toBeNull();
  });

  it("falls back to row.orderId when no OrderItem points at a SOLD row, and counts it", async () => {
    const order = await rawOrder();
    const row = await legacyRow({
      credentials: encryptCredentials(plain("noitem")),
      status: StockStatus.SOLD,
      orderId: order.id,
      reservedAt: T_RESERVED,
      soldAt: T_SOLD,
    });

    const summary = await runBackfill(prisma, { dryRun: false });

    expect(summary.soldTo).toMatchObject({ backfilled: 1, soldWithNoOrderId: 0, soldWithNoOrderItem: 1, soldOrderMismatch: 0 });
    const after = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.soldToOrderId).toBe(order.id);
    expect(after.soldToOrderItemId).toBeNull();
  });

  it("counts an order mismatch between row.orderId and the OrderItem's order, using the OrderItem's", async () => {
    const rowOrder = await rawOrder();
    const itemOrder = await rawOrder();
    const row = await legacyRow({
      credentials: encryptCredentials(plain("mismatch")),
      status: StockStatus.SOLD,
      orderId: rowOrder.id,
      reservedAt: T_RESERVED,
      soldAt: T_SOLD,
    });
    const item = await rawOrderItem(itemOrder.id, row.id);

    const summary = await runBackfill(prisma, { dryRun: false });

    expect(summary.soldTo).toMatchObject({ backfilled: 1, soldOrderMismatch: 1 });
    const after = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.soldToOrderId).toBe(itemOrder.id);
    expect(after.soldToOrderItemId).toBe(item.id);
  });
});

describe("runBackfill — idempotency", () => {
  it("leaves an existing identityFingerprint untouched", async () => {
    const row = await legacyRow({ credentials: encryptCredentials(plain("prefp")) });
    await prisma.stockItem.update({
      where: { id: row.id },
      data: { identityFingerprint: "preexisting-identity", credentialFingerprint: "preexisting-credential" },
    });

    const first = await runBackfill(prisma, { dryRun: false });
    await runBackfill(prisma, { dryRun: false });

    expect(first.fingerprints).toEqual({ computed: 0, alreadyPresent: 1, decryptFailed: 0 });
    const after = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.identityFingerprint).toBe("preexisting-identity");
    expect(after.credentialFingerprint).toBe("preexisting-credential");
  });

  it("gives no synthetic events to a row that already has a status-transition event", async () => {
    const row = await legacyRow({ credentials: encryptCredentials(plain("traced")) });
    await recordStockEvent(prisma, {
      stockItemId: row.id,
      eventType: StockEventType.IMPORTED,
      toStatus: StockStatus.AVAILABLE,
      actor: { type: StockActorType.SYSTEM },
    });

    const summary = await runBackfill(prisma, { dryRun: false });

    expect(await prisma.stockItemEvent.count({ where: { stockItemId: row.id } })).toBe(1);
    expect(summary.events).toMatchObject({ rowsBackfilled: 0, eventsCreated: 0, rowsAlreadyTraced: 1 });
  });

  it("still reconstructs history for a row whose only event is a non-transition one (e.g. REENCRYPTED)", async () => {
    const row = await legacyRow({ credentials: encryptCredentials(plain("reenc")) });
    await recordStockEvent(prisma, {
      stockItemId: row.id,
      eventType: StockEventType.REENCRYPTED,
      actor: { type: StockActorType.SYSTEM },
      reasonCode: "PLAINTEXT_BACKFILL",
    });

    const summary = await runBackfill(prisma, { dryRun: false });

    expect(summary.events).toMatchObject({ rowsBackfilled: 1, eventsCreated: 1 });
    const types = (await eventsOf(row.id)).map((e) => e.eventType).sort();
    expect(types).toEqual([StockEventType.IMPORTED, StockEventType.REENCRYPTED].sort());
  });

  it("re-reads each row inside its transaction, so a change made after the batch read is not overwritten", async () => {
    const row = await legacyRow({ credentials: encryptCredentials(plain("race")) });
    // Simulate the app fingerprinting the row between the batch read and the
    // per-row transaction. (A Proxy, not vi.spyOn: spying on a Prisma model
    // delegate breaks it for the rest of the file.)
    const bindAll = (t: object, p: string | symbol) => {
      const v = Reflect.get(t, p) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    };
    const stockItem = new Proxy(prisma.stockItem, {
      get(t, p) {
        if (p !== "findMany") return bindAll(t, p);
        return async (args: Parameters<typeof t.findMany>[0]) => {
          const batch = await t.findMany(args);
          await prisma.stockItem.update({
            where: { id: row.id },
            data: { identityFingerprint: "set-by-app", credentialFingerprint: "set-by-app" },
          });
          return batch;
        };
      },
    });
    const racingClient = new Proxy(prisma, { get: (t, p) => (p === "stockItem" ? stockItem : bindAll(t, p)) });

    const summary = await runBackfill(racingClient, { dryRun: false });

    const after = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.identityFingerprint).toBe("set-by-app");
    expect(after.credentialFingerprint).toBe("set-by-app");
    expect(summary.fingerprints).toMatchObject({ computed: 0, alreadyPresent: 1 });
  });

  it("a second full run changes nothing and reports zero new work", async () => {
    await legacyRow({ credentials: encryptCredentials(plain("idem1")) });
    await soldLegacyRowWithOrder("idem2");
    await legacyRow({ credentials: plain("idem3") });
    await legacyRow({ credentials: encryptCredentials(plain("idem4")), status: StockStatus.DEAD });

    await runBackfill(prisma, { dryRun: false });
    const rowsAfterFirst = await prisma.stockItem.findMany({ orderBy: { id: "asc" } });
    const eventsAfterFirst = await prisma.stockItemEvent.findMany({ orderBy: { id: "asc" } });

    const second = await runBackfill(prisma, { dryRun: false });

    expect(second.fingerprints).toEqual({ computed: 0, alreadyPresent: 4, decryptFailed: 0 });
    expect(second.keyVersion).toEqual({ backfilled: 0, legacyPlaintext: 0 });
    expect(second.soldTo.backfilled).toBe(0);
    expect(second.events).toMatchObject({ rowsBackfilled: 0, eventsCreated: 0, rowsAlreadyTraced: 4, statusReconciled: 0 });
    expect(await prisma.stockItem.findMany({ orderBy: { id: "asc" } })).toEqual(rowsAfterFirst);
    expect(await prisma.stockItemEvent.findMany({ orderBy: { id: "asc" } })).toEqual(eventsAfterFirst);
  });
});

describe("runBackfill — legacy, corrupt, dead and soft-deleted rows", () => {
  it("stamps key version 0 on a legacy plaintext row and still fingerprints it", async () => {
    const p = plain("plaintext");
    const row = await legacyRow({ credentials: p });

    const summary = await runBackfill(prisma, { dryRun: false });

    const after = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.credentialKeyVersion).toBe(0);
    expect(after.identityFingerprint).toBe(computeIdentityFingerprint(p));
    expect(after.credentialFingerprint).toBe(computeCredentialFingerprint(p));
    expect(summary.keyVersion).toEqual({ backfilled: 1, legacyPlaintext: 1 });
  });

  it("counts and skips a corrupt envelope without aborting the rest of the batch", async () => {
    const envelope = JSON.parse(encryptCredentials(plain("corrupt"))) as { authTag: string };
    envelope.authTag = Buffer.alloc(16).toString("base64");
    const bad = await legacyRow({ credentials: JSON.stringify(envelope) });
    const good = await legacyRow({ credentials: encryptCredentials(plain("goodneighbour")) });

    const summary = await runBackfill(prisma, { dryRun: false });

    expect(summary.fingerprints).toEqual({ computed: 1, alreadyPresent: 0, decryptFailed: 1 });
    const badAfter = await prisma.stockItem.findUniqueOrThrow({ where: { id: bad.id } });
    expect(badAfter.identityFingerprint).toBeNull();
    expect(badAfter.credentialFingerprint).toBeNull();
    // The envelope's own keyVersion and the row's history need no decryption.
    expect(badAfter.credentialKeyVersion).toBe(1);
    expect(await eventsOf(bad.id)).toHaveLength(1);
    const goodAfter = await prisma.stockItem.findUniqueOrThrow({ where: { id: good.id } });
    expect(goodAfter.identityFingerprint).not.toBeNull();
  });

  it("closes a DEAD row's reconstructed history with a MARKED_DEAD event", async () => {
    const row = await legacyRow({ credentials: encryptCredentials(plain("dead")), status: StockStatus.DEAD });

    const summary = await runBackfill(prisma, { dryRun: false });

    const events = await eventsOf(row.id);
    expect(events.map((e) => [e.eventType, e.fromStatus, e.toStatus])).toEqual([
      [StockEventType.IMPORTED, null, StockStatus.AVAILABLE],
      [StockEventType.MARKED_DEAD, StockStatus.AVAILABLE, StockStatus.DEAD],
    ]);
    expect(events[1]).toMatchObject({ actorType: StockActorType.SYSTEM, actorAdminId: null });
    expect(summary.events.statusReconciled).toBe(1);
  });

  it("backfills the buyer of a sold row later retired to DEAD, and closes its history SOLD → DEAD", async () => {
    const { order, row, item } = await soldLegacyRowWithOrder("retired");
    await prisma.stockItem.update({ where: { id: row.id }, data: { status: StockStatus.DEAD } });

    const summary = await runBackfill(prisma, { dryRun: false });

    const after = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.soldToOrderId).toBe(order.id);
    expect(after.soldToOrderItemId).toBe(item.id);
    expect(summary.soldTo.backfilled).toBe(1);
    const events = await eventsOf(row.id);
    expect(events.map((e) => [e.eventType, e.fromStatus, e.toStatus])).toEqual([
      [StockEventType.IMPORTED, null, StockStatus.AVAILABLE],
      [StockEventType.RESERVED, StockStatus.AVAILABLE, StockStatus.RESERVED],
      [StockEventType.SOLD, StockStatus.RESERVED, StockStatus.SOLD],
      [StockEventType.MARKED_DEAD, StockStatus.SOLD, StockStatus.DEAD],
    ]);
    expect(events[3]!.occurredAt).toEqual(T_SOLD);
    expect((await checkStockIntegrity(prisma)).statusEventMismatch.count).toBe(0);
  });

  it("closes an AVAILABLE row that still carries a stale reservedAt with RESERVATION_RELEASED", async () => {
    const row = await legacyRow({ credentials: encryptCredentials(plain("released")), reservedAt: T_RESERVED });

    const summary = await runBackfill(prisma, { dryRun: false });

    const events = await eventsOf(row.id);
    expect(events.map((e) => [e.eventType, e.fromStatus, e.toStatus])).toEqual([
      [StockEventType.IMPORTED, null, StockStatus.AVAILABLE],
      [StockEventType.RESERVED, StockStatus.AVAILABLE, StockStatus.RESERVED],
      [StockEventType.RESERVATION_RELEASED, StockStatus.RESERVED, StockStatus.AVAILABLE],
    ]);
    expect(events[2]).toMatchObject({
      actorType: StockActorType.SYSTEM,
      reasonCode: "BACKFILL_STATUS_RECONCILE",
      meta: { backfilled: true, occurredAtIsLowerBound: true },
      occurredAt: T_RESERVED,
    });
    expect(summary.events.statusReconciled).toBe(1);
    expect((await checkStockIntegrity(prisma)).statusEventMismatch.count).toBe(0);
  });

  it("fingerprints a soft-deleted row but invents no RESERVED/SOLD history for it", async () => {
    const row = await legacyRow({
      credentials: encryptCredentials(plain("softdel")),
      deletedAt: new Date("2025-02-01T00:00:00Z"),
    });

    await runBackfill(prisma, { dryRun: false });

    const after = await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.identityFingerprint).not.toBeNull();
    expect(after.deletedAt).toEqual(row.deletedAt);
    expect((await eventsOf(row.id)).map((e) => e.eventType)).toEqual([StockEventType.IMPORTED]);
  });

  it("does not invent a RESERVED event for a RESERVED row with no reservedAt, and counts it", async () => {
    const order = await rawOrder(OrderStatus.PENDING_PAYMENT);
    const row = await legacyRow({
      credentials: encryptCredentials(plain("noreservedat")),
      status: StockStatus.RESERVED,
      orderId: order.id,
    });

    const summary = await runBackfill(prisma, { dryRun: false });

    expect((await eventsOf(row.id)).map((e) => e.eventType)).toEqual([StockEventType.IMPORTED]);
    expect(summary.events.statusUnreconciled).toBe(1);
  });
});

describe("runBackfill — activeCredentialKey claims (Fase 5b)", () => {
  const keyOf = (p: string) => `${sample.product.id}:${computeCredentialFingerprint(p)}`;

  it("claims every live legacy row and leaves DEAD / soft-deleted rows unclaimed", async () => {
    const pa = plain("claim-a");
    const pb = plain("claim-b");
    const a = await legacyRow({ credentials: encryptCredentials(pa) });
    const b = await legacyRow({ credentials: pb, status: StockStatus.RESERVED, reservedAt: T_RESERVED });
    const dead = await legacyRow({ credentials: encryptCredentials(plain("claim-dead")), status: StockStatus.DEAD });
    const gone = await legacyRow({ credentials: encryptCredentials(plain("claim-gone")), deletedAt: new Date() });

    const summary = await runBackfill(prisma, { dryRun: false });

    const byId = async (id: number) => (await prisma.stockItem.findUniqueOrThrow({ where: { id } })).activeCredentialKey;
    expect(await byId(a.id)).toBe(keyOf(pa));
    expect(await byId(b.id)).toBe(keyOf(pb));
    expect(await byId(dead.id)).toBeNull();
    expect(await byId(gone.id)).toBeNull();
    expect(summary.claims).toEqual({ claimed: 2, alreadyClaimed: 0, duplicate: 0, released: 0, unfingerprinted: 0 });
  });

  it("counts a duplicate live legacy credential and leaves it unclaimed instead of crashing", async () => {
    const p = plain("claim-dup");
    const first = await legacyRow({ credentials: encryptCredentials(p) });
    const second = await legacyRow({ credentials: p.replace("@legacy.example", "@LEGACY.example") });

    const summary = await runBackfill(prisma, { dryRun: false });

    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: first.id } })).activeCredentialKey).toBe(keyOf(p));
    const dup = await prisma.stockItem.findUniqueOrThrow({ where: { id: second.id } });
    expect(dup.activeCredentialKey).toBeNull();
    // Everything else about the duplicate row is still backfilled.
    expect(dup.credentialFingerprint).toBe(computeCredentialFingerprint(p));
    expect(summary.claims).toMatchObject({ claimed: 1, duplicate: 1 });
  });

  it("a legacy row duplicating an already-claimed imported row is counted, not claimed", async () => {
    const p = plain("claim-vs-new");
    await prisma.stockItem.create({
      data: {
        productId: sample.product.id,
        credentials: encryptCredentials(p),
        credentialFingerprint: computeCredentialFingerprint(p),
        identityFingerprint: computeIdentityFingerprint(p),
        credentialKeyVersion: 1,
        activeCredentialKey: keyOf(p),
      },
    });
    const legacy = await legacyRow({ credentials: encryptCredentials(p) });

    const summary = await runBackfill(prisma, { dryRun: false });

    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: legacy.id } })).activeCredentialKey).toBeNull();
    expect(summary.claims).toMatchObject({ claimed: 0, alreadyClaimed: 1, duplicate: 1 });
  });

  it("releases a stale claim left on a DEAD row", async () => {
    const p = plain("claim-stale");
    const row = await legacyRow({ credentials: encryptCredentials(p), status: StockStatus.DEAD });
    await prisma.stockItem.update({ where: { id: row.id }, data: { activeCredentialKey: keyOf(p) } });

    const summary = await runBackfill(prisma, { dryRun: false });

    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } })).activeCredentialKey).toBeNull();
    expect(summary.claims.released).toBe(1);
  });

  it("a corrupt live row can't be fingerprinted, so it is counted and left unclaimed", async () => {
    const good = JSON.parse(encryptCredentials(plain("claim-corrupt"))) as Record<string, unknown>;
    await legacyRow({ credentials: JSON.stringify({ ...good, authTag: Buffer.alloc(16).toString("base64") }) });

    const summary = await runBackfill(prisma, { dryRun: false });
    expect(summary.claims).toMatchObject({ claimed: 0, unfingerprinted: 1 });
  });

  it("a second run claims nothing new; a dry run reports claims (and in-run duplicates) without writing", async () => {
    const p = plain("claim-dry");
    await legacyRow({ credentials: encryptCredentials(p) });
    await legacyRow({ credentials: p });

    const dry = await runBackfill(prisma, { dryRun: true });
    expect(dry.claims).toMatchObject({ claimed: 1, duplicate: 1 });
    expect(await prisma.stockItem.count({ where: { activeCredentialKey: { not: null } } })).toBe(0);

    await runBackfill(prisma, { dryRun: false });
    const second = await runBackfill(prisma, { dryRun: false });
    expect(second.claims).toEqual({ claimed: 0, alreadyClaimed: 1, duplicate: 1, released: 0, unfingerprinted: 0 });
  });
});

describe("runBackfill — dry run", () => {
  it("writes nothing but reports what it would have done", async () => {
    await soldLegacyRowWithOrder("dry");
    await legacyRow({ credentials: plain("dryplain") });
    const rowsBefore = await prisma.stockItem.findMany({ orderBy: { id: "asc" } });

    const summary = await runBackfill(prisma, { dryRun: true });

    expect(await prisma.stockItem.findMany({ orderBy: { id: "asc" } })).toEqual(rowsBefore);
    expect(await prisma.stockItemEvent.count()).toBe(0);
    expect(summary).toMatchObject({
      dryRun: true,
      scanned: 2,
      fingerprints: { computed: 2, alreadyPresent: 0, decryptFailed: 0 },
      soldTo: { backfilled: 1 },
      events: { rowsBackfilled: 2, eventsCreated: 4 },
      keyVersion: { backfilled: 2, legacyPlaintext: 1 },
    });
  });
});

describe("runBackfill — integrity checker agreement and secrecy", () => {
  it("leaves no legacy rows without events and no status/event mismatches for consistent legacy rows", async () => {
    await legacyRow({ credentials: encryptCredentials(plain("int-avail")) });
    const reservedOrder = await rawOrder(OrderStatus.PENDING_PAYMENT);
    await legacyRow({
      credentials: encryptCredentials(plain("int-res")),
      status: StockStatus.RESERVED,
      orderId: reservedOrder.id,
      reservedAt: T_RESERVED,
    });
    await soldLegacyRowWithOrder("int-sold");
    await legacyRow({ credentials: encryptCredentials(plain("int-dead")), status: StockStatus.DEAD });
    await legacyRow({ credentials: plain("int-softdel"), deletedAt: new Date("2025-02-01T00:00:00Z") });

    const before = await checkStockIntegrity(prisma);
    expect(before.legacyRowsWithoutEvents).toBe(5);

    await runBackfill(prisma, { dryRun: false });

    const after = await checkStockIntegrity(prisma);
    expect(after.legacyRowsWithoutEvents).toBe(0);
    expect(after.statusEventMismatch).toEqual({ count: 0, sampleIds: [] });
  });

  it("never returns credential text in its summary", async () => {
    await soldLegacyRowWithOrder("secret-a");
    await legacyRow({ credentials: plain("secret-b") });

    const summary = await runBackfill(prisma, { dryRun: false });

    const serialized = JSON.stringify(summary);
    for (const p of PLAINTEXTS) expect(serialized).not.toContain(p);
  });
});
