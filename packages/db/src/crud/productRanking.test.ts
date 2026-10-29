/**
 * Bestseller ranking: distinct delivered orders per product, the cached
 * snapshot, and the pure comparators. Orders are inserted directly so
 * `deliveredAt` and `kind` can be controlled.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { OrderKind, OrderStatus } from "@app/core/enums";
import { upsertUser } from "./users";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import {
  BESTSELLER_TTL_MS,
  compareBestseller,
  compareNewest,
  deliveredOrderCountsByProduct,
  getBestsellerSnapshot,
  getBestsellerSnapshotByVersion,
  resetBestsellerCache,
  type BestsellerSnapshot,
} from "./productRanking";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

let categoryId: number;
let userId: number;
let seq = 0;

beforeEach(async () => {
  await resetDb(prisma);
  resetBestsellerCache(prisma);
  categoryId = (await createCategory(prisma, `cat${Math.random()}`)).id;
  userId = (
    await upsertUser(prisma, { telegramId: Math.floor(Math.random() * 1_000_000_000), username: null, fullName: null })
  ).id;
});

const DAY = 24 * 3600_000;

async function makeProductWithDenoms(name: string, denomCount = 1) {
  const product = await createCatalogProduct(prisma, { categoryId, name });
  const denoms = [];
  for (let i = 0; i < denomCount; i++) {
    denoms.push(
      await createDenomination(prisma, {
        productId: product.id,
        name: `${name} ${i}`,
        type: "SHARED",
        durationLabel: "1 Month",
        price: "5",
      }),
    );
  }
  return { product, denoms };
}

async function makeOrder(args: {
  items: { denominationId: number; quantity?: number }[];
  status?: string;
  kind?: string;
  deliveredAt?: Date | null;
}) {
  seq++;
  return prisma.order.create({
    data: {
      orderCode: `RNK-${seq}-${Math.random()}`,
      userId,
      subtotalAmount: "5",
      totalAmount: "5",
      status: args.status ?? OrderStatus.DELIVERED,
      kind: args.kind ?? OrderKind.PRODUCT,
      deliveredAt: args.deliveredAt === undefined ? new Date() : args.deliveredAt,
      items: {
        create: args.items.map((i) => ({
          productId: i.denominationId,
          quantity: i.quantity ?? 1,
          unitPrice: "5",
          warrantyDaysSnapshot: 0,
        })),
      },
    },
  });
}

describe("deliveredOrderCountsByProduct", () => {
  it("counts delivered orders per product and returns an empty map for none", async () => {
    expect((await deliveredOrderCountsByProduct(prisma)).size).toBe(0);
    const { product, denoms } = await makeProductWithDenoms("Alpha");
    await makeOrder({ items: [{ denominationId: denoms[0]!.id }] });
    await makeOrder({ items: [{ denominationId: denoms[0]!.id }] });
    const counts = await deliveredOrderCountsByProduct(prisma);
    expect(counts.get(product.id)).toBe(2);
  });

  it("applies the since window to deliveredAt", async () => {
    const { product, denoms } = await makeProductWithDenoms("Windowed");
    const now = Date.now();
    await makeOrder({ items: [{ denominationId: denoms[0]!.id }], deliveredAt: new Date(now - 31 * DAY) });
    await makeOrder({ items: [{ denominationId: denoms[0]!.id }], deliveredAt: new Date(now - 2 * DAY) });
    const since = new Date(now - 30 * DAY);
    expect((await deliveredOrderCountsByProduct(prisma, since)).get(product.id)).toBe(1);
    expect((await deliveredOrderCountsByProduct(prisma)).get(product.id)).toBe(2);
  });

  it("ignores REFUNDED, CANCELLED and PENDING_PAYMENT orders", async () => {
    const { product, denoms } = await makeProductWithDenoms("Statuses");
    const id = denoms[0]!.id;
    await makeOrder({ items: [{ denominationId: id }], status: OrderStatus.REFUNDED });
    await makeOrder({ items: [{ denominationId: id }], status: OrderStatus.CANCELLED });
    await makeOrder({ items: [{ denominationId: id }], status: OrderStatus.PENDING_PAYMENT, deliveredAt: null });
    const counts = await deliveredOrderCountsByProduct(prisma);
    expect(counts.has(product.id)).toBe(false);
  });

  it("ignores non-PRODUCT order kinds", async () => {
    const { product, denoms } = await makeProductWithDenoms("Kinds");
    await makeOrder({ items: [{ denominationId: denoms[0]!.id }], kind: OrderKind.WALLET_TOPUP });
    expect((await deliveredOrderCountsByProduct(prisma)).has(product.id)).toBe(false);
  });

  it("counts distinct orders, not quantity or denominations", async () => {
    const { product, denoms } = await makeProductWithDenoms("Distinct", 2);
    await makeOrder({ items: [{ denominationId: denoms[0]!.id, quantity: 5 }] });
    await makeOrder({ items: [{ denominationId: denoms[0]!.id }, { denominationId: denoms[1]!.id }] });
    expect((await deliveredOrderCountsByProduct(prisma)).get(product.id)).toBe(2);
  });
});

describe("comparators", () => {
  const d = (n: number) => new Date(2026, 0, n);

  it("compareNewest orders by createdAt desc, then id desc", () => {
    const list = [
      { id: 1, createdAt: d(1) },
      { id: 2, createdAt: d(3) },
      { id: 3, createdAt: d(3) },
    ];
    expect(list.sort(compareNewest).map((p) => p.id)).toEqual([3, 2, 1]);
  });

  it("compareBestseller: recent, then all-time, then newest", () => {
    const snapshot: BestsellerSnapshot = {
      version: 1,
      computedAt: new Date(),
      recent: new Map([
        [1, 5],
        [2, 5],
        [3, 9],
      ]),
      allTime: new Map([
        [1, 7],
        [2, 20],
        [3, 9],
      ]),
    };
    const list = [
      { id: 1, createdAt: d(1) },
      { id: 2, createdAt: d(1) },
      { id: 3, createdAt: d(1) },
      { id: 4, createdAt: d(5) },
      { id: 5, createdAt: d(9) },
    ];
    // 3 (recent 9) > 2 (5, all-time 20) > 1 (5, all-time 7) > no sales: 5 (newer) > 4
    expect(list.sort(compareBestseller(snapshot)).map((p) => p.id)).toEqual([3, 2, 1, 5, 4]);
  });
});

describe("getBestsellerSnapshot cache", () => {
  it("splits recent and all-time counts using a 30-day window from now", async () => {
    const { product, denoms } = await makeProductWithDenoms("Snap");
    const now = new Date();
    await makeOrder({ items: [{ denominationId: denoms[0]!.id }], deliveredAt: new Date(now.getTime() - 40 * DAY) });
    await makeOrder({ items: [{ denominationId: denoms[0]!.id }], deliveredAt: new Date(now.getTime() - DAY) });
    const snap = await getBestsellerSnapshot(prisma, { now });
    expect(snap.version).toBe(1);
    expect(snap.recent.get(product.id)).toBe(1);
    expect(snap.allTime.get(product.id)).toBe(2);
  });

  it("reuses the snapshot within the TTL and recomputes after it", async () => {
    const t0 = new Date("2026-10-01T00:00:00Z");
    const first = await getBestsellerSnapshot(prisma, { now: t0 });
    const again = await getBestsellerSnapshot(prisma, { now: new Date(t0.getTime() + BESTSELLER_TTL_MS - 1) });
    expect(again).toBe(first);
    const later = await getBestsellerSnapshot(prisma, { now: new Date(t0.getTime() + BESTSELLER_TTL_MS) });
    expect(later.version).toBe(first.version + 1);
  });

  it("shares one computation between concurrent callers", async () => {
    const now = new Date();
    const [a, b, c] = await Promise.all([
      getBestsellerSnapshot(prisma, { now }),
      getBestsellerSnapshot(prisma, { now }),
      getBestsellerSnapshot(prisma, { now }),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.version).toBe(1);
  });

  it("keeps the previous snapshot retrievable by version, older ones are gone", async () => {
    const t0 = new Date("2026-10-01T00:00:00Z");
    const step = BESTSELLER_TTL_MS + 1;
    const v1 = await getBestsellerSnapshot(prisma, { now: t0 });
    const v2 = await getBestsellerSnapshot(prisma, { now: new Date(t0.getTime() + step) });
    expect(await getBestsellerSnapshotByVersion(prisma, v2.version)).toBe(v2);
    expect(await getBestsellerSnapshotByVersion(prisma, v1.version)).toBe(v1);
    const v3 = await getBestsellerSnapshot(prisma, { now: new Date(t0.getTime() + 2 * step) });
    expect(v3.version).toBe(3);
    expect(await getBestsellerSnapshotByVersion(prisma, v2.version)).toBe(v2);
    expect(await getBestsellerSnapshotByVersion(prisma, v1.version)).toBeNull();
    expect(await getBestsellerSnapshotByVersion(prisma, 99)).toBeNull();
  });
});
