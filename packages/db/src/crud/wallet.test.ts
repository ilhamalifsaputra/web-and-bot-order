import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { adjustWallet, listWalletLedger } from "./users";
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
    const bal = await adjustWallet(prisma, userId, "5.00", { reason: "admin_adjust", note: "promo", adminId: 7 });
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

  it("a rejected overdraw writes NO ledger row and no balance change", async () => {
    await expect(adjustWallet(prisma, userId, "-1", { reason: "order_payment" })).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.walletTransaction.count({ where: { userId } })).toBe(0);
    expect(Number((await prisma.user.findUnique({ where: { id: userId } }))!.walletBalance)).toBe(0);
  });

  it("default reason is 'adjust' when none is given", async () => {
    await adjustWallet(prisma, userId, "1");
    const row = (await prisma.walletTransaction.findFirst({ where: { userId } }))!;
    expect(row.reason).toBe("adjust");
  });
});
