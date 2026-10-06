// The storefront checkouts that settle an order without any gateway — wallet
// credit (cart and direct) and a voucher that covers the whole price (cart and
// direct) — start the instant Digiflazz dispatch once the order is paid, so a
// Digiflazz top-up does not wait for the 5-second recovery cron. The payment
// webhooks have their own tests in tokopay-/paydisini-/nowpayments-webhook.test.ts.
//
// The perform* functions are called directly: the HTTP layer around them
// (auth, CSRF, rate limits) is covered by topup-order-api.test.ts and
// spa-api.test.ts and has nothing to do with when the dispatch starts.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  setSetting,
  createCatalogProduct,
  createDenomination,
  createVoucher,
  addToCart,
  clearCart,
  triggerDigiflazzDispatch,
} from "@app/db";
import { OrderCurrency, OrderStatus, VoucherType } from "@app/core/enums";
import {
  DIGIFLAZZ_CUSTOMER_DATA_RAW,
  routeDenominationToDigiflazz,
} from "../../../tests/helpers/digiflazzRouting";
import type { Customer } from "../src/plugins/auth";
import {
  performCheckout,
  performDirectCheckout,
  performDirectWalletCheckout,
  performWalletCheckout,
} from "../src/routes/checkout";

// Observed, not run: these tests check that the dispatch is started, not what
// Digiflazz answers.
vi.mock("@app/db", async (orig) => ({
  ...(await orig<typeof import("@app/db")>()),
  triggerDigiflazzDispatch: vi.fn(),
}));

const PRICE = "40000";
let digiflazzDenomId: number;
let stockDenomId: number;
let userCounter = 0;

/** A fresh signed-in buyer with enough IDR credit for one order. */
async function buyer(): Promise<Customer> {
  userCounter += 1;
  const user = await prisma.user.create({
    data: { referralCode: `DFTRIG${userCounter}`, walletBalance: "100000" },
  });
  return { userId: user.id, user } as unknown as Customer;
}

const orderOf = (orderCode: string) => prisma.order.findUniqueOrThrow({ where: { orderCode } });

beforeAll(async () => {
  await initDb();
  await setSetting(prisma, "setup_completed", "true");
  // A configured QRIS rail, so the gateway checkouts get past their method gate
  // and reach the zero-total routing under test.
  await setSetting(prisma, "tokopay_merchant_id", "M-TEST");
  await setSetting(prisma, "tokopay_secret", "S-TEST");
  await createVoucher(prisma, { code: "FREE100", type: VoucherType.PERCENT, value: "100" });

  const cat = await prisma.category.create({ data: { name: "Dispatch Cat", slug: "dispatch-cat", sortOrder: 1 } });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Dispatch Product" });
  const digiflazz = await createDenomination(prisma, {
    productId: product.id,
    name: "86 Diamonds",
    type: "SHARED",
    durationLabel: "-",
    price: PRICE,
  });
  digiflazzDenomId = digiflazz.id;
  await routeDenominationToDigiflazz(prisma, digiflazzDenomId);

  const stock = await createDenomination(prisma, {
    productId: product.id,
    name: "Stock Item",
    type: "SHARED",
    durationLabel: "1 month",
    price: PRICE,
  });
  stockDenomId = stock.id;
  await prisma.stockItem.createMany({
    data: Array.from({ length: 10 }, () => ({ productId: stockDenomId, credentials: "user@mail.com:pass", status: "AVAILABLE" })),
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanupTestDb();
});

beforeEach(() => {
  vi.mocked(triggerDigiflazzDispatch).mockReset();
});

describe("instant Digiflazz dispatch from the storefront's no-gateway checkouts", () => {
  it("direct wallet checkout starts it exactly once for a Digiflazz order settled into PROCESSING", async () => {
    const customer = await buyer();
    const { orderCode } = await performDirectWalletCheckout(
      customer,
      { denominationId: digiflazzDenomId, quantity: 1 },
      OrderCurrency.IDR,
      null,
      DIGIFLAZZ_CUSTOMER_DATA_RAW,
    );

    const order = await orderOf(orderCode);
    expect(order.status).toBe(OrderStatus.PROCESSING);
    expect(triggerDigiflazzDispatch).toHaveBeenCalledTimes(1);
    expect(triggerDigiflazzDispatch).toHaveBeenCalledWith(order.id);
  });

  it("cart wallet checkout starts it exactly once for a Digiflazz order settled into PROCESSING", async () => {
    const customer = await buyer();
    await addToCart(prisma, customer.userId, digiflazzDenomId, 1);
    const { orderCode } = await performWalletCheckout(customer, OrderCurrency.IDR, null, DIGIFLAZZ_CUSTOMER_DATA_RAW);
    await clearCart(prisma, customer.userId);

    const order = await orderOf(orderCode);
    expect(order.status).toBe(OrderStatus.PROCESSING);
    expect(triggerDigiflazzDispatch).toHaveBeenCalledTimes(1);
    expect(triggerDigiflazzDispatch).toHaveBeenCalledWith(order.id);
  });

  it("a direct checkout a voucher fully covers starts it exactly once for a Digiflazz order", async () => {
    const customer = await buyer();
    const { orderCode, settledWithoutGateway } = await performDirectCheckout(
      customer,
      { denominationId: digiflazzDenomId, quantity: 1 },
      "qris",
      "FREE100",
      DIGIFLAZZ_CUSTOMER_DATA_RAW,
    );

    expect(settledWithoutGateway).toBe(true);
    const order = await orderOf(orderCode);
    expect(order.status).toBe(OrderStatus.PROCESSING);
    expect(triggerDigiflazzDispatch).toHaveBeenCalledTimes(1);
    expect(triggerDigiflazzDispatch).toHaveBeenCalledWith(order.id);
  });

  it("a cart checkout a voucher fully covers starts it exactly once for a Digiflazz order", async () => {
    const customer = await buyer();
    await addToCart(prisma, customer.userId, digiflazzDenomId, 1);
    const { orderCode, settledWithoutGateway } = await performCheckout(customer, "qris", "FREE100", DIGIFLAZZ_CUSTOMER_DATA_RAW);
    await clearCart(prisma, customer.userId);

    expect(settledWithoutGateway).toBe(true);
    const order = await orderOf(orderCode);
    expect(order.status).toBe(OrderStatus.PROCESSING);
    expect(triggerDigiflazzDispatch).toHaveBeenCalledTimes(1);
    expect(triggerDigiflazzDispatch).toHaveBeenCalledWith(order.id);
  });

  it("starts nothing for a wallet checkout delivered from stock", async () => {
    const customer = await buyer();
    const { orderCode } = await performDirectWalletCheckout(
      customer,
      { denominationId: stockDenomId, quantity: 1 },
      OrderCurrency.IDR,
      null,
    );

    expect((await orderOf(orderCode)).status).toBe(OrderStatus.DELIVERED);
    expect(triggerDigiflazzDispatch).not.toHaveBeenCalled();
  });

  it("starts nothing for a gateway checkout that still has money to collect", async () => {
    const customer = await buyer();
    const { orderCode, settledWithoutGateway } = await performDirectCheckout(
      customer,
      { denominationId: digiflazzDenomId, quantity: 1 },
      "qris",
      null,
      DIGIFLAZZ_CUSTOMER_DATA_RAW,
    );

    expect(settledWithoutGateway).toBe(false);
    expect((await orderOf(orderCode)).status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(triggerDigiflazzDispatch).not.toHaveBeenCalled();
  });
});
