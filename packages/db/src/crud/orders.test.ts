import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  countPendingPaymentLike,
  countProcessing,
  countPendingVerifications,
  countUnderpaid,
  countExpiredPending,
  claimGatewaySlot,
  commitGatewayResult,
  releaseGatewaySlot,
  gatewayClaimSentinel,
  createOrderFromCart,
} from "./orders";
import { addToCart, upsertBulkPricing, createVoucher } from "@app/db";
import { VoucherType } from "@app/core/enums";
import { Decimal } from "@app/core/money";

let db: TestDb;
let prisma: PrismaClient;
let userId: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.order.deleteMany();
  await prisma.user.deleteMany();
  const user = await prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
  });
  userId = user.id;
});

function makeOrder(status: string, extra: Record<string, unknown> = {}) {
  return prisma.order.create({
    data: { orderCode: `ORD-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status, ...extra },
  });
}

describe("order status counts", () => {
  it("countPendingPaymentLike counts PENDING_PAYMENT, PAYMENT_DETECTED, and CONFIRMING", async () => {
    await makeOrder("PENDING_PAYMENT");
    await makeOrder("PAYMENT_DETECTED");
    await makeOrder("CONFIRMING");
    await makeOrder("DELIVERED");
    expect(await countPendingPaymentLike(prisma)).toBe(3);
  });

  it("countProcessing counts CONFIRMED and PAID", async () => {
    await makeOrder("CONFIRMED");
    await makeOrder("PAID");
    await makeOrder("DELIVERED");
    expect(await countProcessing(prisma)).toBe(2);
  });

  it("countPendingVerifications counts every PENDING_VERIFICATION row, with no page-size cap", async () => {
    for (let i = 0; i < 5; i++) await makeOrder("PENDING_VERIFICATION");
    expect(await countPendingVerifications(prisma)).toBe(5);
  });

  it("countUnderpaid counts UNDERPAID orders", async () => {
    await makeOrder("UNDERPAID");
    await makeOrder("PAID");
    expect(await countUnderpaid(prisma)).toBe(1);
  });

  it("countExpiredPending counts only PENDING_PAYMENT orders whose expiresAt has passed", async () => {
    const now = new Date();
    await makeOrder("PENDING_PAYMENT", { expiresAt: new Date(now.getTime() - 60_000) });
    await makeOrder("PENDING_PAYMENT", { expiresAt: new Date(now.getTime() + 60_000) });
    await makeOrder("PENDING_PAYMENT", { expiresAt: null });
    expect(await countExpiredPending(prisma, now)).toBe(1);
  });
});

// Data-2 fix (backend audit 2026-07-07): the checkout gateway-invoice race —
// see apps/storefront/test/checkout-gateway-race.test.ts for the route-level
// concurrent-request test. These are the crud-level unit tests for the
// atomic claim/commit/release primitives themselves.
describe("claimGatewaySlot / commitGatewayResult / releaseGatewaySlot (Data-2)", () => {
  it("claim succeeds once; a second claim on the same order fails", async () => {
    const order = await makeOrder("PENDING_PAYMENT");

    expect(await claimGatewaySlot(prisma, order.id)).toBe(true);
    const claimed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(claimed!.paymentRef).toBe(gatewayClaimSentinel(order.id));

    // A second claim (a concurrent request, or a stale retry) must not
    // re-win — it should observe the sentinel already in place and fail.
    expect(await claimGatewaySlot(prisma, order.id)).toBe(false);
  });

  it("commitGatewayResult writes the real JSON payload over the claim sentinel", async () => {
    const order = await makeOrder("PENDING_PAYMENT");
    await claimGatewaySlot(prisma, order.id);

    await commitGatewayResult(prisma, order.id, { gateway: "tokopay", trxId: "T-1" });

    const fresh = await prisma.order.findUnique({ where: { id: order.id } });
    expect(JSON.parse(fresh!.paymentRef!)).toEqual({ gateway: "tokopay", trxId: "T-1" });
  });

  it("releaseGatewaySlot resets paymentRef to null only while the sentinel is present, and never clobbers a committed result", async () => {
    const order = await makeOrder("PENDING_PAYMENT");
    await claimGatewaySlot(prisma, order.id);

    await releaseGatewaySlot(prisma, order.id);
    let fresh = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh!.paymentRef).toBeNull();

    // A claim can be taken again once released (the gateway-failure retry path).
    expect(await claimGatewaySlot(prisma, order.id)).toBe(true);

    // Once a result is committed, the sentinel is gone — a stray/late release
    // call (e.g. from a slow duplicate request) must be a no-op, not erase
    // the real payload.
    await commitGatewayResult(prisma, order.id, { gateway: "tokopay", trxId: "T-2" });
    await releaseGatewaySlot(prisma, order.id);
    fresh = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh!.paymentRef).toBe(JSON.stringify({ gateway: "tokopay", trxId: "T-2" }));
  });

  it("two different orders can each claim concurrently without colliding, even though paymentRef carries a global UNIQUE index", async () => {
    const orderA = await makeOrder("PENDING_PAYMENT");
    const orderB = await makeOrder("PENDING_PAYMENT");

    // The sentinel is derived per-order id, so orderA and orderB write
    // distinct strings into the uniquely-indexed column and both claims
    // succeed — a claim for one order must never false-negative because an
    // unrelated order happened to claim at the same instant.
    const [claimedA, claimedB] = await Promise.all([
      claimGatewaySlot(prisma, orderA.id),
      claimGatewaySlot(prisma, orderB.id),
    ]);
    expect(claimedA).toBe(true);
    expect(claimedB).toBe(true);

    const freshA = await prisma.order.findUnique({ where: { id: orderA.id } });
    const freshB = await prisma.order.findUnique({ where: { id: orderB.id } });
    expect(freshA!.paymentRef).toBe(gatewayClaimSentinel(orderA.id));
    expect(freshB!.paymentRef).toBe(gatewayClaimSentinel(orderB.id));
  });
});

// Money-2 fix (backend audit 2026-07-07): a bulk-pricing discount and a
// voucher discount together could exceed the subtotal, producing a negative
// afterDiscount (and thus a negative walletUsed persisted on the order)
// because the voucher discount was capped against the GROSS subtotal instead
// of subtotal-minus-bulk-discount (createOrderDirect already got this right).
describe("createOrderFromCart bulk+voucher discount cap (Money-2)", () => {
  let sample: SampleData;

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
  });

  it("never produces a negative afterDiscount/walletUsed when bulk + voucher discounts together would exceed the subtotal", async () => {
    const { user, product } = sample;
    // 4 units @ 5.00 = 20.00 subtotal.
    await addToCart(prisma, user.id, product.id, 4);
    // Bulk rule: 4+ units get 50% off -> bulkDiscount = 10.00, net = 10.00.
    await upsertBulkPricing(prisma, { denominationId: product.id, minQuantity: 4, discountPercent: 50 });
    // A 100%-off voucher (no minimum purchase) — capping it against the
    // gross 20.00 subtotal (the bug) would discount another 20.00 on top of
    // the 10.00 bulk discount; capping against the net 10.00 (the fix)
    // discounts only what's left.
    await createVoucher(prisma, { code: "FULL100", type: VoucherType.PERCENT, value: "100" });

    const order = await createOrderFromCart(prisma, { user, voucherCode: "FULL100" });

    expect(new Decimal(order!.bulkDiscountAmount).equals("10.0000")).toBe(true);
    expect(new Decimal(order!.discountAmount).equals("10.0000")).toBe(true); // capped at the NET subtotal, not the gross
    expect(new Decimal(order!.walletUsed).greaterThanOrEqualTo(0)).toBe(true);
    expect(new Decimal(order!.totalAmount).greaterThanOrEqualTo(0)).toBe(true);
  });
});
