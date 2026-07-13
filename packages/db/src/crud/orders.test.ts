import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  countPendingPaymentLike,
  countProcessing,
  countAwaitingManualFulfillment,
  countPendingVerifications,
  countUnderpaid,
  countExpiredPending,
  claimGatewaySlot,
  commitGatewayResult,
  releaseGatewaySlot,
  gatewayClaimSentinel,
  createOrderFromCart,
  rejectOrder,
  getOrder,
} from "./orders";
import { addToCart, upsertBulkPricing, createVoucher } from "@app/db";
import { VoucherType } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import { createCategory, createCatalogProduct, createDenomination, updateDenomination } from "./catalog";

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
  // OrderItem/OrderStatusHistory.order and WalletTransaction.user are all
  // onDelete:Restrict — clear them before Order/User, same dependency order
  // as tests/helpers/sampleData.ts's resetDb, or a row left over from a prior
  // describe block's own test (e.g. createOrderFromCart's real OrderItems, or
  // rejectOrder's walletUsed refund writing a WalletTransaction) blocks these
  // deleteManys.
  await prisma.orderItem.deleteMany();
  await prisma.orderStatusHistory.deleteMany();
  await prisma.walletTransaction.deleteMany();
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

  // Deliberately a DIFFERENT status set than countProcessing above — that
  // function is the pre-existing, unrelated "payment-gateway in-flight"
  // metric (CONFIRMED/PAID). countAwaitingManualFulfillment counts the new
  // manual-fulfilment queue (status PROCESSING) and must never be confused
  // with it.
  it("countAwaitingManualFulfillment counts PROCESSING orders only, distinct from countProcessing's CONFIRMED/PAID", async () => {
    await makeOrder("PROCESSING");
    await makeOrder("PROCESSING");
    await makeOrder("CONFIRMED");
    await makeOrder("PAID");
    await makeOrder("DELIVERED");
    expect(await countAwaitingManualFulfillment(prisma)).toBe(2);
    expect(await countProcessing(prisma)).toBe(2); // CONFIRMED + PAID, unaffected
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

    const sentinel = await claimGatewaySlot(prisma, order.id);
    expect(sentinel).toEqual(expect.any(String));
    const claimed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(claimed!.paymentRef).toBe(sentinel);

    // A second claim (a concurrent request, or a fresh — not stale — retry)
    // must not re-win — it should observe the sentinel already in place and
    // fail.
    expect(await claimGatewaySlot(prisma, order.id)).toBeNull();
  });

  it("commitGatewayResult writes the real JSON payload over the claim sentinel", async () => {
    const order = await makeOrder("PENDING_PAYMENT");
    const sentinel = await claimGatewaySlot(prisma, order.id);

    expect(await commitGatewayResult(prisma, order.id, sentinel!, { gateway: "tokopay", trxId: "T-1" })).toBe(true);

    const fresh = await prisma.order.findUnique({ where: { id: order.id } });
    expect(JSON.parse(fresh!.paymentRef!)).toEqual({ gateway: "tokopay", trxId: "T-1" });
  });

  it("commitGatewayResult is a no-op (and returns false) if paymentRef is no longer this claim's sentinel", async () => {
    const order = await makeOrder("PENDING_PAYMENT");
    const sentinel = await claimGatewaySlot(prisma, order.id);
    // Simulate the order moving on (e.g. cancelled) mid-gateway-call.
    await prisma.order.update({ where: { id: order.id }, data: { paymentRef: null } });

    expect(await commitGatewayResult(prisma, order.id, sentinel!, { gateway: "tokopay", trxId: "T-stale" })).toBe(false);
    const fresh = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh!.paymentRef).toBeNull();
  });

  it("releaseGatewaySlot resets paymentRef to null only while the sentinel is present, and never clobbers a committed result", async () => {
    const order = await makeOrder("PENDING_PAYMENT");
    const sentinel1 = await claimGatewaySlot(prisma, order.id);

    await releaseGatewaySlot(prisma, order.id, sentinel1!);
    let fresh = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh!.paymentRef).toBeNull();

    // A claim can be taken again once released (the gateway-failure retry path).
    const sentinel2 = await claimGatewaySlot(prisma, order.id);
    expect(sentinel2).toEqual(expect.any(String));

    // Once a result is committed, the sentinel is gone — a stray/late release
    // call (e.g. from a slow duplicate request) must be a no-op, not erase
    // the real payload.
    await commitGatewayResult(prisma, order.id, sentinel2!, { gateway: "tokopay", trxId: "T-2" });
    await releaseGatewaySlot(prisma, order.id, sentinel2!);
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
    expect(claimedA).toEqual(expect.any(String));
    expect(claimedB).toEqual(expect.any(String));

    const freshA = await prisma.order.findUnique({ where: { id: orderA.id } });
    const freshB = await prisma.order.findUnique({ where: { id: orderB.id } });
    expect(freshA!.paymentRef).toBe(claimedA);
    expect(freshB!.paymentRef).toBe(claimedB);
  });

  // Backend audit 2026-07-07 final-review fix: a mid-claim crash (process
  // dies between claimGatewaySlot succeeding and commit/release running)
  // used to wedge paymentRef at the sentinel forever, since claimGatewaySlot
  // only matched `paymentRef: null`. The sentinel now embeds a timestamp so a
  // stuck claim older than the TTL can be reclaimed.
  describe("stale-sentinel reclaim after a simulated crash", () => {
    it("a sentinel older than the TTL is reclaimable by a later claimGatewaySlot call", async () => {
      const order = await makeOrder("PENDING_PAYMENT");
      // Simulate a crash: write a sentinel whose embedded timestamp is well
      // past the reclaim TTL, as if claimGatewaySlot had won the claim long
      // ago and the process died before commit/release ran.
      const staleSentinel = gatewayClaimSentinel(order.id, Date.now() - 60_000);
      await prisma.order.update({ where: { id: order.id }, data: { paymentRef: staleSentinel } });

      const reclaimed = await claimGatewaySlot(prisma, order.id);
      expect(reclaimed).toEqual(expect.any(String));
      expect(reclaimed).not.toBe(staleSentinel);

      const fresh = await prisma.order.findUnique({ where: { id: order.id } });
      expect(fresh!.paymentRef).toBe(reclaimed);
    });

    it("a fresh sentinel (within the TTL) is NOT reclaimable — still returns null, matching an in-flight claim", async () => {
      const order = await makeOrder("PENDING_PAYMENT");
      const freshSentinel = gatewayClaimSentinel(order.id, Date.now() - 1_000);
      await prisma.order.update({ where: { id: order.id }, data: { paymentRef: freshSentinel } });

      expect(await claimGatewaySlot(prisma, order.id)).toBeNull();

      const fresh = await prisma.order.findUnique({ where: { id: order.id } });
      expect(fresh!.paymentRef).toBe(freshSentinel);
    });

    it("a stale sentinel belonging to a DIFFERENT order is never mistaken for this order's own stale claim", async () => {
      const orderA = await makeOrder("PENDING_PAYMENT");
      const orderB = await makeOrder("PENDING_PAYMENT");
      // orderB somehow ended up holding a paymentRef shaped like orderA's
      // sentinel prefix followed by orderB's own id — must not be treated as
      // orderA's stale claim (it isn't — the embedded order id differs).
      const staleForA = gatewayClaimSentinel(orderA.id, Date.now() - 60_000);
      await prisma.order.update({ where: { id: orderB.id }, data: { paymentRef: staleForA } });

      // orderB's own claim attempt must go through the null-claim path and
      // fail, since its paymentRef isn't null and isn't ITS OWN sentinel.
      expect(await claimGatewaySlot(prisma, orderB.id)).toBeNull();
    });
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

// Finding #2 (audit-per-sku-delivery-flows-2026-07-13.md): rejectOrder's
// status guard only accepted PENDING_VERIFICATION, even though
// orderStatus.ts's LEGAL_TRANSITIONS already declares PROCESSING -> REJECTED
// legal — leaving a paid-but-unfulfillable manual order (PROCESSING, no
// stock ever reserved) with no way to refund/reject it short of direct DB
// manipulation.
describe("rejectOrder — PROCESSING support (Finding #2)", () => {
  // One test below creates a real OrderItem (Restrict onDelete against Order)
  // to exercise releaseOrderHolds's stock-release loop — clean it up so the
  // outer beforeEach's prisma.order.deleteMany() doesn't hit a FK violation
  // on the next test.
  afterEach(async () => {
    await prisma.orderItem.deleteMany();
  });

  it("still rejects a PENDING_VERIFICATION order (pre-existing behavior unchanged)", async () => {
    const order = await makeOrder("PENDING_VERIFICATION");
    const rejected = await rejectOrder(prisma, order.id, { adminId: 1, reason: "bad proof" });
    expect(rejected!.status).toBe("REJECTED");
    expect(rejected!.rejectionReason).toBe("bad proof");
  });

  it("now also rejects a PROCESSING order (paid manual SKU an admin can't source)", async () => {
    const order = await makeOrder("PROCESSING");
    const rejected = await rejectOrder(prisma, order.id, { adminId: 1, reason: "out of stock" });
    expect(rejected!.status).toBe("REJECTED");
    expect(rejected!.rejectionReason).toBe("out of stock");
  });

  it("a PROCESSING order with a real manual-SKU line item (stockItemId null) rejects without touching any stock row", async () => {
    // A PROCESSING order never reserves a stockItem (fulfillManualOrder:
    // "No stock is touched") — releaseOrderHolds's stock-release loop must
    // naturally no-op (only acts on item.stockItem && status RESERVED) rather
    // than error on a manual line item that never had one.
    const category = await createCategory(prisma, `Cat${Math.random()}`);
    const catalogProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "Manual Product" });
    const denom = await createDenomination(prisma, {
      productId: catalogProduct.id,
      name: "Manual Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "5.00",
      deliveryType: "manual",
    });
    const order = await makeOrder("PROCESSING");
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: denom.id, quantity: 1, unitPrice: "5.00", warrantyDaysSnapshot: 30 },
    });
    await expect(
      rejectOrder(prisma, order.id, { adminId: 1, reason: "no stock to send" }),
    ).resolves.toMatchObject({ status: "REJECTED" });
  });

  it("refunds walletUsed back to the buyer's balance on a PROCESSING reject, same as PENDING_VERIFICATION", async () => {
    const order = await makeOrder("PROCESSING", { walletUsed: "3.00", currency: "IDR" });
    const before = (await prisma.user.findUnique({ where: { id: userId } }))!;
    await rejectOrder(prisma, order.id, { adminId: 1, reason: "unfulfillable" });
    const after = (await prisma.user.findUnique({ where: { id: userId } }))!;
    expect(new Decimal(after.walletBalance).minus(new Decimal(before.walletBalance)).toString()).toBe("3");
  });

  it("still refuses a terminal/other status (e.g. DELIVERED) with the same error as before", async () => {
    const order = await makeOrder("DELIVERED");
    await expect(rejectOrder(prisma, order.id, { adminId: 1, reason: "x" })).rejects.toThrow(ValidationError);
    await expect((await getOrder(prisma, order.id))!.status).toBe("DELIVERED");
  });
});

// Finding #5 (audit-per-sku-delivery-flows-2026-07-13.md): performCheckout's
// homogeneity/customerData guards already filter cart lines by
// product.isActive, but createOrderFromCart itself read the cart via the
// UNFILTERED getCart — an admin deactivating a denomination between
// add-to-cart and checkout could slip an inactive line past both guards and
// still have it turned into an order line. createOrderFromCart now filters
// isActive itself, so this is closed regardless of what the caller does.
describe("createOrderFromCart — isActive filtering (Finding #5)", () => {
  let sample: SampleData;

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
  });

  it("throws error.cart_empty when the only cart line's product was deactivated after being added", async () => {
    const { user, product } = sample;
    await addToCart(prisma, user.id, product.id, 1);
    await updateDenomination(prisma, product.id, { isActive: false });

    await expect(createOrderFromCart(prisma, { user })).rejects.toMatchObject({ key: "error.cart_empty" });
  });

  it("drops a deactivated line but still creates the order from the remaining active line", async () => {
    const { user, product } = sample;
    const category = await createCategory(prisma, `cat-${Math.random()}`);
    const catalogProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "Other Product" });
    const otherDenom = await createDenomination(prisma, {
      productId: catalogProduct.id,
      name: "Other Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "3.00",
    });
    await addToCart(prisma, user.id, product.id, 1);
    await addToCart(prisma, user.id, otherDenom.id, 1);
    // Deactivated AFTER being added to cart — the mid-checkout-deactivation
    // scenario Finding #5 describes.
    await updateDenomination(prisma, otherDenom.id, { isActive: false });

    const order = await createOrderFromCart(prisma, { user });
    const items = await prisma.orderItem.findMany({ where: { orderId: order!.id } });
    expect(items.map((i) => i.productId)).toEqual([product.id]);
  });
});

// Finding #4 (audit-per-sku-delivery-flows-2026-07-13.md): the storefront's
// performCheckout already re-validates manual_with_info customerData before
// calling createOrderFromCart, but createOrderFromCart itself trusted
// whatever string the caller passed. Re-validating INSIDE createOrderFromCart
// too closes the gap for any caller that skips (or gets ahead of)
// performCheckout's own check — defense in depth, not a behavior change for
// already-valid data.
describe("createOrderFromCart — manual_with_info customerData re-validation (Finding #4)", () => {
  let sample: SampleData;

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
  });

  it("throws error.customer_data_incomplete when the cart's manual_with_info line's customerData doesn't match its quantity", async () => {
    const { user } = sample;
    const category = await createCategory(prisma, `cat-${Math.random()}`);
    const catalogProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "Info Product" });
    const fields = [
      { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
    ];
    const infoDenom = await createDenomination(prisma, {
      productId: catalogProduct.id,
      name: "Info Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "5.00",
      deliveryType: "manual_with_info",
      additionalFields: JSON.stringify(fields),
    });
    // 2 units in the cart, but only 1 unit's worth of answers — a stale/
    // mismatched customerData a buggy or malicious caller might pass.
    await addToCart(prisma, user.id, infoDenom.id, 2);
    const staleCustomerData = JSON.stringify([{ game_id: "12345" }]);

    let caught: unknown;
    try {
      await createOrderFromCart(prisma, { user, customerData: staleCustomerData });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).key).toBe("error.customer_data_incomplete");

    const orders = await prisma.order.findMany({ where: { userId: user.id } });
    expect(orders).toHaveLength(0);
  });

  it("persists customerData that matches the line's field spec/quantity, unchanged", async () => {
    const { user } = sample;
    const category = await createCategory(prisma, `cat-${Math.random()}`);
    const catalogProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "Info Product 2" });
    const fields = [
      { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
    ];
    const infoDenom = await createDenomination(prisma, {
      productId: catalogProduct.id,
      name: "Info Denom 2",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "5.00",
      deliveryType: "manual_with_info",
      additionalFields: JSON.stringify(fields),
    });
    await addToCart(prisma, user.id, infoDenom.id, 1);
    const customerData = JSON.stringify([{ game_id: "12345" }]);

    const order = await createOrderFromCart(prisma, { user, customerData });
    expect(order!.customerData).toBe(customerData);
  });
});
