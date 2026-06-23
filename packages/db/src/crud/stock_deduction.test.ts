/**
 * Port of tests/test_stock_deduction.py — stock state transitions.
 * Stock IS reserved atomically at order creation (Checkout-2/Stock-1 fix,
 * security audit 2026-06-23): AVAILABLE → RESERVED on checkout, RESERVED →
 * SOLD only when an admin approves. Cancel/reject release the reservation
 * back to AVAILABLE (net stock count unchanged end-to-end, but dips while
 * the order is pending).
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
  it("checkout reserves one stock row per unit (AVAILABLE → RESERVED)", async () => {
    const { user, product } = sample;
    expect(await count(product.id, "AVAILABLE")).toBe(5);
    expect(await count(product.id, "RESERVED")).toBe(0);

    await addToCart(prisma, user.id, product.id, 2);
    const created = await createOrderFromCart(prisma, { user });

    expect(await count(product.id, "AVAILABLE")).toBe(3);
    expect(await count(product.id, "RESERVED")).toBe(2);
    expect(await count(product.id, "SOLD")).toBe(0);

    const order = (await getOrder(prisma, created!.id))!;
    for (const item of order.items) {
      expect(item.stockItem).not.toBeNull();
      expect(item.stockItem!.status).toBe("RESERVED");
      expect(item.stockItem!.orderId).toBe(order.id);
    }
  });

  it("checkout fails fast with error.out_of_stock when demand exceeds supply (no partial reservation left behind)", async () => {
    const { user, product } = sample;
    await addToCart(prisma, user.id, product.id, 10); // only 5 in stock
    await expect(createOrderFromCart(prisma, { user })).rejects.toMatchObject({ key: "error.out_of_stock" });

    // The whole transaction rolled back — no stock left dangling RESERVED.
    expect(await count(product.id, "AVAILABLE")).toBe(5);
    expect(await count(product.id, "RESERVED")).toBe(0);
  });

  it("approve flips the ALREADY-reserved rows to SOLD (no new allocation) and returns credentials", async () => {
    const { user, product } = sample;
    await addToCart(prisma, user.id, product.id, 2);
    const created = await createOrderFromCart(prisma, { user });
    await attachPaymentProof(prisma, created!.id, { fileId: "dummy_file_id", txid: "ABC123XYZ" });

    expect(await count(product.id, "AVAILABLE")).toBe(3);
    expect(await count(product.id, "RESERVED")).toBe(2);

    const { order: o2, credentials } = await approveOrder(prisma, created!.id, {
      adminId: user.id,
    });

    expect(o2.status).toBe("DELIVERED");
    expect(credentials.length).toBe(2);
    for (const c of credentials) {
      expect(c.startsWith("user")).toBe(true);
      expect(c.includes(":pwd")).toBe(true);
    }

    expect(await count(product.id, "AVAILABLE")).toBe(3); // unchanged — these 2 were already reserved, not pulled fresh
    expect(await count(product.id, "SOLD")).toBe(2);
    expect(await count(product.id, "RESERVED")).toBe(0);

    // Checkout-6 (security audit, 2026-06-23): a REAL admin id must NOT get
    // an extra "order.auto_deliver" row — callers (verification.ts,
    // web-admin's /orders/:id/approve) already log their own "approve_order"
    // row; approveOrder only adds the auto-deliver row for adminId===0.
    const autoRows = await prisma.auditLog.findMany({ where: { action: "order.auto_deliver", targetId: created!.id } });
    expect(autoRows.length).toBe(0);
  });

  // Bot-2 fix (security audit, 2026-06-23): approveOrder claims
  // PENDING_VERIFICATION -> DELIVERED via an atomic conditional updateMany
  // instead of a read-then-throw check, so a second approve attempt on an
  // already-DELIVERED order is rejected by the DB-level claim itself, not by
  // an in-memory snapshot that could be stale under non-serializing isolation.
  it("a second approveOrder on an already-DELIVERED order is rejected by the atomic claim, not double-applied", async () => {
    const { user, product } = sample;
    await addToCart(prisma, user.id, product.id, 1);
    const created = await createOrderFromCart(prisma, { user });
    await attachPaymentProof(prisma, created!.id, { fileId: "dummy", txid: "ABC123XYZ" });

    const { credentials: first } = await approveOrder(prisma, created!.id, { adminId: user.id });
    expect(first.length).toBe(1);
    expect(await count(product.id, "SOLD")).toBe(1);

    await expect(approveOrder(prisma, created!.id, { adminId: user.id })).rejects.toMatchObject({
      key: "error.order_not_pending_verification",
    });

    // No second credential pulled, no double-SOLD, no second referral/notify pass.
    expect(await count(product.id, "SOLD")).toBe(1);
    const order = await getOrder(prisma, created!.id);
    expect(order!.status).toBe("DELIVERED");
  });

  it("cancel releases the reservation back to AVAILABLE", async () => {
    const { user, product } = sample;
    await addToCart(prisma, user.id, product.id, 3);
    const created = await createOrderFromCart(prisma, { user });

    expect(await count(product.id, "AVAILABLE")).toBe(2);
    expect(await count(product.id, "RESERVED")).toBe(3);
    await cancelOrder(prisma, created!.id, "user_cancelled");

    expect(await count(product.id, "AVAILABLE")).toBe(5);
    expect(await count(product.id, "RESERVED")).toBe(0);
  });

  it("reject releases the reservation back to AVAILABLE", async () => {
    const { user, product } = sample;
    await addToCart(prisma, user.id, product.id, 2);
    const created = await createOrderFromCart(prisma, { user });
    await attachPaymentProof(prisma, created!.id, { fileId: "dummy", txid: "ABC123XYZ" });

    expect(await count(product.id, "AVAILABLE")).toBe(3);
    expect(await count(product.id, "RESERVED")).toBe(2);
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
