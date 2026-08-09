import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { OrderCurrency, OrderKind, OrderStatus, PaymentMethod } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { getSetting, setSetting } from "./settings";
import {
  resolveWalletTopupLimits,
  createWalletTopupOrder,
  settleWalletTopup,
  hasPendingWalletTopupOrder,
  WALLET_TOPUP_MIN_AMOUNT_IDR_KEY,
  WALLET_TOPUP_MAX_AMOUNT_IDR_KEY,
  WALLET_TOPUP_MIN_AMOUNT_USDT_KEY,
  WALLET_TOPUP_MAX_AMOUNT_USDT_KEY,
} from "./wallet_topup";

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

async function freshUser() {
  return prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
}

describe("resolveWalletTopupLimits", () => {
  it("absent Settings rows resolve to null (no cap) for all four bounds", async () => {
    const limits = await resolveWalletTopupLimits(prisma);
    expect(limits).toEqual({ minIdr: null, maxIdr: null, minUsdt: null, maxUsdt: null });
  });

  it("blank Settings values resolve to null", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "");
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_USDT_KEY, "   ");
    const limits = await resolveWalletTopupLimits(prisma);
    expect(limits.minIdr).toBeNull();
    expect(limits.maxUsdt).toBeNull();
  });

  it("invalid (non-numeric / non-positive) Settings values resolve to null", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "not-a-number");
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_IDR_KEY, "-100");
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_USDT_KEY, "0");
    const limits = await resolveWalletTopupLimits(prisma);
    expect(limits.minIdr).toBeNull();
    expect(limits.maxIdr).toBeNull();
    expect(limits.minUsdt).toBeNull();
  });

  it("valid Settings values parse to the matching Decimal per currency/bound", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "10000");
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_IDR_KEY, "5000000");
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_USDT_KEY, "1");
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_USDT_KEY, "1000");
    const limits = await resolveWalletTopupLimits(prisma);
    expect(limits.minIdr?.equals("10000")).toBe(true);
    expect(limits.maxIdr?.equals("5000000")).toBe(true);
    expect(limits.minUsdt?.equals("1")).toBe(true);
    expect(limits.maxUsdt?.equals("1000")).toBe(true);
  });
});

describe("createWalletTopupOrder — amount fidelity (regression test for Global Constraint 2)", () => {
  // THE bug this task exists to prevent: finalizeOrderPayment's USDT branch
  // always computes usdt = usdtFromIdr(baseIdr, rate) — correct for a product
  // order (whose stored total IS central-IDR), catastrophically wrong for a
  // top-up (whose typed amount ALREADY IS the USDT figure). At a 16000 rate,
  // usdtFromIdr(50, 16000) ~= 0.003 — "top up 50 USDT" would silently become
  // "top up ~0.003 USDT" if createWalletTopupOrder reused that branch
  // unchanged. These two tests assert the stored totalAmount equals the
  // typed amount (modulo unique-cents noise, which is bounded to the
  // documented 0.002-0.098 bucket range from computeUniqueCents and is
  // asserted EXACTLY via `amount + order.uniqueCents`, not a loose delta) —
  // not a rate-converted figure.

  it("IDR top-up: totalAmount equals the typed amount exactly (uniqueCents always stripped to 0 for IDR)", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "50000",
        currency: "IDR",
        method: PaymentMethod.TOKOPAY,
      }),
    );
    expect(order.kind).toBe(OrderKind.WALLET_TOPUP);
    expect(order.currency).toBe(OrderCurrency.IDR);
    expect(new Decimal(order.uniqueCents).equals(0)).toBe(true);
    expect(new Decimal(order.totalAmount).equals("50000")).toBe(true);
  });

  it("USDT top-up: totalAmount equals the typed amount plus its own uniqueCents — NEVER a rate-converted figure", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "50",
        currency: "USDT",
        method: PaymentMethod.NOWPAYMENTS,
        rate: "16000",
      }),
    );
    expect(order.kind).toBe(OrderKind.WALLET_TOPUP);
    expect(order.currency).toBe(OrderCurrency.USDT);
    // uniqueCents noise is bounded to computeUniqueCents' 0.002-0.098 bucket
    // range — assert it exactly, not loosely.
    expect(new Decimal(order.uniqueCents).greaterThanOrEqualTo(0)).toBe(true);
    expect(new Decimal(order.uniqueCents).lessThan("0.1")).toBe(true);
    expect(new Decimal(order.totalAmount).equals(new Decimal("50").plus(order.uniqueCents))).toBe(true);
    // Explicitly rule out the usdtFromIdr(50, 16000) ~= 0.003 bug — the real
    // total must be far closer to 50 than to that.
    expect(new Decimal(order.totalAmount).greaterThan("40")).toBe(true);
    // fxRate is still stamped for record-keeping even though it played no
    // role in the amount.
    expect(new Decimal(order.fxRate!).equals("16000")).toBe(true);
  });
});

describe("createWalletTopupOrder — creates a bare Order (kind + zero OrderItem rows)", () => {
  it("kind is WALLET_TOPUP and no OrderItem rows are created", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: "20000",
        currency: "IDR",
        method: PaymentMethod.TOKOPAY,
      }),
    );
    expect(order.kind).toBe(OrderKind.WALLET_TOPUP);
    expect(order.items).toHaveLength(0);
    const itemRows = await prisma.orderItem.count({ where: { orderId: order.id } });
    expect(itemRows).toBe(0);
    expect(order.voucherId).toBeNull();
  });
});

describe("hasPendingWalletTopupOrder", () => {
  it("is false when the buyer has no pending top-up order at all", async () => {
    const dupe = await hasPendingWalletTopupOrder(prisma, {
      userId: sample.user.id,
      method: PaymentMethod.TOKOPAY,
      sinceMs: 30_000,
    });
    expect(dupe).toBe(false);
  });

  it("is true for a same-rail PENDING_PAYMENT top-up order created within the window", async () => {
    await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
    const dupe = await hasPendingWalletTopupOrder(prisma, {
      userId: sample.user.id,
      method: PaymentMethod.TOKOPAY,
      sinceMs: 30_000,
    });
    expect(dupe).toBe(true);
  });

  it("is false for a DIFFERENT rail — the duplicate guard is per payment method", async () => {
    await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
    const dupe = await hasPendingWalletTopupOrder(prisma, {
      userId: sample.user.id,
      method: PaymentMethod.PAYDISINI,
      sinceMs: 30_000,
    });
    expect(dupe).toBe(false);
  });

  it("is false once the pending top-up order is outside the window", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
    await prisma.order.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    const dupe = await hasPendingWalletTopupOrder(prisma, {
      userId: sample.user.id,
      method: PaymentMethod.TOKOPAY,
      sinceMs: 30_000,
    });
    expect(dupe).toBe(false);
  });

  it("is false once the order is no longer PENDING_PAYMENT (e.g. delivered)", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: "20000" }));
    const dupe = await hasPendingWalletTopupOrder(prisma, {
      userId: sample.user.id,
      method: PaymentMethod.TOKOPAY,
      sinceMs: 30_000,
    });
    expect(dupe).toBe(false);
  });

  it("a PENDING PRODUCT order under the same method never counts as a duplicate top-up", async () => {
    // A plain product order stamped to the same rail (kind defaults to
    // PRODUCT) must not block a top-up — the guard is scoped to
    // kind: WALLET_TOPUP specifically.
    await prisma.order.create({
      data: {
        orderCode: `PRODORDER-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "50000",
        totalAmount: "50000",
        status: OrderStatus.PENDING_PAYMENT,
        paymentMethod: PaymentMethod.TOKOPAY,
      },
    });
    const dupe = await hasPendingWalletTopupOrder(prisma, {
      userId: sample.user.id,
      method: PaymentMethod.TOKOPAY,
      sinceMs: 30_000,
    });
    expect(dupe).toBe(false);
  });
});

describe("createWalletTopupOrder — min/max bound enforcement", () => {
  it("rejects an IDR amount below the configured minimum, creates no order", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY, "10000");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, { userId: sample.user.id, amount: "5000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_below_min" });
    expect(await prisma.order.count()).toBe(0);
  });

  it("rejects an IDR amount above the configured maximum, creates no order", async () => {
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_IDR_KEY, "1000000");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, { userId: sample.user.id, amount: "2000000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_above_max" });
    expect(await prisma.order.count()).toBe(0);
  });

  it("rejects a USDT amount below the configured minimum, creates no order", async () => {
    await setSetting(prisma, WALLET_TOPUP_MIN_AMOUNT_USDT_KEY, "5");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "1",
          currency: "USDT",
          method: PaymentMethod.NOWPAYMENTS,
          rate: "16000",
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_below_min" });
    expect(await prisma.order.count()).toBe(0);
  });

  it("rejects a USDT amount above the configured maximum, creates no order", async () => {
    await setSetting(prisma, WALLET_TOPUP_MAX_AMOUNT_USDT_KEY, "100");
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "200",
          currency: "USDT",
          method: PaymentMethod.NOWPAYMENTS,
          rate: "16000",
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_above_max" });
    expect(await prisma.order.count()).toBe(0);
  });
});

describe("createWalletTopupOrder — rejects a disabled/unknown method", () => {
  it("rejects an unknown method string", async () => {
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "10000",
          currency: "IDR",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          method: "PAYPAL" as any,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_invalid_method" });
  });

  it("rejects a USDT-only method (BYBIT) for an IDR top-up", async () => {
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "10000",
          currency: "IDR",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          method: PaymentMethod.BYBIT as any,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_invalid_method" });
  });

  it("rejects WALLET as a top-up method (nothing to top up wallet credit WITH)", async () => {
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "10000",
          currency: "IDR",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          method: PaymentMethod.WALLET as any,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_invalid_method" });
  });

  it("rejects BINANCE_PAY (manual bot-only proof flow, not an auto-confirm top-up rail)", async () => {
    await expect(
      prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: "10",
          currency: "USDT",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          method: PaymentMethod.BINANCE_PAY as any,
          rate: "16000",
        }),
      ),
    ).rejects.toMatchObject({ key: "error.wallet_topup_invalid_method" });
  });
});

describe("settleWalletTopup", () => {
  async function makeIdrTopupOrder(amount: string = "20000") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount, currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
  }
  async function makeUsdtTopupOrder(amount: string = "10") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount,
        currency: "USDT",
        method: PaymentMethod.NOWPAYMENTS,
        rate: "16000",
      }),
    );
  }

  it("credits walletBalance for an IDR order; walletBalanceUsdt is untouched (currency isolation)", async () => {
    const order = await makeIdrTopupOrder("20000");
    const result = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.credited.equals(order.totalAmount)).toBe(true);

    const user = await freshUser();
    expect(new Decimal(user.walletBalance).equals(order.totalAmount)).toBe(true);
    expect(new Decimal(user.walletBalanceUsdt).equals(0)).toBe(true);
  });

  it("credits walletBalanceUsdt for a USDT order; walletBalance is untouched (currency isolation)", async () => {
    const order = await makeUsdtTopupOrder("10");
    const result = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.credited.equals(order.totalAmount)).toBe(true);

    const user = await freshUser();
    expect(new Decimal(user.walletBalanceUsdt).equals(order.totalAmount)).toBe(true);
    expect(new Decimal(user.walletBalance).equals(0)).toBe(true);
  });

  it("writes a WalletTransaction row with reason wallet_topup, the order's currency, and orderId set", async () => {
    const order = await makeIdrTopupOrder("15000");
    await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));

    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.reason).toBe("wallet_topup");
    expect(row.currency).toBe("IDR");
    expect(row.orderId).toBe(order.id);
    expect(new Decimal(row.delta).equals(order.totalAmount)).toBe(true);
  });

  it("called twice on the same order is a no-op the second time — adjustWallet's effect happens exactly once", async () => {
    const order = await makeIdrTopupOrder("20000");

    const first = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    expect(first.credited.equals(order.totalAmount)).toBe(true);

    const second = await prisma.$transaction((tx) => settleWalletTopup(tx, order.id, { amount: order.totalAmount }));
    expect(second.order.status).toBe(OrderStatus.DELIVERED);
    expect(second.credited.equals(0)).toBe(true); // no-op signal, not a second credit

    // The real assertion: exactly ONE WalletTransaction ledger row for this
    // order, and the balance reflects exactly one credit, not two.
    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(1);

    const user = await freshUser();
    expect(new Decimal(user.walletBalance).equals(order.totalAmount)).toBe(true);
  });

  // Defense-in-depth guard (review finding, fix round 1): Task 3's six
  // gateway-settlement call sites are each expected to check
  // `order.kind === OrderKind.WALLET_TOPUP` before ever calling this
  // function, but settleWalletTopup must not rely on every future caller
  // getting that right — the failure mode (a PRODUCT order silently
  // DELIVERED + wallet-credited, skipping stock/referral/delivery) is a real
  // money+inventory bug.
  it("refuses to settle a PRODUCT-kind order even if it's PENDING_PAYMENT — wallet and status untouched", async () => {
    const productOrder = await prisma.order.create({
      data: {
        orderCode: "TEST-PRODUCT-ORDER",
        userId: sample.user.id,
        // kind defaults to PRODUCT — deliberately not overridden here.
        subtotalAmount: "10000",
        totalAmount: "10000",
        status: OrderStatus.PENDING_PAYMENT,
      },
    });
    expect(productOrder.kind).toBe("PRODUCT");

    await expect(
      prisma.$transaction((tx) => settleWalletTopup(tx, productOrder.id, { amount: "10000" })),
    ).rejects.toMatchObject({ key: "error.order_not_wallet_topup" });

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: productOrder.id } });
    expect(reloaded.status).toBe(OrderStatus.PENDING_PAYMENT); // unchanged — never claimed as DELIVERED

    const user = await freshUser();
    expect(new Decimal(user.walletBalance).equals(0)).toBe(true); // no credit applied
    expect(new Decimal(user.walletBalanceUsdt).equals(0)).toBe(true);
  });
});
