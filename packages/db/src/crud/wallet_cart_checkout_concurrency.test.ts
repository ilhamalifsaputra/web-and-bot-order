/**
 * Backend audit E2 item 2: a double-tapped "pay from balance" on a CART must
 * create one order and debit the wallet once. completeCartOrderWithWalletCredit
 * runs createOrderFromCart with no checkoutIntentId, and createOrderFromCart
 * reads the cart and only clears it at the very end, so two concurrent
 * transactions both used to read the same cart and both create an order (and
 * both debit the wallet when the balance covered two).
 *
 * Real Postgres concurrency via Promise.allSettled — a sequential pair could
 * never show the race.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { OrderCurrency } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { addToCart, adjustWallet, createOrderFromCart } from "@app/db";
import { completeCartOrderWithWalletCredit } from "./wallet_checkout";

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
  sample = await buildSampleData(prisma); // product price "5.00" IDR, 5 AVAILABLE stock rows
});

describe("completeCartOrderWithWalletCredit under true Postgres concurrency", () => {
  it("a double submit of one cart creates ONE order and debits the wallet ONCE", async () => {
    // Enough credit for several orders, so the balance is not what stops the second.
    await adjustWallet(prisma, sample.user.id, "100", { currency: "IDR", reason: "admin_adjust" });
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });

    const submit = () =>
      prisma.$transaction((tx) =>
        completeCartOrderWithWalletCredit(tx, {
          channel: "web",
          user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
          currency: OrderCurrency.IDR,
        }),
      );

    // Widen the race window deterministically: hold the buyer's user row (the
    // lock adjustWallet takes for the debit) for a moment, so every submit has
    // already read the cart before any of them can reach the debit and commit.
    // Without the fix all three read the same cart here and each creates an order.
    let releaseHold!: () => void;
    const holdReleased = new Promise<void>((resolve) => (releaseHold = resolve));
    const hold = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
        await holdReleased;
      },
      { timeout: 15_000 },
    );
    await new Promise((r) => setTimeout(r, 200)); // the hold is in place

    const pending = Promise.allSettled([submit(), submit(), submit()]);
    await new Promise((r) => setTimeout(r, 1500)); // every submit is now in flight
    releaseHold();
    await hold;
    const results = await pending;
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.reason).toMatchObject({ key: "error.cart_empty" });

    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
    const debits = await prisma.walletTransaction.findMany({ where: { userId: user.id, reason: "order_payment" } });
    expect(debits).toHaveLength(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(new Decimal(after.walletBalance).equals("95")).toBe(true);
  });

  it("a double submit of one cart on a payment-gateway checkout (no wallet) creates ONE pending order and reserves stock once", async () => {
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });

    const submit = () =>
      prisma.$transaction((tx) =>
        createOrderFromCart(tx, {
          channel: "web",
          user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        }),
      );

    const results = await Promise.allSettled([submit(), submit(), submit()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
      expect(r.reason).toMatchObject({ key: "error.cart_empty" });
    }
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.stockItem.count({ where: { productId: sample.product.id, status: "RESERVED" } })).toBe(1);
  });
});
