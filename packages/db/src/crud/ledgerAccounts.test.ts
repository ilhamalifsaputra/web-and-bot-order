/**
 * Chart-of-accounts seed (Financial Ledger M1): `seedChartOfAccounts` installs
 * every `CHART_OF_ACCOUNTS` row and is safe to re-run.
 *
 * Idempotency is the point of these tests, not a nicety: this seed is a CLI
 * bootstrap (`pnpm seed-chart-of-accounts`) that a human will run again after
 * every deploy and every edit to the list, so a second run creating duplicate
 * accounts would split one account's balance across two rows — an unnoticeable
 * corruption of the ledger's own foundation.
 *
 * Deliberately NOT covered here: anything posting a FinancialTransaction or
 * LedgerEntry. No posting service exists in this milestone.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { LedgerAccountType, OrderCurrency } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { CHART_OF_ACCOUNTS, seedChartOfAccounts } from "./ledgerAccounts";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  // `resetDb` (tests/helpers/sampleData.ts) does not clear ledger_accounts, and
  // nothing else in this file writes any other table — so clear just this one,
  // keeping each test independent of the order they run in.
  await prisma.ledgerAccount.deleteMany();
});

describe("CHART_OF_ACCOUNTS", () => {
  it("declares 15 accounts with unique codes", () => {
    expect(CHART_OF_ACCOUNTS).toHaveLength(15);
    expect(new Set(CHART_OF_ACCOUNTS.map((a) => a.code)).size).toBe(15);
  });

  it("only uses known LedgerAccountType and OrderCurrency values", () => {
    const types = Object.values(LedgerAccountType) as string[];
    const currencies = Object.values(OrderCurrency) as string[];
    for (const account of CHART_OF_ACCOUNTS) {
      expect(types).toContain(account.type);
      expect(currencies).toContain(account.currency);
    }
  });
});

describe("seedChartOfAccounts", () => {
  it("creates exactly 15 accounts on a fresh database", async () => {
    const result = await seedChartOfAccounts(prisma);

    expect(result).toEqual({ accountCount: 15 });
    expect(await prisma.ledgerAccount.count()).toBe(15);
  });

  it("stores each account's code, name, type and currency exactly as declared", async () => {
    await seedChartOfAccounts(prisma);

    const rows = await prisma.ledgerAccount.findMany({ orderBy: { code: "asc" } });
    const expected = [...CHART_OF_ACCOUNTS].sort((a, b) => a.code.localeCompare(b.code));

    expect(rows.map((r) => ({ code: r.code, name: r.name, type: r.type, currency: r.currency }))).toEqual(
      expected.map((a) => ({ code: a.code, name: a.name, type: a.type, currency: a.currency })),
    );
    // Every account starts active; the seed never creates a retired one.
    expect(rows.every((r) => r.isActive)).toBe(true);
  });

  it("is idempotent: a second run adds no rows and keeps the same ids", async () => {
    await seedChartOfAccounts(prisma);
    const before = await prisma.ledgerAccount.findMany({ orderBy: { code: "asc" } });

    // Must not throw — the upsert-on-`code` is what makes the re-run a no-op
    // rather than a unique-constraint violation on ix_ledger_accounts_code.
    await expect(seedChartOfAccounts(prisma)).resolves.toEqual({ accountCount: 15 });

    const after = await prisma.ledgerAccount.findMany({ orderBy: { code: "asc" } });
    expect(after).toHaveLength(15);
    // Same ids, not just the same count: posting code resolves accounts by
    // `code`, but a re-seed that deleted and recreated rows would orphan any
    // LedgerEntry.accountId already pointing at them.
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.code)).toEqual(before.map((r) => r.code));
  });

  it("does not revive an account an admin retired", async () => {
    await seedChartOfAccounts(prisma);
    await prisma.ledgerAccount.update({
      where: { code: "adjustment.usdt" },
      data: { isActive: false },
    });

    await seedChartOfAccounts(prisma);

    // `isActive` is deliberately absent from the upsert's `update` clause, so a
    // deactivation survives a re-seed (see seedChartOfAccounts' doc comment).
    const retired = await prisma.ledgerAccount.findUniqueOrThrow({
      where: { code: "adjustment.usdt" },
    });
    expect(retired.isActive).toBe(false);
  });
});
