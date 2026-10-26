/**
 * Orders priced through volume tiers (crud/bulkTiers.ts quoteBulkForLines):
 * createOrderFromCart and createOrderDirect read the SKU's tiers inside the
 * order transaction, price each line on top of the reseller/flash unit,
 * store `bulkDiscountAmount` + `bulkTierSnapshot`, and never re-derive either
 * from the tiers afterwards. Vouchers stack on top of the tier-reduced subtotal.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  addToCart,
  createDenomination,
  createOrderDirect,
  createOrderFromCart,
  createVoucher,
  finalizeOrderPayment,
  getOrder,
  quoteBulkForLines,
  replaceTiers,
  setFlashSale,
  setTieredPricingEnabled,
  upsertUser,
  DuplicateCheckoutIntentError,
  QuoteMismatchError,
  type BulkTierSnapshot,
} from "@app/db";
import { createRefund, createRefundItem } from "./refunds";
import { OrderCurrency, UserRole, VoucherType } from "@app/core/enums";
import { Decimal } from "@app/core/money";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let actor: { adminId: number };

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
  actor = { adminId: sample.user.id };
});

/** A manual-delivery SKU (no stock to reserve) at `price`, reseller price optional. */
async function sku(price: string, resellerPrice?: string) {
  return createDenomination(prisma, {
    productId: sample.parentProduct.id,
    name: `Tiered ${price} ${randomUUID().slice(0, 6)}`,
    type: "SHARED",
    durationLabel: "1 Month",
    price,
    resellerPrice,
    deliveryType: "manual",
  });
}

/** 10000 base; 10% off at 2; fixed 8000 at 3; fixed 6000 at 5. */
async function tieredSku(price = "10000", resellerPrice?: string) {
  const d = await sku(price, resellerPrice);
  await replaceTiers(
    prisma,
    d.id,
    [
      { minQuantity: 2, discountType: "PERCENTAGE", discountValue: "10" },
      { minQuantity: 3, discountType: "FIXED_UNIT_PRICE", discountValue: "8000" },
      { minQuantity: 5, discountType: "FIXED_UNIT_PRICE", discountValue: "6000" },
    ],
    actor,
  );
  await setTieredPricingEnabled(prisma, d.id, true, actor);
  return d;
}

async function buyer(telegramId: number, role: string = UserRole.CUSTOMER) {
  const u = await upsertUser(prisma, { telegramId, username: `b${telegramId}`, fullName: `Buyer ${telegramId}` });
  if (role !== UserRole.CUSTOMER) return prisma.user.update({ where: { id: u.id }, data: { role } });
  return u;
}

const EXPECTED = [
  { quantity: 1, subtotal: "10000", bulk: "0", total: "10000", tierMin: null },
  { quantity: 2, subtotal: "20000", bulk: "2000", total: "18000", tierMin: 2 },
  { quantity: 3, subtotal: "30000", bulk: "6000", total: "24000", tierMin: 3 },
  { quantity: 4, subtotal: "40000", bulk: "8000", total: "32000", tierMin: 3 },
  { quantity: 5, subtotal: "50000", bulk: "20000", total: "30000", tierMin: 5 },
  { quantity: 6, subtotal: "60000", bulk: "24000", total: "36000", tierMin: 5 },
];

describe("createOrderDirect with three tiers", () => {
  it.each(EXPECTED)("qty $quantity: subtotal $subtotal, bulk $bulk, charged $total", async (row) => {
    const d = await tieredSku();
    const user = await buyer(5000 + row.quantity);
    const created = await createOrderDirect(prisma, { channel: "bot", user, productId: d.id, quantity: row.quantity });
    const paid = (await finalizeOrderPayment(prisma, created!.id, { currency: OrderCurrency.IDR }))!;

    expect(new Decimal(paid.subtotalAmount).equals(row.subtotal)).toBe(true);
    expect(new Decimal(paid.bulkDiscountAmount).equals(row.bulk)).toBe(true);
    expect(new Decimal(paid.discountAmount).equals(0)).toBe(true);
    // The invoice total is exactly subtotal − bulk (IDR finalization drops the unique cents).
    expect(new Decimal(paid.totalAmount).equals(row.total)).toBe(true);
    expect(paid.items).toHaveLength(row.quantity);
    // OrderItem.unitPrice stays the pre-tier unit; the tier lives on the order.
    expect(paid.items.every((i) => new Decimal(i.unitPrice).equals("10000"))).toBe(true);

    const snapshot = paid.bulkTierSnapshot as unknown as BulkTierSnapshot | null;
    if (row.tierMin === null) {
      expect(snapshot).toBeNull();
    } else {
      expect(snapshot!.version).toBe(1);
      expect(snapshot!.lines).toHaveLength(1);
      expect(snapshot!.lines[0]).toMatchObject({
        denominationId: d.id,
        quantity: row.quantity,
        minQuantity: row.tierMin,
        baseUnitPrice: "10000",
        totalDiscount: row.bulk,
      });
      expect(typeof snapshot!.lines[0]!.tierId).toBe("string");
      expect(new Decimal(snapshot!.lines[0]!.finalUnitPrice).times(row.quantity).equals(row.total)).toBe(true);
    }
  });

  it("the snapshot records type and value of the applied tier", async () => {
    const d = await tieredSku();
    const user = await buyer(6001);
    const created = await createOrderDirect(prisma, { channel: "bot", user, productId: d.id, quantity: 5 });
    const snapshot = (await getOrder(prisma, created!.id))!.bulkTierSnapshot as unknown as BulkTierSnapshot;
    expect(snapshot.lines[0]).toMatchObject({
      discountType: "FIXED_UNIT_PRICE",
      discountValue: "6000",
      finalUnitPrice: "6000",
      totalDiscount: "20000",
    });
  });

  it("tiers with tiered pricing switched off do not discount the order", async () => {
    const d = await tieredSku();
    await setTieredPricingEnabled(prisma, d.id, false, actor);
    const user = await buyer(6002);
    const created = await createOrderDirect(prisma, { channel: "bot", user, productId: d.id, quantity: 5 });
    const order = (await getOrder(prisma, created!.id))!;
    expect(new Decimal(order.bulkDiscountAmount).equals(0)).toBe(true);
    expect(order.bulkTierSnapshot).toBeNull();
  });
});

describe("createOrderFromCart with tiers", () => {
  it("prices each cart line through its own tiers and sums the discount; the snapshot has every line", async () => {
    const tiered = await tieredSku();
    const plain = await sku("7000");
    const user = await buyer(7001);
    await addToCart(prisma, user.id, tiered.id, 4);
    await addToCart(prisma, user.id, plain.id, 2);

    const created = await createOrderFromCart(prisma, { channel: "web", user });
    const paid = (await finalizeOrderPayment(prisma, created!.id, { currency: OrderCurrency.IDR }))!;

    expect(new Decimal(paid.subtotalAmount).equals("54000")).toBe(true);
    expect(new Decimal(paid.bulkDiscountAmount).equals("8000")).toBe(true);
    expect(new Decimal(paid.totalAmount).equals("46000")).toBe(true);

    const snapshot = paid.bulkTierSnapshot as unknown as BulkTierSnapshot;
    expect(snapshot.version).toBe(1);
    const byDenom = new Map(snapshot.lines.map((l) => [l.denominationId, l]));
    expect(byDenom.get(tiered.id)).toMatchObject({ quantity: 4, minQuantity: 3, totalDiscount: "8000", finalUnitPrice: "8000" });
    expect(byDenom.get(plain.id)).toMatchObject({ quantity: 2, tierId: null, minQuantity: null, totalDiscount: "0" });
  });

  it("the cart preview quote equals what the order charges", async () => {
    const d = await tieredSku();
    const user = await buyer(7002);
    await addToCart(prisma, user.id, d.id, 6);
    const denomination = await prisma.denomination.findUniqueOrThrow({ where: { id: d.id } });
    const quote = await quoteBulkForLines(prisma, [{ denominationId: d.id, quantity: 6, denomination }], false, new Date());

    const created = await createOrderFromCart(prisma, { channel: "web", user });
    const order = (await getOrder(prisma, created!.id))!;
    expect(new Decimal(order.subtotalAmount).equals(quote.subtotal)).toBe(true);
    expect(new Decimal(order.bulkDiscountAmount).equals(quote.bulkDiscount)).toBe(true);
    expect(order.bulkTierSnapshot).toEqual(quote.snapshot);
  });
});

describe("historical orders never change", () => {
  it("editing or disabling the tiers after checkout leaves the stored order and its snapshot untouched", async () => {
    const d = await tieredSku();
    const user = await buyer(8001);
    const created = await createOrderDirect(prisma, { channel: "bot", user, productId: d.id, quantity: 5 });
    const before = (await getOrder(prisma, created!.id))!;

    await replaceTiers(prisma, d.id, [{ minQuantity: 2, discountType: "PERCENTAGE", discountValue: "50" }], actor);
    await setTieredPricingEnabled(prisma, d.id, false, actor);

    const after = (await getOrder(prisma, created!.id))!;
    expect(after.subtotalAmount.toString()).toBe(before.subtotalAmount.toString());
    expect(after.bulkDiscountAmount.toString()).toBe(before.bulkDiscountAmount.toString());
    expect(after.totalAmount.toString()).toBe(before.totalAmount.toString());
    expect(after.bulkTierSnapshot).toEqual(before.bulkTierSnapshot);
    // And it still finalizes at the price it was created with.
    const paid = (await finalizeOrderPayment(prisma, created!.id, { currency: OrderCurrency.IDR }))!;
    expect(new Decimal(paid.totalAmount).equals("30000")).toBe(true);
  });
});

describe("stacking", () => {
  it("a voucher applies after the tier, on subtotal − bulk", async () => {
    const d = await tieredSku();
    await createVoucher(prisma, { code: "TIER10", type: VoucherType.PERCENT, value: "10", usageLimit: 10, minPurchase: "0" });
    const user = await buyer(9001);
    const created = await createOrderDirect(prisma, { channel: "bot", user, productId: d.id, quantity: 5, voucherCode: "TIER10" });
    const paid = (await finalizeOrderPayment(prisma, created!.id, { currency: OrderCurrency.IDR }))!;
    expect(new Decimal(paid.bulkDiscountAmount).equals("20000")).toBe(true);
    expect(new Decimal(paid.discountAmount).equals("3000")).toBe(true); // 10% of 30000, not of 50000
    expect(new Decimal(paid.totalAmount).equals("27000")).toBe(true);
  });

  it("a voucher stacks on the tier in the cart path too", async () => {
    const d = await tieredSku();
    await createVoucher(prisma, { code: "FLAT1K", type: VoucherType.FIXED, value: "1000", usageLimit: 10, minPurchase: "0" });
    const user = await buyer(9002);
    await addToCart(prisma, user.id, d.id, 3);
    const created = await createOrderFromCart(prisma, { channel: "web", user, voucherCode: "FLAT1K" });
    const paid = (await finalizeOrderPayment(prisma, created!.id, { currency: OrderCurrency.IDR }))!;
    expect(new Decimal(paid.bulkDiscountAmount).equals("6000")).toBe(true);
    expect(new Decimal(paid.discountAmount).equals("1000")).toBe(true);
    expect(new Decimal(paid.totalAmount).equals("23000")).toBe(true);
  });

  it("a reseller's tier is computed on the reseller unit; a fixed price above it never raises the price", async () => {
    const d = await sku("10000", "9000");
    await replaceTiers(
      prisma,
      d.id,
      [
        { minQuantity: 2, discountType: "PERCENTAGE", discountValue: "10" },
        { minQuantity: 3, discountType: "FIXED_UNIT_PRICE", discountValue: "9500" },
      ],
      actor,
    );
    await setTieredPricingEnabled(prisma, d.id, true, actor);
    const reseller = await buyer(9003, UserRole.RESELLER);

    const two = await createOrderDirect(prisma, { channel: "bot", user: reseller, productId: d.id, quantity: 2 });
    const twoRow = (await getOrder(prisma, two!.id))!;
    expect(new Decimal(twoRow.subtotalAmount).equals("18000")).toBe(true);
    expect(new Decimal(twoRow.bulkDiscountAmount).equals("1800")).toBe(true);

    const three = await createOrderDirect(prisma, { channel: "bot", user: reseller, productId: d.id, quantity: 3 });
    const threeRow = (await getOrder(prisma, three!.id))!;
    expect(new Decimal(threeRow.subtotalAmount).equals("27000")).toBe(true);
    expect(new Decimal(threeRow.bulkDiscountAmount).equals("0")).toBe(true); // 9500 > 9000 reseller unit
  });

  it("a flash sale lowers the unit first, then the tier applies on top", async () => {
    const d = await tieredSku();
    await setFlashSale(prisma, {
      denominationId: d.id,
      discountPercent: "20",
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000),
    });
    const user = await buyer(9004);
    const two = await createOrderDirect(prisma, { channel: "bot", user, productId: d.id, quantity: 2 });
    const twoRow = (await getOrder(prisma, two!.id))!;
    expect(new Decimal(twoRow.subtotalAmount).equals("16000")).toBe(true); // 2 × 8000 flash unit
    expect(new Decimal(twoRow.bulkDiscountAmount).equals("1600")).toBe(true); // 10% of the flash subtotal

    // Fixed 8000 at qty 3 equals the 8000 flash unit: no discount, never a raise.
    const three = await createOrderDirect(prisma, { channel: "bot", user, productId: d.id, quantity: 3 });
    const threeRow = (await getOrder(prisma, three!.id))!;
    expect(new Decimal(threeRow.bulkDiscountAmount).equals("0")).toBe(true);
    expect(new Decimal(threeRow.subtotalAmount).equals("24000")).toBe(true);
  });
});

describe("races and stale quotes", () => {
  it("two concurrent createOrderDirect calls with the same checkoutIntentId create exactly one tiered order", async () => {
    const d = await tieredSku();
    const [a, b] = [await buyer(9101), await buyer(9102)];
    const checkoutIntentId = randomUUID();
    const results = await Promise.allSettled(
      [a, b].map((user) =>
        prisma.$transaction((tx) =>
          createOrderDirect(tx, { channel: "bot", user, productId: d.id, quantity: 5, checkoutIntentId }),
        ),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(DuplicateCheckoutIntentError);
    const orders = await prisma.order.findMany({ where: { checkoutIntentId } });
    expect(orders).toHaveLength(1);
    expect(new Decimal(orders[0]!.bulkDiscountAmount).equals("20000")).toBe(true);
  });

  it("a tier edited between the preview and the order is caught by the quoted total", async () => {
    const d = await tieredSku();
    const user = await buyer(9201);
    const denomination = await prisma.denomination.findUniqueOrThrow({ where: { id: d.id } });
    const quote = await quoteBulkForLines(prisma, [{ denominationId: d.id, quantity: 5, denomination }], false, new Date());
    const quotedTotal = quote.subtotal.minus(quote.bulkDiscount);
    expect(quotedTotal.equals("30000")).toBe(true);

    await replaceTiers(prisma, d.id, [{ minQuantity: 5, discountType: "FIXED_UNIT_PRICE", discountValue: "7000" }], actor);

    await expect(
      createOrderDirect(prisma, {
        channel: "bot",
        user,
        productId: d.id,
        quantity: 5,
        expectedTotal: { currency: OrderCurrency.IDR, amount: quotedTotal },
      }),
    ).rejects.toBeInstanceOf(QuoteMismatchError);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);

    // The cart path refuses the same way.
    await addToCart(prisma, user.id, d.id, 5);
    await expect(
      createOrderFromCart(prisma, {
        channel: "web",
        user,
        expectedTotal: { currency: OrderCurrency.IDR, amount: quotedTotal },
      }),
    ).rejects.toBeInstanceOf(QuoteMismatchError);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("refund budget of a tier-discounted unit", () => {
  it("a unit is refundable for what the buyer paid for it after the tier, not its pre-tier unit price", async () => {
    const d = await tieredSku();
    const user = await buyer(9301);
    const created = await createOrderDirect(prisma, { channel: "bot", user, productId: d.id, quantity: 5 });
    await finalizeOrderPayment(prisma, created!.id, { currency: OrderCurrency.IDR }); // charged 30000 for 5 units
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: created!.id } });

    const refund = await createRefund(prisma, { orderId: created!.id, amount: "10000", currency: "IDR", adminId: actor.adminId });
    // 10000 is the unit's pre-tier price; the snapshot's line discount
    // (20000 over 5 units) means the buyer paid 6000 for it.
    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "10000", adminId: actor.adminId }),
    ).rejects.toMatchObject({ key: "error.refund_exceeds_item_subtotal" });
    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "6000.01", adminId: actor.adminId }),
    ).rejects.toMatchObject({ key: "error.refund_exceeds_item_subtotal" });
    const row = await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "6000", adminId: actor.adminId });
    expect(row.amount.toString()).toBe("6000");
  });

  it("in a mixed cart only the tiered line's units carry the tier discount; the untiered line keeps its full price", async () => {
    // A: 5 × 10000 with 40% off at 5 (20000 off); B: 1 × 50000, no tiers.
    const a = await sku("10000");
    await replaceTiers(prisma, a.id, [{ minQuantity: 5, discountType: "PERCENTAGE", discountValue: "40" }], actor);
    await setTieredPricingEnabled(prisma, a.id, true, actor);
    const b = await sku("50000");
    const user = await buyer(9303);
    await addToCart(prisma, user.id, a.id, 5);
    await addToCart(prisma, user.id, b.id, 1);
    const created = await createOrderFromCart(prisma, { channel: "web", user });
    const paid = (await finalizeOrderPayment(prisma, created!.id, { currency: OrderCurrency.IDR }))!;
    expect(new Decimal(paid.bulkDiscountAmount).equals("20000")).toBe(true);
    expect(new Decimal(paid.totalAmount).equals("80000")).toBe(true);

    const itemB = await prisma.orderItem.findFirstOrThrow({ where: { orderId: created!.id, productId: b.id } });
    const itemsA = await prisma.orderItem.findMany({ where: { orderId: created!.id, productId: a.id } });
    expect(itemsA).toHaveLength(5);

    const refund = await createRefund(prisma, { orderId: created!.id, amount: "80000", currency: "IDR", adminId: actor.adminId });
    // B was never discounted: its whole 50000 is refundable.
    const rowB = await createRefundItem(prisma, { refundId: refund.id, orderItemId: itemB.id, amount: "50000", adminId: actor.adminId });
    expect(rowB.amount.toString()).toBe("50000");
    // Each A unit cost 6000 after the tier (30000 / 5).
    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: itemsA[0]!.id, amount: "6000.01", adminId: actor.adminId }),
    ).rejects.toMatchObject({ key: "error.refund_exceeds_item_subtotal" });
    for (const item of itemsA) {
      const row = await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "6000", adminId: actor.adminId });
      expect(row.amount.toString()).toBe("6000");
    }
  });

  it("a historical order with a bulk discount but no tier snapshot keeps its gross unit budget (no retroactive proration)", async () => {
    const d = await sku("10000");
    const user = await buyer(9304);
    const created = await createOrderDirect(prisma, { channel: "bot", user, productId: d.id, quantity: 2 });
    await finalizeOrderPayment(prisma, created!.id, { currency: OrderCurrency.IDR });
    // A pre-tier order: the legacy single rule stored only bulkDiscountAmount.
    await prisma.order.update({ where: { id: created!.id }, data: { bulkDiscountAmount: "2000", totalAmount: "18000" } });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: created!.id } });
    const refund = await createRefund(prisma, { orderId: created!.id, amount: "10000", currency: "IDR", adminId: actor.adminId });
    const row = await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "10000", adminId: actor.adminId });
    expect(row.amount.toString()).toBe("10000");
  });

  it("an order without a bulk discount keeps the full unit price as its budget", async () => {
    const d = await sku("10000");
    const user = await buyer(9302);
    const created = await createOrderDirect(prisma, { channel: "bot", user, productId: d.id, quantity: 1 });
    await finalizeOrderPayment(prisma, created!.id, { currency: OrderCurrency.IDR });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: created!.id } });
    const refund = await createRefund(prisma, { orderId: created!.id, amount: "10000", currency: "IDR", adminId: actor.adminId });
    const row = await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "10000", adminId: actor.adminId });
    expect(row.amount.toString()).toBe("10000");
  });
});
