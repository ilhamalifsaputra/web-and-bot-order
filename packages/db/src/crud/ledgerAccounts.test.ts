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
 * LedgerEntry — that's `postFinancialTransaction`'s own test file,
 * `ledger.test.ts`. This file is the chart of accounts alone.
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
  it("declares 17 accounts with unique codes", () => {
    expect(CHART_OF_ACCOUNTS).toHaveLength(17);
    expect(new Set(CHART_OF_ACCOUNTS.map((a) => a.code)).size).toBe(17);
  });

  it("only uses known LedgerAccountType and OrderCurrency values", () => {
    const types = Object.values(LedgerAccountType) as string[];
    const currencies = Object.values(OrderCurrency) as string[];
    for (const account of CHART_OF_ACCOUNTS) {
      expect(types).toContain(account.type);
      expect(currencies).toContain(account.currency);
    }
  });

  it("classifies each clearing purpose by its real normal balance, not as CLEARING", () => {
    // Pinned explicitly rather than derived from the list, because this is the
    // one classification a future trial-balance report can get backwards
    // without anything failing: `provider_clearing.*` is money a gateway owes
    // us (debit-normal, ASSET) and `refund_clearing.*` is money we owe a buyer
    // (credit-normal, LIABILITY). See CHART_OF_ACCOUNTS' doc comment.
    const byCode = new Map(CHART_OF_ACCOUNTS.map((a) => [a.code, a] as const));
    const expectedClearingTypes: Record<string, LedgerAccountType> = {
      "provider_clearing.idr": LedgerAccountType.ASSET,
      "provider_clearing.usdt": LedgerAccountType.ASSET,
      "refund_clearing.idr": LedgerAccountType.LIABILITY,
      "refund_clearing.usdt": LedgerAccountType.LIABILITY,
    };

    for (const [code, expectedType] of Object.entries(expectedClearingTypes)) {
      expect(byCode.get(code)?.type).toBe(expectedType);
    }
  });

  it("books referral commission as a USDT expense, not as a second liability", () => {
    // Pinned for the same reason as the clearing types above: nothing fails if
    // this one is classified wrongly, the books just stop meaning what they say.
    // A commission is paid by crediting the referrer's wallet, so
    // wallet_liability already carries the obligation — a `referral_payable`
    // LIABILITY (which M1 seeded, and which this replaced) would count the same
    // obligation twice and never be discharged. It is USDT-only because
    // maybePayReferralCommission pays commission only into the USDT balance.
    const byCode = new Map(CHART_OF_ACCOUNTS.map((a) => [a.code, a] as const));

    expect(byCode.get("referral_expense.usdt")).toMatchObject({
      type: LedgerAccountType.EXPENSE,
      currency: OrderCurrency.USDT,
    });
    expect(byCode.has("referral_payable.idr")).toBe(false);
    expect(byCode.has("referral_expense.idr")).toBe(false);
  });
});

describe("seedChartOfAccounts", () => {
  it("creates exactly 17 accounts on a fresh database", async () => {
    const result = await seedChartOfAccounts(prisma);

    // A clean bootstrap: nothing diverged and nothing outside the chart.
    expect(result).toEqual({ accountCount: 17, diverged: [], notInChart: [] });
    expect(await prisma.ledgerAccount.count()).toBe(17);
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
    await expect(seedChartOfAccounts(prisma)).resolves.toEqual({
      accountCount: 17,
      diverged: [],
      notInChart: [],
    });

    const after = await prisma.ledgerAccount.findMany({ orderBy: { code: "asc" } });
    expect(after).toHaveLength(17);
    // Same ids, not just the same count: posting code resolves accounts by
    // `code`, but a re-seed that deleted and recreated rows would orphan any
    // LedgerEntry.accountId already pointing at them.
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.code)).toEqual(before.map((r) => r.code));
  });

  it("does not clobber a diverged account's type or currency, but does refresh its name", async () => {
    await seedChartOfAccounts(prisma);
    // Simulate an existing account whose stored classification no longer matches
    // CHART_OF_ACCOUNTS. The name is diverged too, so this test can tell "the
    // update clause left type alone" apart from "the update clause never ran".
    await prisma.ledgerAccount.update({
      where: { code: "cash.idr" },
      data: {
        name: "Renamed by hand",
        type: LedgerAccountType.EXPENSE,
        currency: OrderCurrency.USDT,
      },
    });

    await seedChartOfAccounts(prisma);

    const account = await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: "cash.idr" } });
    // `type`/`currency` are absent from the upsert's `update` clause on purpose:
    // re-typing an account reinterprets the sign of every LedgerEntry already
    // posted against it, and re-denominating it breaks the
    // `entry.currency == account.currency` invariant — neither may happen
    // silently on a seed re-run (see seedChartOfAccounts' doc comment).
    expect(account.type).toBe(LedgerAccountType.EXPENSE);
    expect(account.currency).toBe(OrderCurrency.USDT);
    // `name` is display-only, so it is the one field the seed does reassert.
    expect(account.name).toBe("Cash (IDR)");
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

/**
 * The seed cannot fix a diverged or dropped account (doing so would reinterpret
 * entries already posted against it), so its only honest alternative to silence
 * is to report it — whole-branch review C6. Before this, a database seeded by an
 * M1-era chart kept `referral_payable.idr` active and listed in the trial balance
 * forever, and no run said a word about it.
 */
describe("seedChartOfAccounts — what it reports rather than changes", () => {
  it("reports nothing for a database it just seeded", async () => {
    const report = await seedChartOfAccounts(prisma);

    expect(report.diverged).toEqual([]);
    expect(report.notInChart).toEqual([]);
  });

  it("reports an account whose stored type disagrees with the chart, both sides named", async () => {
    await seedChartOfAccounts(prisma);
    await prisma.ledgerAccount.update({
      where: { code: "cash.idr" },
      data: { type: LedgerAccountType.REVENUE },
    });

    const report = await seedChartOfAccounts(prisma);

    expect(report.diverged).toEqual([
      {
        code: "cash.idr",
        storedType: LedgerAccountType.REVENUE,
        expectedType: LedgerAccountType.ASSET,
        storedCurrency: OrderCurrency.IDR,
        expectedCurrency: OrderCurrency.IDR,
      },
    ]);
    // Reported, NOT corrected — the whole point.
    const stored = await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: "cash.idr" } });
    expect(stored.type).toBe(LedgerAccountType.REVENUE);
  });

  it("reports an account whose stored currency disagrees with the chart", async () => {
    await seedChartOfAccounts(prisma);
    await prisma.ledgerAccount.update({
      where: { code: "cash.idr" },
      data: { currency: OrderCurrency.USDT },
    });

    const report = await seedChartOfAccounts(prisma);

    expect(report.diverged).toHaveLength(1);
    expect(report.diverged[0]).toMatchObject({
      code: "cash.idr",
      storedCurrency: OrderCurrency.USDT,
      expectedCurrency: OrderCurrency.IDR,
    });
  });

  it("reports an active account the chart no longer contains — the referral_payable.idr case", async () => {
    await seedChartOfAccounts(prisma);
    // Exactly the row an M1-era seed left behind: M3 dropped this code from
    // CHART_OF_ACCOUNTS as wrongly classified, but nothing retired or removed the
    // row, so it is still active and still a line in the trial balance.
    await prisma.ledgerAccount.create({
      data: {
        code: "referral_payable.idr",
        name: "Referral Commission Payable (IDR)",
        type: LedgerAccountType.LIABILITY,
        currency: OrderCurrency.IDR,
      },
    });

    const report = await seedChartOfAccounts(prisma);

    expect(report.notInChart).toEqual(["referral_payable.idr"]);
    // Reported, NOT retired: retiring an account that may already carry posted
    // entries is an accounting decision, and this seed runs after every deploy.
    const lingering = await prisma.ledgerAccount.findUniqueOrThrow({
      where: { code: "referral_payable.idr" },
    });
    expect(lingering.isActive).toBe(true);
  });

  it("does not report an unknown account that has already been retired", async () => {
    await seedChartOfAccounts(prisma);
    await prisma.ledgerAccount.create({
      data: {
        code: "referral_payable.idr",
        name: "Referral Commission Payable (IDR)",
        type: LedgerAccountType.LIABILITY,
        currency: OrderCurrency.IDR,
        isActive: false,
      },
    });

    const report = await seedChartOfAccounts(prisma);

    // Whoever retired it already made the decision this report exists to ask for.
    expect(report.notInChart).toEqual([]);
  });
});
