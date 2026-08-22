import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import { ordersByStatusSince, manualMatchQueueCounts, listCombinedLedger, recentOrders, reconcileFinances } from "./reports";

let db: TestDb;
let prisma: PrismaClient;
let userId: number;
let parentProductId: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.denomination.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
  await prisma.processedBinanceTx.deleteMany();
  await prisma.processedBybitTx.deleteMany();
  await prisma.processedTokopayTx.deleteMany();
  await prisma.processedPaydisiniTx.deleteMany();
  await prisma.processedNowpaymentsTx.deleteMany();

  const user = await prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
  });
  userId = user.id;
  const category = await createCategory(prisma, `Cat-${Math.random()}`);
  const parentProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: `Prod-${Math.random()}`, description: "x" });
  parentProductId = parentProduct.id;
});

describe("ordersByStatusSince", () => {
  it("only counts orders created since the cutoff", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 86_400_000 * 2);
    await prisma.order.create({
      data: { orderCode: `ORD-old-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", createdAt: old },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-new-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status: "PENDING_PAYMENT", createdAt: now },
    });

    const result = await ordersByStatusSince(prisma, new Date(now.getTime() - 60_000));
    expect(result).toEqual([{ status: "PENDING_PAYMENT", count: 1 }]);
  });
});

describe("manualMatchQueueCounts", () => {
  it("sums unmatched and delivery_failed rows across all five processed-tx tables", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: `bn-${Math.random()}`, amount: "1", outcome: "unmatched" } });
    await prisma.processedBybitTx.create({ data: { bybitTxId: `by-${Math.random()}`, amount: "1", outcome: "delivery_failed" } });
    await prisma.processedTokopayTx.create({ data: { trxId: `tp-${Math.random()}`, amount: "1", outcome: "unmatched" } });
    await prisma.processedPaydisiniTx.create({ data: { trxId: `pd-${Math.random()}`, amount: "1", outcome: "matched" } });
    await prisma.processedNowpaymentsTx.create({ data: { trxId: `np-${Math.random()}`, amount: "1", outcome: "delivery_failed" } });

    const result = await manualMatchQueueCounts(prisma);
    expect(result).toEqual({ unmatched: 2, deliveryFailed: 2 });
  });
});

describe("listCombinedLedger", () => {
  it("normalizes rows from all five gateway tables into one shape, tagged with their gateway", async () => {
    const binance = await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-1", amount: "1.5", outcome: "unmatched" } });
    const tokopay = await prisma.processedTokopayTx.create({ data: { trxId: "tp-1", amount: "50000", outcome: "delivery_failed" } });

    const { rows, total } = await listCombinedLedger(prisma);
    expect(rows).toHaveLength(2);
    expect(total).toBe(2);

    const binanceRow = rows.find((r) => r.reference === "bn-1");
    expect(binanceRow).toMatchObject({ id: binance.id, gateway: "binance", reference: "bn-1", amount: "1.5", outcome: "unmatched", orderId: null });

    const tokopayRow = rows.find((r) => r.reference === "tp-1");
    expect(tokopayRow).toMatchObject({ id: tokopay.id, gateway: "tokopay", reference: "tp-1", amount: "50000", outcome: "delivery_failed", orderId: null });
  });

  it("sorts merged rows by createdAt descending across gateways", async () => {
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-06-01T00:00:00.000Z");
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-old", amount: "1", outcome: "matched", createdAt: older } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-new", amount: "1", outcome: "matched", createdAt: newer } });

    const { rows } = await listCombinedLedger(prisma);
    expect(rows.map((r) => r.reference)).toEqual(["tp-new", "bn-old"]);
  });

  it("filters by outcome across gateways — the regression this task fixes: a non-Binance delivery_failed row used to be structurally invisible", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-fail", amount: "1", outcome: "delivery_failed" } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-fail", amount: "1", outcome: "delivery_failed" } });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-ok", amount: "1", outcome: "matched" } });

    const { rows, total } = await listCombinedLedger(prisma, { outcome: "delivery_failed" });
    expect(rows.map((r) => r.reference).sort()).toEqual(["bn-fail", "tp-fail"]);
    expect(total).toBe(2);
  });

  it("paginates the merged, sorted set in memory", async () => {
    for (let i = 0; i < 3; i++) {
      await prisma.processedBinanceTx.create({ data: { binanceTxId: `bn-${i}`, amount: "1", outcome: "unmatched", createdAt: new Date(2026, 0, i + 1) } });
    }
    const page1 = await listCombinedLedger(prisma, { limit: 2, offset: 0 });
    const page2 = await listCombinedLedger(prisma, { limit: 2, offset: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(1);
    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);
    expect(page1.rows.map((r) => r.reference)).toEqual(["bn-2", "bn-1"]);
    expect(page2.rows.map((r) => r.reference)).toEqual(["bn-0"]);
  });
});

/**
 * Wraps a real PrismaClient so `order.findMany` calls can be counted without
 * mutating (and having to restore) the shared client — the N+1 guard below
 * needs a call count, not a stub, so every call still hits the real database.
 */
function countingDb(client: PrismaClient, counter: { orderFindMany: number }): PrismaClient {
  const wrapDelegate = (delegate: Record<string, unknown>) =>
    new Proxy(delegate, {
      get(target, prop) {
        const value = target[prop as string];
        if (prop === "findMany" && typeof value === "function") {
          return (...args: unknown[]) => {
            counter.orderFindMany += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(client, {
    get(target, prop) {
      const value = (target as unknown as Record<string, unknown>)[prop as string];
      if (prop === "order") return wrapDelegate(value as Record<string, unknown>);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

describe("listCombinedLedger order enrichment (top-ups vs product sales)", () => {
  it("carries the order's code and kind onto every ledger row that has an orderId", async () => {
    const sale = await prisma.order.create({
      data: { orderCode: "ORD-SALE-1", userId, subtotalAmount: "1", totalAmount: "50000", status: "DELIVERED", kind: "PRODUCT" },
    });
    const topup = await prisma.order.create({
      data: { orderCode: "ORD-TOPUP-1", userId, subtotalAmount: "1", totalAmount: "100000", status: "DELIVERED", kind: "WALLET_TOPUP" },
    });
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-sale", amount: "50000", outcome: "matched", orderId: sale.id } });
    await prisma.processedPaydisiniTx.create({ data: { trxId: "pd-topup", amount: "100000", outcome: "matched", orderId: topup.id } });

    const { rows } = await listCombinedLedger(prisma);
    expect(rows.find((r) => r.reference === "tp-sale")).toMatchObject({ orderCode: "ORD-SALE-1", orderKind: "PRODUCT" });
    expect(rows.find((r) => r.reference === "pd-topup")).toMatchObject({ orderCode: "ORD-TOPUP-1", orderKind: "WALLET_TOPUP" });
  });

  it("keeps rows whose orderId is null, with null code and kind", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-orphan", amount: "1", outcome: "unmatched" } });

    const { rows, total } = await listCombinedLedger(prisma);
    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reference: "bn-orphan", orderId: null, orderCode: null, orderKind: null });
  });

  it("enriches the whole merged set with ONE order query, not one per row", async () => {
    for (let i = 0; i < 8; i++) {
      const order = await prisma.order.create({
        data: { orderCode: `ORD-N1-${i}`, userId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", kind: "PRODUCT" },
      });
      await prisma.processedTokopayTx.create({ data: { trxId: `tp-n1-${i}`, amount: "1", outcome: "matched", orderId: order.id } });
    }

    const counter = { orderFindMany: 0 };
    const { rows } = await listCombinedLedger(countingDb(prisma, counter), { limit: 50 });
    expect(rows).toHaveLength(8);
    expect(counter.orderFindMany).toBe(1);
  });

  it("filters by order kind consistently across page boundaries — total matches the rows the filter really yields", async () => {
    // 3 top-ups and 5 product sales, interleaved by createdAt so a page of 2
    // can never accidentally hold only one kind.
    const references: string[] = [];
    for (let i = 0; i < 8; i++) {
      const kind = i % 3 === 0 ? "WALLET_TOPUP" : "PRODUCT";
      const order = await prisma.order.create({
        data: { orderCode: `ORD-MIX-${i}`, userId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", kind },
      });
      const reference = `tp-mix-${i}`;
      references.push(reference);
      await prisma.processedTokopayTx.create({
        data: { trxId: reference, amount: "1", outcome: "matched", orderId: order.id, createdAt: new Date(2026, 0, i + 1) },
      });
    }
    // A ledger row with no order at all must not be counted as either kind.
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "bn-mix-orphan", amount: "1", outcome: "unmatched" } });

    const first = await listCombinedLedger(prisma, { kind: "WALLET_TOPUP", limit: 2, offset: 0 });
    expect(first.total).toBe(3);
    expect(first.rows).toHaveLength(2);

    const second = await listCombinedLedger(prisma, { kind: "WALLET_TOPUP", limit: 2, offset: 2 });
    expect(second.total).toBe(3);
    expect(second.rows).toHaveLength(1);

    const paged = [...first.rows, ...second.rows];
    expect(paged).toHaveLength(first.total);
    expect(paged.every((r) => r.orderKind === "WALLET_TOPUP")).toBe(true);
    expect(paged.map((r) => r.reference).sort()).toEqual(["tp-mix-0", "tp-mix-3", "tp-mix-6"]);

    // A third page past the end stays consistent rather than wrapping around.
    const third = await listCombinedLedger(prisma, { kind: "WALLET_TOPUP", limit: 2, offset: 4 });
    expect(third.total).toBe(3);
    expect(third.rows).toHaveLength(0);

    // And the complementary filter accounts for the rest — the orphan row
    // belongs to neither kind.
    const sales = await listCombinedLedger(prisma, { kind: "PRODUCT", limit: 50 });
    expect(sales.total).toBe(5);
    expect(sales.rows).toHaveLength(5);

    const unfiltered = await listCombinedLedger(prisma, { limit: 50 });
    expect(unfiltered.total).toBe(references.length + 1);
  });
});

describe("recentOrders", () => {
  it("returns newest first, with the first item's product name and an overflow count when there are more", async () => {
    const now = new Date();
    const productA = await createDenomination(prisma, { productId: parentProductId, name: "Product A", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const productB = await createDenomination(prisma, { productId: parentProductId, name: "Product B", type: "SHARED", durationLabel: "1 Month", price: "10000" });

    const order1 = await prisma.order.create({ data: { orderCode: "ORD-1", userId, subtotalAmount: "1", totalAmount: "10000", currency: "IDR", status: "DELIVERED", createdAt: new Date(now.getTime() - 60_000) } });
    await prisma.orderItem.create({ data: { orderId: order1.id, productId: productA.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });
    await prisma.orderItem.create({ data: { orderId: order1.id, productId: productB.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const order2 = await prisma.order.create({ data: { orderCode: "ORD-2", userId, subtotalAmount: "1", totalAmount: "5000", currency: "IDR", status: "PENDING_PAYMENT", createdAt: now } });
    await prisma.orderItem.create({ data: { orderId: order2.id, productId: productA.id, quantity: 1, unitPrice: "5000", warrantyDaysSnapshot: 30 } });

    const result = await recentOrders(prisma, 10);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ orderId: order2.id, orderCode: "ORD-2", productLabel: "Product A", amount: "5000", currency: "IDR", status: "PENDING_PAYMENT" });
    expect(result[1]).toMatchObject({ orderId: order1.id, orderCode: "ORD-1", productLabel: "Product A +1 more", amount: "10000" });
  });

  it("falls back to a Telegram-id label when the user has no username", async () => {
    const product = await createDenomination(prisma, { productId: parentProductId, name: "Solo product", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const order = await prisma.order.create({ data: { orderCode: "ORD-solo", userId, subtotalAmount: "1", totalAmount: "10000", currency: "IDR", status: "DELIVERED" } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const result = await recentOrders(prisma, 10);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(result[0]!.customerLabel).toBe(`Telegram ${user.telegramId}`);
  });
});

describe("reconcileFinances", () => {
  it("excludes WALLET_TOPUP orders from order_drift check", async () => {
    // Create a WALLET_TOPUP order with a mismatch that would show drift
    // if the PRODUCT-only formula were applied
    await prisma.order.create({
      data: {
        orderCode: "ORD-TOPUP-DRIFT",
        userId,
        subtotalAmount: "100000",
        totalAmount: "50000",
        currency: "IDR",
        status: "DELIVERED",
        kind: "WALLET_TOPUP",
      },
    });

    const findings = await reconcileFinances(prisma);

    // The WALLET_TOPUP order should NOT appear in order_drift
    expect(findings.order_drift).toHaveLength(0);
  });

  it("still detects drift in PRODUCT orders", async () => {
    // Create a PRODUCT order with a mismatch
    await prisma.order.create({
      data: {
        orderCode: "ORD-PRODUCT-DRIFT",
        userId,
        subtotalAmount: "100000",
        totalAmount: "50000",
        currency: "IDR",
        status: "DELIVERED",
        kind: "PRODUCT",
      },
    });

    const findings = await reconcileFinances(prisma);

    // The PRODUCT order should appear in order_drift
    expect(findings.order_drift).toHaveLength(1);
    expect(findings.order_drift[0]).toMatchObject({
      order_code: "ORD-PRODUCT-DRIFT",
    });
  });

  it("leaves voucher_drift and negative_wallets unaffected by WALLET_TOPUP orders", async () => {
    // Create a WALLET_TOPUP order
    await prisma.order.create({
      data: {
        orderCode: "ORD-TOPUP",
        userId,
        subtotalAmount: "100000",
        totalAmount: "100000",
        currency: "IDR",
        status: "DELIVERED",
        kind: "WALLET_TOPUP",
      },
    });

    const findings = await reconcileFinances(prisma);

    // voucher_drift and negative_wallets should be empty (no vouchers, no negative wallets)
    expect(findings.voucher_drift).toHaveLength(0);
    expect(findings.negative_wallets).toHaveLength(0);
  });
});
