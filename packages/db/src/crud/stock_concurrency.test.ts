/**
 * True-concurrency regression tests for the atomic stock-reservation guard
 * — Postgres migration verification (Task 4).
 *
 * `allocateOneAvailableStock` (./stock.ts) grabs one AVAILABLE row via a
 * conditional `updateMany` (`WHERE id = candidate AND status = AVAILABLE`),
 * retrying up to 5 times if it loses a race. Every existing test that
 * exercises this — including order_creation.test.ts's "out-of-stock request
 * throws and leaks no RESERVED rows" — calls it sequentially, one `await` at
 * a time. SQLite's single-writer serialization made that indistinguishable
 * from "the guard holds under concurrency" — there was never more than one
 * writer to race in the first place. These tests fire multiple
 * `createOrderDirect` calls at the SAME instant via `Promise.allSettled`
 * against the real dev Postgres, which has actual concurrent writers, and
 * assert on the state after they all settle.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  cancelOrder,
  markStockDead,
  countAvailableStock,
  upsertUser,
  bulkAddStock,
  createDenomination,
} from "@app/db";
import {
  decryptCredentials,
  encryptCredentials,
  computeCredentialFingerprint,
  computeIdentityFingerprint,
} from "@app/core/credentialCrypto";
import { StockActorType, StockEventType } from "@app/core/enums";

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

/** `n` distinct buyers, one per concurrent request — a shared buyer would
 *  confound "5 concurrent requests" with "cart/wallet state reused". */
async function makeBuyers(n: number) {
  const buyers = [];
  for (let i = 0; i < n; i++) {
    buyers.push(
      await upsertUser(prisma, { telegramId: 900000 + i, username: `concurrency-buyer-${i}`, fullName: `Buyer ${i}` }),
    );
  }
  return buyers;
}

/** Kill all but `keep` of the product's seeded stock (oldest-first), leaving
 *  exactly `keep` AVAILABLE rows — same pattern as order_creation.test.ts's
 *  "out-of-stock request throws and leaks no RESERVED rows" test. */
async function reduceStockTo(productId: number, keep: number) {
  const items = await prisma.stockItem.findMany({ where: { productId }, orderBy: { id: "asc" } });
  for (const item of items.slice(keep)) {
    await markStockDead(prisma, item.id, "test: reduced for concurrency scenario", sample.user.id);
  }
}

/** No StockItem row was reserved by more than one order — the real detector
 *  for double-reservation, since `orderItem.stockItemId` (not
 *  `stockItem.orderId`, which only ever holds one value) is where a second
 *  writer overwriting the first's claim would leave a trace: two OrderItems
 *  pointing at the same stock row. */
async function assertNoDoubleReservation() {
  const dupes = await prisma.orderItem.groupBy({
    by: ["stockItemId"],
    where: { stockItemId: { not: null } },
    _count: { stockItemId: true },
    having: { stockItemId: { _count: { gt: 1 } } },
  });
  expect(dupes).toEqual([]);
}

/** The ledger's own version of the same claim (Fase 3b): no stock row was
 *  reserved twice with no release in between. Two RESERVED events on one row
 *  are legitimate ONLY across a cancel — hence "one more RESERVED than
 *  RESERVATION_RELEASED", never more. */
async function assertNoDoubleReservationEvents() {
  const events = await prisma.stockItemEvent.findMany({
    where: { eventType: { in: [StockEventType.RESERVED, StockEventType.RESERVATION_RELEASED] } },
    orderBy: { id: "asc" },
  });
  const held = new Map<number, number>();
  const overReserved: number[] = [];
  for (const event of events) {
    const depth = (held.get(event.stockItemId) ?? 0) + (event.eventType === StockEventType.RESERVED ? 1 : -1);
    held.set(event.stockItemId, depth);
    if (depth > 1) overReserved.push(event.stockItemId);
  }
  expect(overReserved).toEqual([]);
}

describe("createOrderDirect under true Postgres concurrency", () => {
  it("Case A — 1 available stock item, 5 concurrent buyers (qty=1 each): exactly 1 succeeds, 4 fail cleanly, no double-reservation", async () => {
    const { product } = sample;
    await reduceStockTo(product.id, 1);
    expect(await countAvailableStock(prisma, product.id)).toBe(1);
    const deadBefore = await prisma.stockItem.findMany({ where: { productId: product.id, status: "DEAD" } });
    expect(deadBefore.length).toBe(4);

    const buyers = await makeBuyers(5);
    const results = await Promise.allSettled(
      buyers.map((user) => createOrderDirect(prisma, { user, productId: product.id, quantity: 1 })),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createOrderDirect>>> => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    // Don't assume which buyer wins — just count outcomes from the settled results.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(4);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ key: "error.out_of_stock" });
    }

    const winningOrder = fulfilled[0]!.value!;
    const reserved = await prisma.stockItem.findMany({ where: { productId: product.id, status: "RESERVED" } });
    expect(reserved.length).toBe(1);
    expect(reserved[0]!.orderId).toBe(winningOrder.id);

    // The 4 already-dead items are untouched by the race.
    const deadAfter = await prisma.stockItem.findMany({ where: { productId: product.id, status: "DEAD" } });
    expect(deadAfter.map((s) => s.id).sort()).toEqual(deadBefore.map((s) => s.id).sort());

    await assertNoDoubleReservation();
    await assertNoDoubleReservationEvents();
  });

  it("Case B — 1 available stock item, exactly 1 buyer (sanity control): succeeds cleanly", async () => {
    const { product, user } = sample;
    await reduceStockTo(product.id, 1);

    const order = await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 });
    expect(order).not.toBeNull();

    const reserved = await prisma.stockItem.findMany({ where: { productId: product.id, status: "RESERVED" } });
    expect(reserved.length).toBe(1);
    expect(reserved[0]!.orderId).toBe(order!.id);
  });

  it("Case C — 5 available stock items, 5 concurrent buyers (qty=1 each): all succeed, against 5 distinct stock items", async () => {
    const { product } = sample; // buildSampleData already seeds 5 AVAILABLE rows
    expect(await countAvailableStock(prisma, product.id)).toBe(5);

    const buyers = await makeBuyers(5);
    const results = await Promise.allSettled(
      buyers.map((user) => createOrderDirect(prisma, { user, productId: product.id, quantity: 1 })),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createOrderDirect>>> => r.status === "fulfilled",
    );
    // Surface WHY on failure — a plain length assertion loses the rejection reason.
    if (fulfilled.length !== 5) {
      const reasons = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
      throw new Error(`Expected all 5 concurrent buyers to succeed; got ${fulfilled.length}/5. Rejections: ${JSON.stringify(reasons)}`);
    }
    expect(fulfilled.length).toBe(5);

    const reserved = await prisma.stockItem.findMany({ where: { productId: product.id, status: "RESERVED" } });
    expect(reserved.length).toBe(5);
    expect(new Set(reserved.map((s) => s.id)).size).toBe(5); // 5 distinct stock rows
    expect(new Set(reserved.map((s) => s.orderId)).size).toBe(5); // 5 distinct orders

    expect(await countAvailableStock(prisma, product.id)).toBe(0);
    await assertNoDoubleReservation();
    await assertNoDoubleReservationEvents();
  });

  it("Case D — 1 available stock item, 5 concurrent buyers each requesting quantity=2 (individually over-stock): all fail cleanly, nothing reserved", async () => {
    const { product } = sample;
    await reduceStockTo(product.id, 1);

    const buyers = await makeBuyers(5);
    const results = await Promise.allSettled(
      buyers.map((user) => createOrderDirect(prisma, { user, productId: product.id, quantity: 2 })),
    );

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results as PromiseRejectedResult[]) {
      expect(r.reason).toMatchObject({ key: "error.out_of_stock" });
    }

    const reservedCount = await prisma.stockItem.count({ where: { productId: product.id, status: "RESERVED" } });
    expect(reservedCount).toBe(0);
  });

  // Fase 3b / audit L-6. This is the scenario the duplicate-pointer detector
  // above could not previously survive: the cancelled order kept pointing at
  // the row it had released, so the very next checkout to take that row left
  // TWO OrderItems on it. `releaseOrderHolds` now clears the pointer, and the
  // event ledger carries the history instead.
  it("Case E — one row, reserved → cancelled → re-reserved by a second buyer: one pointer, full ledger", async () => {
    const { product, user } = sample;
    await reduceStockTo(product.id, 1);
    const row = (await prisma.stockItem.findFirstOrThrow({
      where: { productId: product.id, status: "AVAILABLE" },
    }));

    const first = await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 });
    await cancelOrder(prisma, first!.id, "user_cancelled", {
      type: StockActorType.CUSTOMER,
      customerId: user.id,
    });
    expect(await countAvailableStock(prisma, product.id)).toBe(1);

    const [second] = await makeBuyers(1);
    const reReserved = await createOrderDirect(prisma, { user: second!, productId: product.id, quantity: 1 });
    expect(reReserved).not.toBeNull();

    // The same row, now held by exactly one order line.
    const pointers = await prisma.orderItem.findMany({ where: { stockItemId: row.id } });
    expect(pointers).toHaveLength(1);
    expect(pointers[0]!.orderId).toBe(reReserved!.id);

    await assertNoDoubleReservation();
    await assertNoDoubleReservationEvents();

    const trail = await prisma.stockItemEvent.findMany({
      where: { stockItemId: row.id },
      orderBy: { id: "asc" },
    });
    expect(trail.map((e) => e.eventType)).toEqual([
      StockEventType.IMPORTED, // the fixture's own import of the row
      StockEventType.RESERVED,
      StockEventType.RESERVATION_RELEASED,
      StockEventType.RESERVED,
    ]);
    expect(trail.map((e) => e.orderId)).toEqual([null, first!.id, first!.id, reReserved!.id]);
  });
});

describe("bulkAddStock under true Postgres concurrency", () => {
  // Postgres runs writers in parallel, so nothing but bulkAddStock's own
  // per-denomination advisory lock keeps two uploads of the same credential
  // from both passing the dedup read and both inserting. A single racing pair
  // can get lucky, so this repeats it: each round uses fresh credentials and
  // an already-populated denomination (so the dedup read has real work to do,
  // which is what widens the window between "read" and "insert").
  const ROUNDS = 20;
  const PER_BATCH = 5;

  async function seedPopulatedDenomination(name: string) {
    const denom = await createDenomination(prisma, {
      productId: sample.parentProduct.id,
      name,
      type: "SHARED",
      durationLabel: "1 month",
      price: "5.00",
    });
    await bulkAddStock(
      prisma,
      denom.id,
      Array.from({ length: 40 }, (_, i) => `${name}-seed-${i}@x:pw`),
    );
    return denom;
  }

  async function rowsHolding(productId: number, credential: string) {
    const rows = await prisma.stockItem.findMany({ where: { productId, deletedAt: null } });
    return rows.filter((r) => decryptCredentials(r.credentials) === credential);
  }

  it("two concurrent bare-client calls with the same credentials always add each exactly once", async () => {
    const denom = await seedPopulatedDenomination("race-bare");
    for (let round = 0; round < ROUNDS; round++) {
      const creds = Array.from({ length: PER_BATCH }, (_, i) => `bare-${round}-${i}@x:pw`);

      const [a, b] = await Promise.all([
        bulkAddStock(prisma, denom.id, creds, sample.user.id),
        bulkAddStock(prisma, denom.id, creds, sample.user.id),
      ]);

      expect(a.added + b.added, `round ${round}: total added`).toBe(PER_BATCH);
      expect(a.skipped + b.skipped, `round ${round}: total skipped`).toBe(PER_BATCH);
      for (const c of creds) expect(await rowsHolding(denom.id, c), `round ${round}: ${c}`).toHaveLength(1);
    }
    // One IMPORTED event per row that exists — the loser of each race wrote none.
    const rowCount = await prisma.stockItem.count({ where: { productId: denom.id } });
    expect(rowCount).toBe(40 + ROUNDS * PER_BATCH);
    expect(
      await prisma.stockItemEvent.count({
        where: { eventType: StockEventType.IMPORTED, stockItem: { productId: denom.id } },
      }),
    ).toBe(rowCount);
  });

  it("two concurrent calls inside their own transactions (the route's shape) add each exactly once", async () => {
    const denom = await seedPopulatedDenomination("race-tx");
    for (let round = 0; round < ROUNDS; round++) {
      const creds = Array.from({ length: PER_BATCH }, (_, i) => `tx-${round}-${i}@x:pw`);

      const [a, b] = await Promise.all([
        prisma.$transaction((tx) => bulkAddStock(tx, denom.id, creds, sample.user.id)),
        prisma.$transaction((tx) => bulkAddStock(tx, denom.id, creds, sample.user.id)),
      ]);

      expect(a.added + b.added, `round ${round}: total added`).toBe(PER_BATCH);
      for (const c of creds) expect(await rowsHolding(denom.id, c), `round ${round}: ${c}`).toHaveLength(1);
    }
  });
});

describe("activeCredentialKey unique claim under true Postgres concurrency (Fase 5b)", () => {
  // The advisory lock only serializes writers that take it. These tests pit
  // bulkAddStock against a writer that does NOT, so the unique claim column is
  // the only thing that can keep a credential from going live twice.
  const cred = "claim-race@x.com:pw";
  const claimKey = () => `${sample.product.id}:${computeCredentialFingerprint(cred)}`;

  /** Opens a transaction that inserts a live row holding the claim, then waits for `finish` before committing or rolling back. */
  function holdClaimInOpenTransaction() {
    let finish!: (commit: boolean) => void;
    const decided = new Promise<boolean>((r) => (finish = r));
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => (inserted = r));
    const done = prisma
      .$transaction(
        async (tx) => {
          await tx.stockItem.create({
            data: {
              productId: sample.product.id,
              credentials: encryptCredentials(cred),
              credentialFingerprint: computeCredentialFingerprint(cred),
              identityFingerprint: computeIdentityFingerprint(cred),
              activeCredentialKey: claimKey(),
            },
          });
          inserted();
          if (!(await decided)) throw new Error("rollback requested by the test");
        },
        { timeout: 20_000 },
      )
      .then(
        () => "committed" as const,
        () => "rolled back" as const,
      );
    return { insertedP, finish, done };
  }

  /** Resolves once some session of this test schema is blocked on a lock while inserting a stock row. */
  async function importBlockedOnInsert(): Promise<void> {
    const schema = (await prisma.$queryRaw<{ schema: string }[]>`SELECT current_schema() AS schema`)[0]!.schema;
    const pattern = `%INSERT INTO "${schema}"."stock_items"%`;
    for (let i = 0; i < 200; i++) {
      const rows = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE ${pattern}`;
      if (rows[0]!.n > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("The import never blocked on the claim's unique index.");
  }

  it("an import racing an uncommitted claim waits on the unique index and counts itself a duplicate", async () => {
    const writer = holdClaimInOpenTransaction();
    await writer.insertedP;

    // Its dedup read can't see the uncommitted row, so it reaches the insert and blocks there.
    const importing = bulkAddStock(prisma, sample.product.id, [cred], sample.user.id);
    await importBlockedOnInsert();
    writer.finish(true);

    expect(await writer.done).toBe("committed");
    expect(await importing).toMatchObject({ added: 0, duplicateExisting: 1 });
    expect(await prisma.stockItem.count({ where: { activeCredentialKey: claimKey() } })).toBe(1);
    const rows = await prisma.stockItem.findMany({ where: { productId: sample.product.id } });
    expect(rows.filter((r) => decryptCredentials(r.credentials) === cred)).toHaveLength(1);
  });

  it("if the racing claim rolls back instead, the waiting import wins", async () => {
    const writer = holdClaimInOpenTransaction();
    await writer.insertedP;

    const importing = bulkAddStock(prisma, sample.product.id, [cred], sample.user.id);
    await importBlockedOnInsert();
    writer.finish(false);

    expect(await writer.done).toBe("rolled back");
    expect(await importing).toMatchObject({ added: 1, duplicateExisting: 0 });
    expect(await prisma.stockItem.count({ where: { activeCredentialKey: claimKey() } })).toBe(1);
  });

  it("two concurrent raw inserts of one claim: exactly one commits, the other fails on the unique constraint", async () => {
    const insert = () =>
      prisma.stockItem.create({
        data: { productId: sample.product.id, credentials: encryptCredentials(cred), activeCredentialKey: claimKey() },
      });
    const results = await Promise.allSettled([insert(), insert()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { code?: string }).code).toBe("P2002");
  });

  it("two concurrent identical imports: exactly one inserts, the other reports every line as an existing duplicate", async () => {
    const creds = Array.from({ length: 5 }, (_, i) => `twin-import-${i}@x.com:pw`);
    const [a, b] = await Promise.all([
      bulkAddStock(prisma, sample.product.id, creds, sample.user.id),
      bulkAddStock(prisma, sample.product.id, creds, sample.user.id),
    ]);
    const [winner, loser] = a.added > 0 ? [a, b] : [b, a];
    expect(winner).toMatchObject({ added: 5, duplicateExisting: 0 });
    expect(loser).toMatchObject({ added: 0, duplicateExisting: 5 });
    for (const c of creds) {
      const key = `${sample.product.id}:${computeCredentialFingerprint(c)}`;
      expect(await prisma.stockItem.count({ where: { activeCredentialKey: key } })).toBe(1);
    }
  });
});
