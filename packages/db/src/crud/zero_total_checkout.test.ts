/**
 * M11 / audit P0-1, the other half of the minimum-amount work: an order a
 * voucher (or bulk discount) alone reduced to Rp0 must be settled from the
 * shop's own books, never handed to a payment gateway.
 *
 * Before the guard in `finalizeOrderPayment` landed, such an order was quietly
 * sent to whichever rail the buyer had picked, asking it to collect nothing.
 * With the guard in place it would instead be REFUSED — which would leave a
 * fully-discounted order unpayable by any route. `settleFullyDiscountedOrder`
 * is what makes it payable: the same "create, mark paid, settle, deliver" tail
 * `completeOrderWithWalletCredit` already uses, minus the wallet debit there is
 * nothing to make.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { OrderCurrency, OrderStatus, PaymentMethod, StockStatus, VoucherType } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createVoucher } from "./vouchers";
import { createOrderDirect, getOrder } from "./orders";
import { settleFullyDiscountedOrder, orderHasNothingLeftToCollect } from "./wallet_checkout";

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
  sample = await buildSampleData(prisma); // product price "5.00" IDR
  await createVoucher(prisma, { code: "FREE100", type: VoucherType.PERCENT, value: "100", usageLimit: 100 });
});

/** A PENDING_PAYMENT order the 100%-off voucher has already reduced to Rp0 —
 *  exactly what `createOrderDirect` leaves behind before any rail is chosen. */
async function makeFullyDiscountedOrder() {
  const order = await prisma.$transaction((tx) =>
    createOrderDirect(tx, {
     channel: "bot",
      user: { id: sample.user.id, role: sample.user.role },
      productId: sample.product.id,
      quantity: 1,
      voucherCode: "FREE100",
    }),
  );
  // Not `totalAmount.isZero()`: with unique cents on (the default), an order
  // nobody owes anything on still carries its few hundredths of a Rupiah of
  // matching noise until finalize strips them.
  expect(orderHasNothingLeftToCollect(order!)).toBe(true);
  return order!;
}

describe("settleFullyDiscountedOrder", () => {
  it("settles and delivers a Rp0 order without ever stamping a gateway field", async () => {
    const created = await makeFullyDiscountedOrder();

    const result = await prisma.$transaction((tx) => settleFullyDiscountedOrder(tx, created.id));

    expect(result.kind).toBe("delivered");
    expect(result.credentials).toHaveLength(1);
    const order = (await getOrder(prisma, created.id))!;
    expect(order.status).toBe(OrderStatus.DELIVERED);
    expect(order.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(order.currency).toBe(OrderCurrency.IDR);
    expect(new Decimal(order.totalAmount).isZero()).toBe(true);
    expect(new Decimal(order.uniqueCents).isZero()).toBe(true);
    expect(order.paidAt).not.toBeNull();
    // The whole point: no rail was ever asked for anything. No gateway
    // reference, no exchange rate, and the payment window is still the plain
    // creation-time one — never replaced by a rail's own (the USDT branch of
    // finalizeOrderPayment is what would have done that).
    expect(order.paymentRef).toBeNull();
    expect(order.fxRate).toBeNull();
    expect(order.expiresAt?.getTime()).toBe(created.expiresAt?.getTime());

    const sold = await prisma.stockItem.findMany({
      where: { productId: sample.product.id, status: StockStatus.SOLD },
    });
    expect(sold).toHaveLength(1);
  });

  it("moves no money: no wallet debit, no WalletTransaction, balance untouched", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    const created = await makeFullyDiscountedOrder();

    await prisma.$transaction((tx) => settleFullyDiscountedOrder(tx, created.id));

    const after = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(after.walletBalance).equals(new Decimal(before.walletBalance))).toBe(true);
    expect(new Decimal(after.walletBalanceUsdt).equals(new Decimal(before.walletBalanceUsdt))).toBe(true);
    expect(await prisma.walletTransaction.count({ where: { userId: sample.user.id } })).toBe(0);
    const order = (await getOrder(prisma, created.id))!;
    expect(new Decimal(order.walletUsed).isZero()).toBe(true);
  });

  it("refuses an order that still has money owing on it, leaving it untouched", async () => {
    const created = await prisma.$transaction((tx) =>
      createOrderDirect(tx, {
       channel: "bot",
        user: { id: sample.user.id, role: sample.user.role },
        productId: sample.product.id,
        quantity: 1,
      }),
    );
    expect(orderHasNothingLeftToCollect(created!)).toBe(false);

    await expect(
      prisma.$transaction((tx) => settleFullyDiscountedOrder(tx, created!.id)),
    ).rejects.toMatchObject({ key: "error.order_still_owing" });

    const order = (await getOrder(prisma, created!.id))!;
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.paidAt).toBeNull();
  });
});
