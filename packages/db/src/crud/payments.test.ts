/**
 * Payment domain crud (Trustance Phase A Task A2a): createPaymentAttempt,
 * listPaymentAttempts, and the confirm/expire state machine's exhaustive
 * legal-transition matrix — mirrors refunds.test.ts's structure. Also covers
 * the "change payment rail" composition (expire the old PENDING attempt,
 * open a new one on the SAME order) and a TRUE-concurrency regression test
 * for the one-PENDING-payment-per-order invariant, same technique as
 * checkout_intent_concurrency.test.ts / stock_concurrency.test.ts: fire
 * multiple `createPaymentAttempt` calls at the SAME instant via
 * `Promise.allSettled` against the real dev Postgres, which has actual
 * concurrent writers — a sequential, one-await-at-a-time pair of calls could
 * never distinguish "the pendingOrderId unique claim holds under a genuine
 * race" from "the second call just happened to run after the first
 * committed" (see Payment.pendingOrderId's doc comment in schema.prisma).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PaymentStatus, PaymentExpiryReason } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect } from "./orders";
import {
  createPaymentAttempt,
  listPaymentAttempts,
  expirePaymentAttempt,
  confirmPaymentAttempt,
  PAYMENT_LEGAL_TRANSITIONS,
} from "./payments";

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

async function makeOrder() {
  const order = await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 });
  return order!;
}

async function makeAdmin() {
  return prisma.user.create({
    data: { telegramId: Math.floor(Math.random() * 1_000_000_000), username: "admin", fullName: "Admin", role: "ADMIN", referralCode: `a${Math.random()}` },
  });
}

describe("createPaymentAttempt", () => {
  it("creates a PENDING attempt pinned to the order's currency", async () => {
    const order = await makeOrder();

    const payment = await createPaymentAttempt(prisma, {
      orderId: order.id,
      method: "TOKOPAY",
      amount: order.totalAmount,
      currency: order.currency,
    });

    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(payment.currency).toBe(order.currency);
    expect(payment.orderId).toBe(order.id);
    expect(payment.method).toBe("TOKOPAY");
    expect(payment.expiredAt).toBeNull();
    expect(payment.confirmedAt).toBeNull();
    expect(payment.expiryReason).toBeNull();
  });

  it("audits the creation with the acting admin id when provided", async () => {
    const order = await makeOrder();
    const admin = await makeAdmin();

    const payment = await createPaymentAttempt(prisma, {
      orderId: order.id,
      method: "TOKOPAY",
      amount: order.totalAmount,
      currency: order.currency,
      adminId: admin.id,
    });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "payment_attempt_created", targetId: payment.id } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.adminId).toBe(admin.id);
    expect(auditRows[0]!.details).toContain(order.orderCode);
  });

  it("audits with a null adminId when the attempt is buyer-initiated (no admin)", async () => {
    const order = await makeOrder();

    const payment = await createPaymentAttempt(prisma, {
      orderId: order.id,
      method: "TOKOPAY",
      amount: order.totalAmount,
      currency: order.currency,
    });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "payment_attempt_created", targetId: payment.id } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.adminId).toBeNull();
  });

  it("rejects a currency mismatch against the order's own currency", async () => {
    const order = await makeOrder();
    expect(order.currency).toBe("IDR");

    await expect(
      createPaymentAttempt(prisma, { orderId: order.id, method: "BINANCE_INTERNAL", amount: "5.00", currency: "USDT" }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a non-existent order", async () => {
    await expect(
      createPaymentAttempt(prisma, { orderId: 999_999_999, method: "TOKOPAY", amount: "5.00", currency: "IDR" }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a zero amount", async () => {
    const order = await makeOrder();
    await expect(
      createPaymentAttempt(prisma, { orderId: order.id, method: "TOKOPAY", amount: "0", currency: order.currency }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a negative amount", async () => {
    const order = await makeOrder();
    await expect(
      createPaymentAttempt(prisma, { orderId: order.id, method: "TOKOPAY", amount: "-5.00", currency: order.currency }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a malformed amount string as a clean ValidationError, not a raw DecimalError", async () => {
    const order = await makeOrder();
    await expect(
      createPaymentAttempt(prisma, { orderId: order.id, method: "TOKOPAY", amount: "not-a-number", currency: order.currency }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a second PENDING attempt for the same order (sequential — the pendingOrderId unique claim)", async () => {
    const order = await makeOrder();
    await createPaymentAttempt(prisma, { orderId: order.id, method: "TOKOPAY", amount: order.totalAmount, currency: order.currency });

    await expect(
      createPaymentAttempt(prisma, { orderId: order.id, method: "PAYDISINI", amount: order.totalAmount, currency: order.currency }),
    ).rejects.toThrow(ValidationError);

    const rows = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(1);
  });

  it("allows a new PENDING attempt once the prior one is no longer PENDING", async () => {
    const order = await makeOrder();
    const first = await createPaymentAttempt(prisma, { orderId: order.id, method: "TOKOPAY", amount: order.totalAmount, currency: order.currency });
    await expirePaymentAttempt(prisma, { paymentId: first.id, reason: PaymentExpiryReason.TIMEOUT });

    const second = await createPaymentAttempt(prisma, { orderId: order.id, method: "PAYDISINI", amount: order.totalAmount, currency: order.currency });
    expect(second.status).toBe(PaymentStatus.PENDING);

    const rows = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(2);
  });
});

describe("listPaymentAttempts", () => {
  it("lists an order's attempts newest first", async () => {
    const order = await makeOrder();
    const first = await createPaymentAttempt(prisma, { orderId: order.id, method: "TOKOPAY", amount: order.totalAmount, currency: order.currency });
    await expirePaymentAttempt(prisma, { paymentId: first.id, reason: PaymentExpiryReason.TIMEOUT });
    const second = await createPaymentAttempt(prisma, { orderId: order.id, method: "PAYDISINI", amount: order.totalAmount, currency: order.currency });

    const attempts = await listPaymentAttempts(prisma, order.id);
    expect(attempts.map((p) => p.id)).toEqual([second.id, first.id]);
  });

  it("only returns attempts for the requested order", async () => {
    const orderA = await makeOrder();
    const orderB = await makeOrder();
    await createPaymentAttempt(prisma, { orderId: orderA.id, method: "TOKOPAY", amount: orderA.totalAmount, currency: orderA.currency });
    await createPaymentAttempt(prisma, { orderId: orderB.id, method: "TOKOPAY", amount: orderB.totalAmount, currency: orderB.currency });

    const attempts = await listPaymentAttempts(prisma, orderA.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.orderId).toBe(orderA.id);
  });
});

describe("state machine — PAYMENT_LEGAL_TRANSITIONS", () => {
  it("encodes exactly the documented shape", () => {
    expect(PAYMENT_LEGAL_TRANSITIONS[PaymentStatus.PENDING]!.slice().sort()).toEqual(
      [PaymentStatus.CONFIRMED, PaymentStatus.EXPIRED, PaymentStatus.FAILED].sort(),
    );
    expect(PAYMENT_LEGAL_TRANSITIONS[PaymentStatus.CONFIRMED]).toEqual([]);
    expect(PAYMENT_LEGAL_TRANSITIONS[PaymentStatus.EXPIRED]).toEqual([]);
    expect(PAYMENT_LEGAL_TRANSITIONS[PaymentStatus.FAILED]).toEqual([]);
  });
});

describe("confirmPaymentAttempt", () => {
  it("PENDING -> CONFIRMED succeeds, stamps confirmedAt, and is audited", async () => {
    const order = await makeOrder();
    const admin = await makeAdmin();
    const payment = await createPaymentAttempt(prisma, { orderId: order.id, method: "TOKOPAY", amount: order.totalAmount, currency: order.currency });

    const result = await confirmPaymentAttempt(prisma, { paymentId: payment.id, adminId: admin.id });

    expect(result.status).toBe(PaymentStatus.CONFIRMED);
    expect(result.confirmedAt).toBeInstanceOf(Date);

    const auditRows = await prisma.auditLog.findMany({ where: { action: "payment_status_change", targetId: payment.id } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.adminId).toBe(admin.id);
    expect(auditRows[0]!.details).toContain("confirmed");
  });

  it("rejects confirming a non-existent payment", async () => {
    await expect(confirmPaymentAttempt(prisma, { paymentId: 999_999_999 })).rejects.toThrow(ValidationError);
  });

  it("rejects confirming a payment that is already CONFIRMED (stale claim)", async () => {
    const order = await makeOrder();
    const payment = await createPaymentAttempt(prisma, { orderId: order.id, method: "TOKOPAY", amount: order.totalAmount, currency: order.currency });
    await confirmPaymentAttempt(prisma, { paymentId: payment.id });

    await expect(confirmPaymentAttempt(prisma, { paymentId: payment.id })).rejects.toThrow(ValidationError);
  });

  const illegalConfirmFrom: readonly string[] = [PaymentStatus.CONFIRMED, PaymentStatus.EXPIRED, PaymentStatus.FAILED];
  it.each(illegalConfirmFrom)("rejects %s -> CONFIRMED as illegal", async (from) => {
    const order = await makeOrder();
    const payment = await createPaymentAttempt(prisma, { orderId: order.id, method: "TOKOPAY", amount: order.totalAmount, currency: order.currency });
    await prisma.payment.update({ where: { id: payment.id }, data: { status: from } });

    const auditRowsBefore = await prisma.auditLog.findMany({ where: { action: "payment_status_change", targetId: payment.id } });
    await expect(confirmPaymentAttempt(prisma, { paymentId: payment.id })).rejects.toThrow(ValidationError);
    const auditRowsAfter = await prisma.auditLog.findMany({ where: { action: "payment_status_change", targetId: payment.id } });
    expect(auditRowsAfter).toHaveLength(auditRowsBefore.length);
  });
});

describe("expirePaymentAttempt", () => {
  it("PENDING -> EXPIRED succeeds, stamps expiredAt/expiryReason, and is audited", async () => {
    const order = await makeOrder();
    const admin = await makeAdmin();
    const payment = await createPaymentAttempt(prisma, { orderId: order.id, method: "TOKOPAY", amount: order.totalAmount, currency: order.currency });

    const result = await expirePaymentAttempt(prisma, { paymentId: payment.id, reason: PaymentExpiryReason.TIMEOUT, adminId: admin.id });

    expect(result.status).toBe(PaymentStatus.EXPIRED);
    expect(result.expiredAt).toBeInstanceOf(Date);
    expect(result.expiryReason).toBe(PaymentExpiryReason.TIMEOUT);

    const auditRows = await prisma.auditLog.findMany({ where: { action: "payment_status_change", targetId: payment.id } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.adminId).toBe(admin.id);
    expect(auditRows[0]!.details).toContain("TIMEOUT");
  });

  it("rejects expiring a non-existent payment", async () => {
    await expect(
      expirePaymentAttempt(prisma, { paymentId: 999_999_999, reason: PaymentExpiryReason.TIMEOUT }),
    ).rejects.toThrow(ValidationError);
  });

  const illegalExpireFrom: readonly string[] = [PaymentStatus.CONFIRMED, PaymentStatus.EXPIRED, PaymentStatus.FAILED];
  it.each(illegalExpireFrom)("rejects %s -> EXPIRED as illegal", async (from) => {
    const order = await makeOrder();
    const payment = await createPaymentAttempt(prisma, { orderId: order.id, method: "TOKOPAY", amount: order.totalAmount, currency: order.currency });
    await prisma.payment.update({ where: { id: payment.id }, data: { status: from } });

    await expect(
      expirePaymentAttempt(prisma, { paymentId: payment.id, reason: PaymentExpiryReason.TIMEOUT }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("rail-change composition (create -> expire RAIL_CHANGED -> create, same order)", () => {
  it("retires the old attempt as EXPIRED/RAIL_CHANGED and opens a new PENDING attempt on the SAME order", async () => {
    const order = await makeOrder();
    const oldAttempt = await createPaymentAttempt(prisma, { orderId: order.id, method: "TOKOPAY", amount: order.totalAmount, currency: order.currency });

    const expired = await expirePaymentAttempt(prisma, { paymentId: oldAttempt.id, reason: PaymentExpiryReason.RAIL_CHANGED });
    const newAttempt = await createPaymentAttempt(prisma, { orderId: order.id, method: "PAYDISINI", amount: order.totalAmount, currency: order.currency });

    expect(expired.status).toBe(PaymentStatus.EXPIRED);
    expect(expired.expiryReason).toBe(PaymentExpiryReason.RAIL_CHANGED);
    expect(expired.orderId).toBe(order.id);

    expect(newAttempt.status).toBe(PaymentStatus.PENDING);
    expect(newAttempt.orderId).toBe(order.id);
    expect(newAttempt.method).toBe("PAYDISINI");
    expect(newAttempt.id).not.toBe(oldAttempt.id);

    // Both attempts remain on record, same order — a rail change is a new
    // ledger entry, not a mutation/overwrite of the old one.
    const attempts = await listPaymentAttempts(prisma, order.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((p) => p.orderId === order.id)).toBe(true);
  });
});

describe("createPaymentAttempt under true Postgres concurrency — one PENDING per order", () => {
  it("5 concurrent createPaymentAttempt calls for the SAME order: exactly 1 succeeds PENDING, 4 reject with ValidationError, and only 1 row exists", async () => {
    const order = await makeOrder();

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        createPaymentAttempt(prisma, {
          orderId: order.id,
          method: i % 2 === 0 ? "TOKOPAY" : "PAYDISINI",
          amount: order.totalAmount,
          currency: order.currency,
        }),
      ),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createPaymentAttempt>>> => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(4);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ValidationError);
    }

    // Only the winner's row actually persisted — the pendingOrderId unique
    // index rejected the INSERT itself for every loser, not just the return value.
    const rows = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(PaymentStatus.PENDING);
    expect(rows[0]!.id).toBe(fulfilled[0]!.value!.id);
  });

  it("concurrent createPaymentAttempt calls for DIFFERENT orders all succeed (the constraint doesn't over-block)", async () => {
    const orderA = await makeOrder();
    const orderB = await makeOrder();

    const results = await Promise.allSettled([
      createPaymentAttempt(prisma, { orderId: orderA.id, method: "TOKOPAY", amount: orderA.totalAmount, currency: orderA.currency }),
      createPaymentAttempt(prisma, { orderId: orderB.id, method: "TOKOPAY", amount: orderB.totalAmount, currency: orderB.currency }),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await prisma.payment.count({ where: { orderId: orderA.id } })).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: orderB.id } })).toBe(1);
  });
});
