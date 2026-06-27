/**
 * §4.1/§4.2 — sold-count aggregates. Feeds Product Detail's "X Terjual" line
 * and the Produk Populer screen (later tasks; nothing consumes these yet).
 *
 * Uses the real order-creation + approve/deliver crud helpers (no
 * hand-inserted rows) so DELIVERED status is reached the same way the app
 * reaches it: createOrderDirect → attachPaymentProof → approveOrder.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  attachPaymentProof,
  approveOrder,
  cancelOrder,
  rejectOrder,
  soldCountForDenomination,
  soldCountForProduct,
  soldCountsByDenomination,
  soldCountsByProduct,
} from "@app/db";

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

/** Create + deliver an order for `productId` (a denomination id) at `quantity`. */
async function deliverOrder(productId: number, quantity: number) {
  const { user } = sample;
  const created = await createOrderDirect(prisma, { user, productId, quantity });
  await attachPaymentProof(prisma, created!.id, { fileId: "fid", txid: `TX${created!.id}` });
  return approveOrder(prisma, created!.id, { adminId: user.id });
}

describe("soldCountForDenomination / soldCountsByDenomination", () => {
  it("zero case: no delivered orders → 0, absent from the sparse map", async () => {
    const { product } = sample;
    expect(await soldCountForDenomination(prisma, product.id)).toBe(0);

    const map = await soldCountsByDenomination(prisma, [product.id]);
    expect(map.has(product.id)).toBe(false);
    expect(map.get(product.id)).toBeUndefined();
  });

  it("post-deliver: count equals delivered quantity, sums across multiple delivered orders", async () => {
    const { product } = sample;
    await deliverOrder(product.id, 2);
    expect(await soldCountForDenomination(prisma, product.id)).toBe(2);

    await deliverOrder(product.id, 1);
    expect(await soldCountForDenomination(prisma, product.id)).toBe(3);

    const map = await soldCountsByDenomination(prisma, [product.id]);
    expect(map.get(product.id)).toBe(3);
  });

  it("excludes non-DELIVERED orders (PENDING_PAYMENT, CANCELLED) from the count", async () => {
    const { user, product } = sample;

    // PENDING_PAYMENT — never attaches proof, never approved.
    await createOrderDirect(prisma, { user, productId: product.id, quantity: 2 });

    // CANCELLED — created then cancelled before delivery.
    const toCancel = await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 });
    await cancelOrder(prisma, toCancel!.id, "user_cancelled");

    expect(await soldCountForDenomination(prisma, product.id)).toBe(0);
    const map = await soldCountsByDenomination(prisma, [product.id]);
    expect(map.has(product.id)).toBe(false);
  });

  it("excludes REJECTED orders from the count", async () => {
    const { user, product } = sample;
    const toReject = await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 });
    await attachPaymentProof(prisma, toReject!.id, { fileId: "fid", txid: "TXREJ" });
    await rejectOrder(prisma, toReject!.id, { adminId: user.id, reason: "bad proof" });

    expect(await soldCountForDenomination(prisma, product.id)).toBe(0);
  });

  it("soldCountsByDenomination only returns entries for ids passed in and with ≥1 sale", async () => {
    const { product } = sample;
    await deliverOrder(product.id, 4);

    const map = await soldCountsByDenomination(prisma, [product.id, 999999]);
    expect(map.size).toBe(1);
    expect(map.get(product.id)).toBe(4);
    expect(map.has(999999)).toBe(false);
  });

  it("soldCountsByDenomination([]) returns an empty map without querying", async () => {
    const map = await soldCountsByDenomination(prisma, []);
    expect(map.size).toBe(0);
  });
});

describe("soldCountsByProduct", () => {
  it("returns products sorted by sold desc, excludes zero-sale products, respects limit", async () => {
    const { category, product: product1, parentProduct: parent1, user } = sample;

    // A second Product (mid-tier) with its own denomination, no sales.
    const parent2 = await prisma.product.create({
      data: { categoryId: category.id, name: "Spotify Premium", slug: "spotify-premium" },
    });
    const denom2 = await prisma.denomination.create({
      data: {
        productId: parent2.id,
        name: "Spotify 1M",
        slug: "spotify-1m",
        type: "SHARED",
        durationLabel: "1 Month",
        price: "3.0000",
        warrantyDays: 30,
      },
    });
    await prisma.stockItem.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        productId: denom2.id,
        credentials: `spotify_cred_${i}`,
        status: "AVAILABLE" as const,
      })),
    });

    // A third Product (mid-tier) with sales, but fewer than product1.
    const parent3 = await prisma.product.create({
      data: { categoryId: category.id, name: "YouTube Premium", slug: "youtube-premium" },
    });
    const denom3 = await prisma.denomination.create({
      data: {
        productId: parent3.id,
        name: "YouTube 1M",
        slug: "youtube-1m",
        type: "SHARED",
        durationLabel: "1 Month",
        price: "2.0000",
        warrantyDays: 30,
      },
    });
    await prisma.stockItem.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        productId: denom3.id,
        credentials: `yt_cred_${i}`,
        status: "AVAILABLE" as const,
      })),
    });

    // product1 (Netflix denomination) gets 3 delivered units; denom3 gets 1;
    // denom2 (Spotify) gets none.
    await deliverOrder(product1.id, 3);
    const created3 = await createOrderDirect(prisma, { user, productId: denom3.id, quantity: 1 });
    await attachPaymentProof(prisma, created3!.id, { fileId: "fid3", txid: "TX3" });
    await approveOrder(prisma, created3!.id, { adminId: user.id });

    const results = await soldCountsByProduct(prisma, 10);

    // Only products with ≥1 sale appear.
    expect(results.map((r) => r.product.id).sort()).toEqual([parent1.id, parent3.id].sort());
    expect(results.find((r) => r.product.id === parent2.id)).toBeUndefined();

    // Sorted by sold desc.
    expect(results[0]?.product.id).toBe(parent1.id);
    expect(results[0]?.sold).toBe(3);
    expect(results[1]?.product.id).toBe(parent3.id);
    expect(results[1]?.sold).toBe(1);

    // Respects limit.
    const limited = await soldCountsByProduct(prisma, 1);
    expect(limited.length).toBe(1);
    expect(limited[0]?.product.id).toBe(parent1.id);
  });

  it("returns an empty array when no products have sales", async () => {
    const results = await soldCountsByProduct(prisma, 10);
    expect(results).toEqual([]);
  });
});

describe("soldCountForProduct", () => {
  it("zero case: no delivered orders → 0", async () => {
    const { parentProduct } = sample;
    expect(await soldCountForProduct(prisma, parentProduct.id)).toBe(0);
  });

  it("unknown product id → 0 (no denominations)", async () => {
    expect(await soldCountForProduct(prisma, 999999)).toBe(0);
  });

  it("sums delivered units across the product's denominations", async () => {
    const { parentProduct, product, user } = sample;

    // A second denomination under the SAME mid-tier product.
    const denom2 = await prisma.denomination.create({
      data: {
        productId: parentProduct.id,
        name: "Netflix 3M",
        slug: "netflix-3m",
        type: "SHARED",
        durationLabel: "3 Months",
        price: "9.0000",
        warrantyDays: 90,
      },
    });
    await prisma.stockItem.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        productId: denom2.id,
        credentials: `nf3m_cred_${i}`,
        status: "AVAILABLE" as const,
      })),
    });

    await deliverOrder(product.id, 3);
    await deliverOrder(denom2.id, 2);

    // 3 (denomination `product`) + 2 (denom2) = 5 for the parent product.
    expect(await soldCountForProduct(prisma, parentProduct.id)).toBe(5);
  });
});
