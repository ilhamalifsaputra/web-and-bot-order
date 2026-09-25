import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { adjustWallet, listWalletLedger, countWalletLedgerEntries } from "./users";
import { ValidationError } from "@app/core/errors";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

let userId: number;
beforeEach(async () => {
  await prisma.walletTransaction.deleteMany();
  await prisma.user.deleteMany();
  const u = await prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}`, walletBalance: "0" },
  });
  userId = u.id;
});

describe("adjustWallet ledger", () => {
  it("writes a ledger row with the applied delta, running balance, and reason", async () => {
    const { balance: bal } = await adjustWallet(prisma, userId, "5.00", { reason: "admin_adjust", note: "promo", adminId: 7 });
    expect(bal.toString()).toBe("5");
    const rows = await prisma.walletTransaction.findMany({ where: { userId } });
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.delta)).toBeCloseTo(5);
    expect(Number(rows[0]!.balanceAfter)).toBeCloseTo(5);
    expect(rows[0]!.reason).toBe("admin_adjust");
    expect(rows[0]!.note).toBe("promo");
    expect(rows[0]!.adminId).toBe(7);
  });

  it("accumulates a newest-first timeline with running balances", async () => {
    await adjustWallet(prisma, userId, "10", { reason: "referral", orderId: 3 });
    await adjustWallet(prisma, userId, "-4", { reason: "order_payment", orderId: 4 });
    const ledger = await listWalletLedger(prisma, userId, 10);
    expect(ledger.length).toBe(2);
    expect(ledger[0]!.reason).toBe("order_payment"); // newest first
    expect(ledger[0]!.delta).toBe("-4");
    expect(ledger[0]!.balanceAfter).toBe("6");
    expect(ledger[0]!.orderId).toBe(4);
    expect(ledger[1]!.reason).toBe("referral");
    expect(ledger[1]!.balanceAfter).toBe("10");
  });

  it("countWalletLedgerEntries returns the real total behind listWalletLedger's capped page", async () => {
    await adjustWallet(prisma, userId, "10", { reason: "referral", orderId: 3 });
    await adjustWallet(prisma, userId, "-4", { reason: "order_payment", orderId: 4 });
    await adjustWallet(prisma, userId, "1", { reason: "admin_adjust" });

    const capped = await listWalletLedger(prisma, userId, 2);
    expect(capped.length).toBe(2); // capped below the real total
    expect(await countWalletLedgerEntries(prisma, userId)).toBe(3);
  });

  it("a rejected overdraw writes NO ledger row and no balance change", async () => {
    await expect(adjustWallet(prisma, userId, "-1", { reason: "order_payment" })).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.walletTransaction.count({ where: { userId } })).toBe(0);
    expect(Number((await prisma.user.findUnique({ where: { id: userId } }))!.walletBalance)).toBe(0);
  });

  // F-03 (execution/10): an admin manual adjust may push the balance negative
  // when allowNegative is set (e.g. clawing back an erroneous credit). The guard
  // is bypassed only then; a ledger row is still written.
  it("allowNegative lets an admin adjust the balance below zero (with a ledger row)", async () => {
    const { balance: newBal } = await adjustWallet(prisma, userId, "-5", {
      reason: "admin_adjust",
      adminId: 7,
      allowNegative: true,
    });
    expect(newBal.toString()).toBe("-5");
    expect(Number((await prisma.user.findUnique({ where: { id: userId } }))!.walletBalance)).toBe(-5);
    const row = (await prisma.walletTransaction.findFirst({ where: { userId } }))!;
    expect(row.balanceAfter.toString()).toBe("-5");
    expect(Number(row.delta)).toBe(-5);
    expect(row.adminId).toBe(7);
  });

  it("the overdraw guard is exact: a debit to precisely zero is allowed", async () => {
    await adjustWallet(prisma, userId, "5", { reason: "admin_adjust" });
    const { balance: bal } = await adjustWallet(prisma, userId, "-5", { reason: "order_payment" }); // → 0, not negative
    expect(bal.toString()).toBe("0");
  });

  it("default reason is 'adjust' when none is given", async () => {
    await adjustWallet(prisma, userId, "1");
    const row = (await prisma.walletTransaction.findFirst({ where: { userId } }))!;
    expect(row.reason).toBe("adjust");
  });
});

describe("adjustWallet per-currency (IDR vs USDT balances are independent)", () => {
  const userBalances = () =>
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { walletBalance: true, walletBalanceUsdt: true } });

  it("defaults to IDR and does not touch the USDT balance", async () => {
    await adjustWallet(prisma, userId, "5", { reason: "admin_adjust" });
    const u = await userBalances();
    expect(Number(u.walletBalance)).toBeCloseTo(5);
    expect(Number(u.walletBalanceUsdt)).toBeCloseTo(0);
    const row = (await prisma.walletTransaction.findFirst({ where: { userId } }))!;
    expect(row.currency).toBe("IDR");
  });

  it("credits USDT without changing IDR, and tags the ledger row USDT", async () => {
    await adjustWallet(prisma, userId, "3.5", { currency: "USDT", reason: "admin_adjust" });
    const u = await userBalances();
    expect(Number(u.walletBalance)).toBeCloseTo(0);
    expect(Number(u.walletBalanceUsdt)).toBeCloseTo(3.5);
    const row = (await prisma.walletTransaction.findFirst({ where: { userId } }))!;
    expect(row.currency).toBe("USDT");
  });

  it("moves each currency independently (IDR debit leaves USDT, USDT debit leaves IDR)", async () => {
    await adjustWallet(prisma, userId, "10", { currency: "IDR", reason: "admin_adjust" });
    await adjustWallet(prisma, userId, "8", { currency: "USDT", reason: "admin_adjust" });

    await adjustWallet(prisma, userId, "-4", { currency: "IDR", reason: "order_payment" });
    let u = await userBalances();
    expect(Number(u.walletBalance)).toBeCloseTo(6);
    expect(Number(u.walletBalanceUsdt)).toBeCloseTo(8); // USDT untouched

    await adjustWallet(prisma, userId, "-3", { currency: "USDT", reason: "order_payment" });
    u = await userBalances();
    expect(Number(u.walletBalance)).toBeCloseTo(6); // IDR untouched
    expect(Number(u.walletBalanceUsdt)).toBeCloseTo(5);
  });

  it("overdraw is checked per-currency: USDT overdraw never touches IDR", async () => {
    await adjustWallet(prisma, userId, "20", { currency: "IDR", reason: "admin_adjust" });
    // USDT balance is 0 → debiting 1 USDT overdraws even though IDR is flush.
    await expect(
      adjustWallet(prisma, userId, "-1", { currency: "USDT", reason: "order_payment" }),
    ).rejects.toBeInstanceOf(ValidationError);
    const u = await userBalances();
    expect(Number(u.walletBalance)).toBeCloseTo(20); // unchanged
    expect(Number(u.walletBalanceUsdt)).toBeCloseTo(0);
    // No USDT ledger row written for the rejected move.
    expect(await prisma.walletTransaction.count({ where: { userId, currency: "USDT" } })).toBe(0);
  });
});

// E5 item 2: `@@unique([orderId, reason])`. Six order-scoped reasons are each
// already once-per-order in the code, but by six different mechanisms (an
// atomic claim, a read-then-throw, a status transition, a terminal-status
// guard, a UNIQUE on another table, and one-creation-path-per-order). These
// pin the constraint that makes that structural instead, and — just as
// importantly — pin the two things it must NOT restrict.
describe("wallet_transactions one-movement-per-order-per-reason constraint", () => {
  async function makeOrder(): Promise<number> {
    const order = await prisma.order.create({
      data: { orderCode: `ORD-${Math.random()}`, userId, subtotalAmount: "5", totalAmount: "5" },
    });
    return order.id;
  }

  // The beforeEach above clears users, and Order → User is onDelete: Restrict,
  // so orders created here have to go first or the NEXT test's cleanup throws.
  afterEach(async () => {
    await prisma.walletTransaction.deleteMany();
    await prisma.order.deleteMany();
  });

  it("rejects a second movement with the same order and reason", async () => {
    const orderId = await makeOrder();
    await adjustWallet(prisma, userId, "100", { reason: "wallet_topup", orderId });

    await expect(adjustWallet(prisma, userId, "100", { reason: "wallet_topup", orderId })).rejects.toThrow();

    const rows = await prisma.walletTransaction.findMany({ where: { orderId } });
    expect(rows).toHaveLength(1);
    // The balance moved exactly once — the point of the constraint. This is
    // asserted on a BARE call (no surrounding $transaction) on purpose: it is
    // what pins the ledger-before-balance write order in `adjustWallet`. With
    // the balance written first, the rejected second call would still have
    // moved the money to 200 while leaving one ledger row behind it, and
    // nothing outside a transaction would roll that back.
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(Number(u.walletBalance)).toBeCloseTo(100);
  });

  it("allows the different reasons one order legitimately produces", async () => {
    // A real sequence: the buyer spends credit at checkout, the order can't be
    // fulfilled, the admin credits it back to their balance, and the holds are
    // released. Three reasons, one order, all legal.
    const orderId = await makeOrder();
    await adjustWallet(prisma, userId, "50", { reason: "admin_adjust" });
    await adjustWallet(prisma, userId, "-20", { reason: "order_payment", orderId });
    await adjustWallet(prisma, userId, "20", { reason: "order_refund", orderId });
    await adjustWallet(prisma, userId, "5", { reason: "unfulfilled_credit", orderId });

    expect(await prisma.walletTransaction.count({ where: { orderId } })).toBe(3);
  });

  it("leaves order-less movements completely unconstrained", async () => {
    // NULLs are distinct in a SQLite UNIQUE index. An admin must stay free to
    // adjust a customer's balance as many times as they need — those movements
    // belong to no order, and this is what would break if the constraint were
    // ever written to treat NULL as a value.
    await adjustWallet(prisma, userId, "10", { reason: "admin_adjust" });
    await adjustWallet(prisma, userId, "10", { reason: "admin_adjust" });
    await adjustWallet(prisma, userId, "10", { reason: "admin_adjust" });

    expect(await prisma.walletTransaction.count({ where: { userId, orderId: null } })).toBe(3);
  });

  it("scopes the rule to one order — the same reason is fine on a different order", async () => {
    const first = await makeOrder();
    const second = await makeOrder();

    await adjustWallet(prisma, userId, "100", { reason: "wallet_topup", orderId: first });
    await adjustWallet(prisma, userId, "100", { reason: "wallet_topup", orderId: second });

    expect(await prisma.walletTransaction.count({ where: { reason: "wallet_topup" } })).toBe(2);
  });
});
