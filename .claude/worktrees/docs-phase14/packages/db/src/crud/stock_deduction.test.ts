/**
 * Port of tests/test_stock_deduction.py — stock state transitions.
 * Stock is NOT reserved at order creation; it moves AVAILABLE → SOLD only when
 * an admin approves. Cancel/reject leave the AVAILABLE count untouched.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  addToCart,
  createOrderFromCart,
  attachPaymentProof,
  approveOrder,
  cancelOrder,
  rejectOrder,
  getOrder,
  getUser,
} from "@app/db";
import { Decimal } from "@app/core/money";

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

const count = (productId: number, status: string) =>
  prisma.stockItem.count({ where: { productId, status } });

describe("stock deduction", () => {
  it("checkout does not reserve stock", async () => {
    const { user, product } = sample;
    expect(await count(product.id, "AVAILABLE")).toBe(5);
    expect(await count(product.id, "RESERVED")).toBe(0);

    await addToCart(prisma, user.id, product.id, 2);
    const created = await createOrderFromCart(prisma, { user });

    expect(await count(product.id, "AVAILABLE")).toBe(5);
    expect(await count(product.id, "RESERVED")).toBe(0);
    expect(await count(product.id, "SOLD")).toBe(0);

    const order = (await getOrder(prisma, created!.id))!;
    for (const item of order.items) expect(item.stockItem).toBeNull();
  });

  it("approve moves AVAILABLE → SOLD and returns credentials", async () => {
    const { user, product } = sample;
    await addToCart(prisma, user.id, product.id, 2);
    const created = await createOrderFromCart(prisma, { user });
    await attachPaymentProof(prisma, created!.id, { fileId: "dummy_file_id", txid: "ABC123XYZ" });

    expect(await count(product.id, "AVAILABLE")).toBe(5);

    const { order: o2, credentials } = await approveOrder(prisma, created!.id, {
      adminId: user.id,
    });

    expect(o2.status).toBe("DELIVERED");
    expect(credentials.length).toBe(2);
    for (const c of credentials) {
      expect(c.startsWith("user")).toBe(true);
      expect(c.includes(":pwd")).toBe(true);
    }

    expect(await count(product.id, "AVAILABLE")).toBe(3);
    expect(await count(product.id, "SOLD")).toBe(2);
    expect(await count(product.id, "RESERVED")).toBe(0);
  });

  it("cancel leaves stock unchanged", async () => {
    const { user, product } = sample;
    await addToCart(prisma, user.id, product.id, 3);
    const created = await createOrderFromCart(prisma, { user });

    expect(await count(product.id, "AVAILABLE")).toBe(5);
    await cancelOrder(prisma, created!.id, "user_cancelled");

    expect(await count(product.id, "AVAILABLE")).toBe(5);
    expect(await count(product.id, "RESERVED")).toBe(0);
  });

  it("reject leaves stock unchanged", async () => {
    const { user, product } = sample;
    await addToCart(prisma, user.id, product.id, 2);
    const created = await createOrderFromCart(prisma, { user });
    await attachPaymentProof(prisma, created!.id, { fileId: "dummy", txid: "ABC123XYZ" });

    expect(await count(product.id, "AVAILABLE")).toBe(5);
    await rejectOrder(prisma, created!.id, { adminId: user.id, reason: "bad proof" });

    expect(await count(product.id, "AVAILABLE")).toBe(5);
    expect(await count(product.id, "RESERVED")).toBe(0);
  });

  it("reject refunds wallet and rolls back voucher usage", async () => {
    const { product, voucher } = sample;
    let { user } = sample;

    // Give the user a 3.00 wallet balance, then re-read so the order sees it.
    await prisma.user.update({ where: { id: user.id }, data: { walletBalance: "3.0000" } });
    user = (await getUser(prisma, user.id))!;

    await addToCart(prisma, user.id, product.id, 2); // 10.00
    const created = await createOrderFromCart(prisma, {
      user,
      voucherCode: "SAVE10",
      walletAmount: "2.00",
    });
    await attachPaymentProof(prisma, created!.id, { fileId: "x", txid: "ABC123XYZ" });

    expect(new Decimal(created!.walletUsed).equals("2.0000")).toBe(true);
    let u = (await getUser(prisma, user.id))!;
    expect(new Decimal(u.walletBalance).equals("1.0000")).toBe(true);
    let v = (await prisma.voucher.findUnique({ where: { id: voucher.id } }))!;
    expect(v.usedCount).toBe(1);

    await rejectOrder(prisma, created!.id, { adminId: user.id, reason: "nope" });

    u = (await getUser(prisma, user.id))!;
    expect(new Decimal(u.walletBalance).equals("3.0000")).toBe(true);
    v = (await prisma.voucher.findUnique({ where: { id: voucher.id } }))!;
    expect(v.usedCount).toBe(0);
  });
});
