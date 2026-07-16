import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { DeliveryType, OrderCurrency, OrderStatus, PaymentMethod, StockStatus } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  adjustWallet,
  getOrder,
  markStockDead,
  addToCart,
  createCategory,
  createCatalogProduct,
  createDenomination,
  updateDenomination,
} from "@app/db";
import { completeOrderWithWalletCredit, completeCartOrderWithWalletCredit } from "./wallet_checkout";

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
});

async function freshUser() {
  return prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
}

describe("completeOrderWithWalletCredit — IDR track", () => {
  it("fully covered by IDR credit: delivers immediately, debits exactly the price, method WALLET", async () => {
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.IDR,
      }),
    );

    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.order.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(result.order.currency).toBe(OrderCurrency.IDR);
    expect(new Decimal(result.order.totalAmount).equals(0)).toBe(true);
    expect(new Decimal(result.order.walletUsed).equals("5.00")).toBe(true);
    expect(result.credentials).toHaveLength(1);

    const after = await freshUser();
    expect(Number(after.walletBalance)).toBeCloseTo(5); // 10 - 5.00

    const sold = await prisma.stockItem.findMany({ where: { productId: sample.product.id, status: StockStatus.SOLD } });
    expect(sold).toHaveLength(1);
  });

  // Per-SKU delivery flows (dlv-task-5): completeOrderWithWallet (the bot
  // handler) reads scratch.customerData and threads it through here — verify
  // it lands on the created order verbatim, same as every other checkout rail.
  it("forwards customerData verbatim onto the created order", async () => {
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    const user = await freshUser();
    const customerData = JSON.stringify([{ game_id: "GID-WALLET" }]);

    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.IDR,
        customerData,
      }),
    );

    expect(result.order.customerData).toBe(customerData);
  });

  it("insufficient IDR balance: throws, makes no wallet or stock change", async () => {
    await adjustWallet(prisma, sample.user.id, "2", { currency: "IDR", reason: "admin_adjust" }); // less than the 5.00 price
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
          productId: sample.product.id,
          quantity: 1,
          currency: OrderCurrency.IDR,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.insufficient_wallet" });

    const after = await freshUser();
    expect(Number(after.walletBalance)).toBeCloseTo(2); // untouched — the transaction rolled back
    const sold = await prisma.stockItem.findMany({ where: { productId: sample.product.id, status: StockStatus.SOLD } });
    expect(sold).toHaveLength(0);
  });

  it("voucher discount + IDR credit combine to reach zero", async () => {
    // SAVE10 = 10% off, minPurchase 3 — product is 5.00, discount 0.50, net 4.50.
    await adjustWallet(prisma, sample.user.id, "4.50", { currency: "IDR", reason: "admin_adjust" });
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        productId: sample.product.id,
        quantity: 1,
        voucherCode: sample.voucher.code,
        currency: OrderCurrency.IDR,
      }),
    );
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(new Decimal(result.order.totalAmount).equals(0)).toBe(true);
    expect(new Decimal(result.order.discountAmount).equals("0.50")).toBe(true);
  });
});

describe("completeOrderWithWalletCredit — USDT track", () => {
  it("fully covered by USDT credit: delivers immediately, debits the converted total, IDR balance untouched", async () => {
    // rate 1 keeps the USDT total numerically equal to the 5.00 central price.
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    await adjustWallet(prisma, sample.user.id, "100", { currency: "IDR", reason: "admin_adjust" });
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalanceUsdt: user.walletBalanceUsdt },
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.USDT,
        rate: 1,
      }),
    );

    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.order.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(result.order.currency).toBe(OrderCurrency.USDT);
    expect(new Decimal(result.order.totalAmount).equals(0)).toBe(true);

    const after = await freshUser();
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(0); // 5 - 5
    expect(Number(after.walletBalance)).toBeCloseTo(100); // IDR untouched
  });

  // Per-SKU delivery flows (dlv-task-5): customerData threading is
  // currency-agnostic in completeOrderWithWalletCredit (no branching around
  // it), but the IDR-track test above is the only one that had verified it —
  // mirror it here for the USDT track so both currencies are covered.
  it("forwards customerData verbatim onto the created order (USDT track)", async () => {
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    const user = await freshUser();
    const customerData = JSON.stringify([{ game_id: "GID-WALLET-USDT" }]);

    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalanceUsdt: user.walletBalanceUsdt },
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.USDT,
        rate: 1,
        customerData,
      }),
    );

    expect(result.order.customerData).toBe(customerData);
  });

  it("insufficient USDT balance: throws, IDR and USDT balances both untouched", async () => {
    await adjustWallet(prisma, sample.user.id, "1", { currency: "USDT", reason: "admin_adjust" }); // less than 5
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalanceUsdt: user.walletBalanceUsdt },
          productId: sample.product.id,
          quantity: 1,
          currency: OrderCurrency.USDT,
          rate: 1,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.insufficient_wallet" });

    const after = await freshUser();
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(1);
  });

  it("out of stock at completion time: throws, wallet untouched", async () => {
    // Mark all 5 seeded stock items dead so none remain available (same
    // technique as order_creation.test.ts's own out-of-stock test).
    const items = await prisma.stockItem.findMany({ where: { productId: sample.product.id } });
    for (const it of items) await markStockDead(prisma, it.id, "test");
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalanceUsdt: user.walletBalanceUsdt },
          productId: sample.product.id,
          quantity: 1,
          currency: OrderCurrency.USDT,
          rate: 1,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.out_of_stock" });

    const after = await freshUser();
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(5);
  });
});

/** A manual (or manual_with_info) denomination with NO stock rows, in its own
 * category/product — mirrors settlePaidOrder.test.ts's makeManualDenom. */
async function makeManualDenom(deliveryType: string = DeliveryType.MANUAL) {
  const category = await createCategory(prisma, `manual-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: `Manual Product ${Math.random()}`,
  });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Manual Denom",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "10.00",
  });
  await updateDenomination(prisma, denom.id, { deliveryType });
  return denom;
}

describe("completeCartOrderWithWalletCredit — IDR track", () => {
  it("fully covered by IDR credit: delivers immediately, debits exactly the price, method WALLET", async () => {
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeCartOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        currency: OrderCurrency.IDR,
      }),
    );

    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.order.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(result.order.currency).toBe(OrderCurrency.IDR);
    expect(new Decimal(result.order.totalAmount).equals(0)).toBe(true);
    expect(new Decimal(result.order.walletUsed).equals("5.00")).toBe(true);
    expect(result.credentials).toHaveLength(1);

    const after = await freshUser();
    expect(Number(after.walletBalance)).toBeCloseTo(5); // 10 - 5.00

    const sold = await prisma.stockItem.findMany({ where: { productId: sample.product.id, status: StockStatus.SOLD } });
    expect(sold).toHaveLength(1);
  });

  it("insufficient IDR balance: throws, makes no wallet or stock change", async () => {
    await adjustWallet(prisma, sample.user.id, "2", { currency: "IDR", reason: "admin_adjust" }); // less than the 5.00 price
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeCartOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
          currency: OrderCurrency.IDR,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.insufficient_wallet" });

    const after = await freshUser();
    expect(Number(after.walletBalance)).toBeCloseTo(2); // untouched — the transaction rolled back
    const sold = await prisma.stockItem.findMany({ where: { productId: sample.product.id, status: StockStatus.SOLD } });
    expect(sold).toHaveLength(0);
    const orders = await prisma.order.findMany({ where: { userId: sample.user.id } });
    expect(orders).toHaveLength(0);
  });

  it("voucher discount + IDR credit combine to reach zero", async () => {
    // SAVE10 = 10% off, minPurchase 3 — product is 5.00, discount 0.50, net 4.50.
    await adjustWallet(prisma, sample.user.id, "4.50", { currency: "IDR", reason: "admin_adjust" });
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeCartOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        voucherCode: sample.voucher.code,
        currency: OrderCurrency.IDR,
      }),
    );
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(new Decimal(result.order.totalAmount).equals(0)).toBe(true);
    expect(new Decimal(result.order.discountAmount).equals("0.50")).toBe(true);
  });

  it("forwards and validates customerData for a manual_with_info cart", async () => {
    const fields = [
      { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
    ];
    const infoDenom = await makeManualDenom(DeliveryType.MANUAL_WITH_INFO);
    await updateDenomination(prisma, infoDenom.id, { additionalFields: JSON.stringify(fields) });
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    await addToCart(prisma, sample.user.id, infoDenom.id, 1);
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeCartOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        currency: OrderCurrency.IDR,
        customerData: [{ game_id: "GID-CART-WALLET" }],
      }),
    );

    expect(result.kind).toBe("processing");
    expect(result.order.customerData).toBe(JSON.stringify([{ game_id: "GID-CART-WALLET" }]));
  });

  it("mixed-delivery-type cart: throws error.cart_mixed_delivery, no order created", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    await adjustWallet(prisma, sample.user.id, "20", { currency: "IDR", reason: "admin_adjust" });
    await addToCart(prisma, sample.user.id, sample.product.id, 1); // AUTO
    await addToCart(prisma, sample.user.id, manualDenom.id, 1); // MANUAL
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeCartOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
          currency: OrderCurrency.IDR,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.cart_mixed_delivery" });

    const orders = await prisma.order.findMany({ where: { userId: sample.user.id } });
    expect(orders).toHaveLength(0);
  });

  it("manual SKU: settles as processing, no credentials, no stock touched", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    await addToCart(prisma, sample.user.id, manualDenom.id, 1);
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeCartOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        currency: OrderCurrency.IDR,
      }),
    );

    expect(result.kind).toBe("processing");
    expect(result.credentials).toEqual([]);
    expect(result.order.status).toBe(OrderStatus.PROCESSING);

    const after = await freshUser();
    expect(Number(after.walletBalance)).toBeCloseTo(0); // 10 - 10.00
  });
});

describe("completeCartOrderWithWalletCredit — USDT track", () => {
  it("fully covered by USDT credit: delivers immediately, IDR balance untouched", async () => {
    // rate 1 keeps the USDT total numerically equal to the 5.00 central price.
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    await adjustWallet(prisma, sample.user.id, "100", { currency: "IDR", reason: "admin_adjust" });
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeCartOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance, walletBalanceUsdt: user.walletBalanceUsdt },
        currency: OrderCurrency.USDT,
        rate: 1,
      }),
    );

    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.order.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(result.order.currency).toBe(OrderCurrency.USDT);
    expect(new Decimal(result.order.totalAmount).equals(0)).toBe(true);

    const after = await freshUser();
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(0); // 5 - 5
    expect(Number(after.walletBalance)).toBeCloseTo(100); // IDR untouched
  });

  it("insufficient USDT balance: throws, both balances untouched", async () => {
    await adjustWallet(prisma, sample.user.id, "1", { currency: "USDT", reason: "admin_adjust" }); // less than 5
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeCartOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalance: user.walletBalance, walletBalanceUsdt: user.walletBalanceUsdt },
          currency: OrderCurrency.USDT,
          rate: 1,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.insufficient_wallet" });

    const after = await freshUser();
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(1);
  });

  it("out of stock at completion time: throws, wallet untouched", async () => {
    const items = await prisma.stockItem.findMany({ where: { productId: sample.product.id } });
    for (const it of items) await markStockDead(prisma, it.id, "test");
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeCartOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalance: user.walletBalance, walletBalanceUsdt: user.walletBalanceUsdt },
          currency: OrderCurrency.USDT,
          rate: 1,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.out_of_stock" });

    const after = await freshUser();
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(5);
  });
});
