/**
 * Ledger posting service (Financial Ledger M2) — `postFinancialTransaction`,
 * `getAccountBalance`, `trialBalance`.
 *
 * These tests are the only thing standing between the ledger and a silently
 * wrong set of books, because every invariant this service enforces is an
 * APPLICATION-layer invariant: the schema has no CHECK constraint for "amount
 * is positive", none for "entry.currency == account.currency", and Postgres
 * cannot express "debits equal credits per currency" (a cross-row aggregate)
 * at all. See LedgerEntry's own doc comment in prisma/schema.prisma. If this
 * file passes while the posting service is wrong, nothing else fails — the
 * books just quietly stop adding up, and every later milestone builds on them.
 *
 * Two properties get real-concurrency coverage rather than sequential awaits,
 * following packages/db/src/crud/wallet_concurrency.test.ts: the idempotency
 * key is what makes posting safe to retry against at-least-once payment rails
 * (webhooks redeliver, pollers re-check), and a check-then-insert guard that is
 * only ever tested sequentially proves nothing about two webhook deliveries
 * landing in the same millisecond.
 *
 * Deliberately NOT covered here: real order/payment/wallet/refund call sites
 * (that's `ledger_postings.test.ts`, exercising the same posting service
 * against real settlement paths). Any caching of the chart of accounts
 * genuinely does not exist anywhere in this branch — no milestone ended up
 * needing it. Reversals DO exist as of the whole-branch review's decision D5
 * (`reverseFinancialTransaction`) and are covered at the bottom of this file.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import { FinancialTransactionType, LedgerDirection, OrderCurrency } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { CHART_OF_ACCOUNTS, seedChartOfAccounts } from "./ledgerAccounts";
import {
  getAccountBalance,
  postFinancialTransaction,
  reverseFinancialTransaction,
  trialBalance,
  type LedgerEntryInput,
  type PostFinancialTransactionArgs,
} from "./ledger";

/**
 * How many calls each concurrent burst below fires at once. Same order of
 * magnitude as wallet_concurrency.test.ts's burst, for the same reason: enough
 * simultaneous writers that one of them must lose the race on
 * `ix_financial_tx_idempotency_key`.
 */
const CONCURRENCY = 10;

/** A fixed real-world event time, so `occurredAt` is asserted, not guessed. */
const OCCURRED_AT = new Date("2026-09-01T10:00:00.000Z");

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
  // Open CONCURRENCY pooled connections up front — a cold burst of concurrent
  // interactive transactions otherwise spends its whole `maxWait` queued on
  // Postgres backend setup and fails with P2028 before reaching the unique
  // index this suite is actually testing. Same warm-up, and same reason, as
  // wallet_concurrency.test.ts's.
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => prisma.$queryRaw`SELECT 1 AS ok FROM pg_sleep(0.05)`),
  );
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  // This file never calls `resetDb` (tests/helpers/sampleData.ts) — it does
  // touch the ledger tables since M3, but only this file's own manual cleanup
  // runs here. Children first: LedgerEntry → FinancialTransaction and →
  // LedgerAccount are both onDelete: Restrict (Infra-5 policy).
  await prisma.ledgerEntry.deleteMany();
  await prisma.financialTransaction.deleteMany();
  await prisma.ledgerAccount.deleteMany();
  await seedChartOfAccounts(prisma);
});

/** Row counts across both ledger tables — "nothing was written" in one shot. */
async function ledgerCounts(): Promise<{ transactions: number; entries: number }> {
  return {
    transactions: await prisma.financialTransaction.count(),
    entries: await prisma.ledgerEntry.count(),
  };
}

/** One entry, spelled out so each test reads as the accounting it describes. */
function dr(accountCode: string, amount: Decimal.Value, currency: string): LedgerEntryInput {
  return { accountCode, direction: LedgerDirection.DEBIT, amount, currency };
}
function cr(accountCode: string, amount: Decimal.Value, currency: string): LedgerEntryInput {
  return { accountCode, direction: LedgerDirection.CREDIT, amount, currency };
}

/** A complete, valid posting argument set with `entries` (and anything else) overridden. */
function postArgs(
  entries: LedgerEntryInput[],
  overrides: Partial<PostFinancialTransactionArgs> = {},
): PostFinancialTransactionArgs {
  return {
    type: FinancialTransactionType.ORDER_PAYMENT,
    referenceType: "payment",
    referenceId: 41,
    idempotencyKey: `ORDER_PAYMENT:payment:41:${Math.random()}`,
    description: "Buyer paid order ORD-1 through the gateway.",
    occurredAt: OCCURRED_AT,
    entries,
    ...overrides,
  };
}

/** The stored entries of one transaction, in a shape that is readable on failure. */
async function storedEntries(financialTransactionId: number) {
  const rows = await prisma.ledgerEntry.findMany({
    where: { financialTransactionId },
    include: { account: true },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => ({
    accountCode: r.account.code,
    direction: r.direction,
    amount: r.amount.toString(),
    currency: r.currency,
  }));
}

describe("postFinancialTransaction — happy path", () => {
  it("posts a balanced single-currency transaction and both accounts' balances follow", async () => {
    const posted = await postFinancialTransaction(
      prisma,
      postArgs([dr("provider_clearing.idr", "100000", "IDR"), cr("sales_revenue.idr", "100000", "IDR")], {
        idempotencyKey: "ORDER_PAYMENT:payment:41",
      }),
    );

    expect(posted.id).toBeGreaterThan(0);
    expect({
      type: posted.type,
      referenceType: posted.referenceType,
      referenceId: posted.referenceId,
      idempotencyKey: posted.idempotencyKey,
      description: posted.description,
      occurredAt: posted.occurredAt.toISOString(),
      reversalOfId: posted.reversalOfId,
    }).toEqual({
      type: FinancialTransactionType.ORDER_PAYMENT,
      referenceType: "payment",
      referenceId: 41,
      idempotencyKey: "ORDER_PAYMENT:payment:41",
      description: "Buyer paid order ORD-1 through the gateway.",
      occurredAt: OCCURRED_AT.toISOString(),
      // A REVERSAL's back-pointer: only `reverseFinancialTransaction` sets one,
      // and a normal posting must never carry it — `assertReversalShape` now
      // refuses the combination outright (see the reversal describe below).
      reversalOfId: null,
    });
    // `postedAt` is when the row was written here, `occurredAt` when the money
    // moved — the schema keeps them apart on purpose, so the service must not
    // collapse them.
    expect(posted.postedAt.getTime()).toBeGreaterThan(OCCURRED_AT.getTime());

    expect(await storedEntries(posted.id)).toEqual([
      { accountCode: "provider_clearing.idr", direction: "DEBIT", amount: "100000", currency: "IDR" },
      { accountCode: "sales_revenue.idr", direction: "CREDIT", amount: "100000", currency: "IDR" },
    ]);
    expect(await ledgerCounts()).toEqual({ transactions: 1, entries: 2 });

    // provider_clearing.idr is ASSET (debit-normal) so a DEBIT raises it;
    // sales_revenue.idr is REVENUE (credit-normal) so a CREDIT raises it. Both
    // read positive here — the sale is money owed to us and revenue earned.
    expect((await getAccountBalance(prisma, "provider_clearing.idr")).toString()).toBe("100000");
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe("100000");
  });

  it("accepts a multi-leg transaction where each currency balances on its own", async () => {
    // An IDR leg and a USDT leg in one posting. These are never summed against
    // each other — this shop holds two unconvertible balances, so "100000 IDR
    // == 6.25 USDT" is not a statement this codebase is ever allowed to make.
    const posted = await postFinancialTransaction(
      prisma,
      postArgs([
        dr("cash.idr", "100000", "IDR"),
        cr("provider_clearing.idr", "100000", "IDR"),
        dr("cash.usdt", "6.25", "USDT"),
        cr("provider_clearing.usdt", "6.25", "USDT"),
      ]),
    );

    expect(await storedEntries(posted.id)).toEqual([
      { accountCode: "cash.idr", direction: "DEBIT", amount: "100000", currency: "IDR" },
      { accountCode: "provider_clearing.idr", direction: "CREDIT", amount: "100000", currency: "IDR" },
      { accountCode: "cash.usdt", direction: "DEBIT", amount: "6.25", currency: "USDT" },
      { accountCode: "provider_clearing.usdt", direction: "CREDIT", amount: "6.25", currency: "USDT" },
    ]);
    expect((await getAccountBalance(prisma, "cash.idr")).toString()).toBe("100000");
    expect((await getAccountBalance(prisma, "cash.usdt")).toString()).toBe("6.25");
    // Both clearing accounts drained by the settlement: ASSET, debit-normal, so
    // the credit takes them negative against no prior debit.
    expect((await getAccountBalance(prisma, "provider_clearing.idr")).toString()).toBe("-100000");
    expect((await getAccountBalance(prisma, "provider_clearing.usdt")).toString()).toBe("-6.25");
  });

  it("accepts more than two legs in one currency as long as the two sides still agree", async () => {
    // The realistic fee shape: the gateway keeps 2500 of a 100000 sale, so one
    // credit is split across two debits.
    const posted = await postFinancialTransaction(
      prisma,
      postArgs([
        dr("cash.idr", "97500", "IDR"),
        dr("payment_fee.idr", "2500", "IDR"),
        cr("provider_clearing.idr", "100000", "IDR"),
      ]),
    );

    expect(await storedEntries(posted.id)).toHaveLength(3);
    // payment_fee.idr is EXPENSE (debit-normal): the fee we paid reads positive.
    expect((await getAccountBalance(prisma, "payment_fee.idr")).toString()).toBe("2500");
  });
});

describe("postFinancialTransaction — the double-entry invariant", () => {
  it("rejects an unbalanced single-currency posting and writes nothing", async () => {
    await expect(
      postFinancialTransaction(
        prisma,
        postArgs([dr("provider_clearing.idr", "100000", "IDR"), cr("sales_revenue.idr", "90000", "IDR")]),
      ),
    ).rejects.toMatchObject({ name: "ValidationError", key: "error.ledger_unbalanced" });

    // Proving the rejection happened BEFORE any write is the whole point: a
    // service that inserted the transaction and then threw would leave a
    // half-posted event in the books that nothing ever reconciles.
    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });

  it("rejects the WHOLE posting when one currency group is unbalanced, even if another balances", async () => {
    await expect(
      postFinancialTransaction(
        prisma,
        postArgs([
          // IDR balances...
          dr("cash.idr", "100000", "IDR"),
          cr("provider_clearing.idr", "100000", "IDR"),
          // ...USDT does not.
          dr("cash.usdt", "6.25", "USDT"),
          cr("provider_clearing.usdt", "5", "USDT"),
        ]),
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      key: "error.ledger_unbalanced",
      // The error names the offending currency and both sums, so an operator
      // reading a 422 or a log line can see which leg is wrong.
      formatArgs: { currency: OrderCurrency.USDT, debitTotal: "6.25", creditTotal: "5" },
    });

    // Not "the bad currency group was dropped" — nothing at all was written,
    // including the balanced IDR leg.
    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });

  it("never treats one currency's debits as covering another currency's credits", async () => {
    // Numerically "balanced" only if IDR and USDT are summed together, which is
    // exactly the mistake this ledger must never make.
    await expect(
      postFinancialTransaction(prisma, postArgs([dr("cash.idr", "100", "IDR"), cr("sales_revenue.usdt", "100", "USDT")])),
    ).rejects.toMatchObject({ name: "ValidationError", key: "error.ledger_unbalanced" });

    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });
});

describe("postFinancialTransaction — entry validation", () => {
  it("rejects an empty entries array", async () => {
    await expect(postFinancialTransaction(prisma, postArgs([]))).rejects.toMatchObject({
      name: "ValidationError",
      key: "error.ledger_entries_empty",
    });
    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });

  it.each([
    ["zero", "0"],
    ["negative", "-100"],
    ["malformed", "not a number"],
    ["not finite", "Infinity"],
    // Below the 4-decimal precision every money value in this repo is
    // quantized to (@app/core/money): it would be stored as 0, silently
    // breaking LedgerEntry's "amount is always positive" invariant.
    ["vanishing at 4 decimal places", "0.00001"],
  ])("rejects a %s amount", async (_label, amount) => {
    await expect(
      postFinancialTransaction(prisma, postArgs([dr("cash.idr", amount, "IDR"), cr("sales_revenue.idr", amount, "IDR")])),
    ).rejects.toMatchObject({ name: "ValidationError", key: "error.ledger_amount_invalid" });
    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });

  it("rejects an entry whose currency disagrees with its own account's currency", async () => {
    await expect(
      postFinancialTransaction(
        prisma,
        postArgs([dr("cash.idr", "100", "USDT"), cr("sales_revenue.usdt", "100", "USDT")]),
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      key: "error.ledger_currency_mismatch",
      formatArgs: { accountCode: "cash.idr", entryCurrency: "USDT", accountCurrency: "IDR" },
    });
    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });

  it("rejects an account code that is not in the chart of accounts", async () => {
    await expect(
      postFinancialTransaction(
        prisma,
        postArgs([dr("petty_cash.idr", "100", "IDR"), cr("sales_revenue.idr", "100", "IDR")]),
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      key: "error.ledger_account_not_found",
      formatArgs: { accountCode: "petty_cash.idr" },
    });
    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });

  it("rejects a posting to a RETIRED account, not just hides it from the trial balance", async () => {
    // `isActive` used to be enforced on the read side only: `trialBalance` omitted
    // a retired account while this service happily kept posting to it. That is the
    // worst of both worlds — the entries are written and counted by
    // `getAccountBalance`, but land on an account the trial balance does not show,
    // so the posting silently stops adding up to the reported cash position
    // (whole-branch review C6).
    await prisma.ledgerAccount.update({
      where: { code: "cash.idr" },
      data: { isActive: false },
    });

    await expect(
      postFinancialTransaction(
        prisma,
        postArgs([dr("cash.idr", "100", "IDR"), cr("sales_revenue.idr", "100", "IDR")]),
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      key: "error.ledger_account_retired",
      formatArgs: { accountCode: "cash.idr" },
    });
    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });

  it("rejects a posting to an account whose type no reader can assign a sign to", async () => {
    // `type` is a free String column, so a row from an older chart, a restored
    // dump or a hand edit can carry a value `signedBalance` throws on. Checked at
    // WRITE time now: catching it only on read meant the entry was already
    // committed by the time anyone found out, leaving the books holding a row
    // that cannot be reported at all (whole-branch review C6).
    await prisma.ledgerAccount.update({
      where: { code: "cash.idr" },
      data: { type: "PETTY_CASH" },
    });

    await expect(
      postFinancialTransaction(
        prisma,
        postArgs([dr("cash.idr", "100", "IDR"), cr("sales_revenue.idr", "100", "IDR")]),
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      key: "error.ledger_account_type_unknown",
      formatArgs: { accountCode: "cash.idr", accountType: "PETTY_CASH" },
    });
    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });

  it("still accepts every type the balance readers understand", async () => {
    // The write-side check must be exactly the union of the two normal-balance
    // lists, not a narrower hand-kept copy — a posting this service accepts has to
    // be one `signedBalance` can read back, and vice versa. `adjustment.idr` is
    // EQUITY and `referral_expense.usdt` is EXPENSE, so between them these cover
    // both sides of that union beyond the ASSET/REVENUE pair every other test uses.
    const posted = await postFinancialTransaction(
      prisma,
      postArgs([dr("adjustment.idr", "100", "IDR"), cr("wallet_liability.idr", "100", "IDR")]),
    );
    expect(posted.id).toBeGreaterThan(0);
    expect(await getAccountBalance(prisma, "adjustment.idr")).toBeTruthy();
  });

  it("rejects a direction that is neither DEBIT nor CREDIT", async () => {
    // A typo'd direction is the one bad input the balance check cannot catch on
    // its own: an unrecognised direction belongs to neither sum, so 0 == 0 and
    // a posting that moves money nowhere would look perfectly balanced.
    await expect(
      postFinancialTransaction(
        prisma,
        postArgs([
          { accountCode: "cash.idr", direction: "DEBIT " as unknown as LedgerDirection, amount: "100", currency: "IDR" },
          cr("sales_revenue.idr", "100", "IDR"),
        ]),
      ),
    ).rejects.toMatchObject({ name: "ValidationError", key: "error.ledger_direction_invalid" });
    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });

  it("rejects a blank idempotency key", async () => {
    // An empty key is not "no key": it is a key every other blank-key caller
    // shares, so the second such posting would be handed an unrelated
    // transaction as its own idempotent replay.
    await expect(
      postFinancialTransaction(
        prisma,
        postArgs([dr("cash.idr", "100", "IDR"), cr("sales_revenue.idr", "100", "IDR")], { idempotencyKey: "  " }),
      ),
    ).rejects.toMatchObject({ name: "ValidationError", key: "error.ledger_idempotency_key_required" });
    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });
});

describe("postFinancialTransaction — idempotency", () => {
  it("returns the first posting unchanged when the same key is posted again with different entries", async () => {
    const key = "ORDER_PAYMENT:payment:77";
    const first = await postFinancialTransaction(
      prisma,
      postArgs([dr("provider_clearing.idr", "100000", "IDR"), cr("sales_revenue.idr", "100000", "IDR")], {
        idempotencyKey: key,
      }),
    );

    // Deliberately different entries, a different reference and a different
    // description: if any of it lands, the "same key = one economic effect"
    // guarantee is broken, and a redelivered webhook could rewrite history.
    const second = await postFinancialTransaction(
      prisma,
      postArgs([dr("cash.idr", "999", "IDR"), cr("adjustment.idr", "999", "IDR")], {
        idempotencyKey: key,
        referenceId: 78,
        description: "A second delivery of the same webhook.",
      }),
    );

    expect(second.id).toBe(first.id);
    expect(second.referenceId).toBe(41);
    expect(second.description).toBe("Buyer paid order ORD-1 through the gateway.");
    expect(await ledgerCounts()).toEqual({ transactions: 1, entries: 2 });
    expect(await storedEntries(first.id)).toEqual([
      { accountCode: "provider_clearing.idr", direction: "DEBIT", amount: "100000", currency: "IDR" },
      { accountCode: "sales_revenue.idr", direction: "CREDIT", amount: "100000", currency: "IDR" },
    ]);
    // The second call's accounts were never touched at all.
    expect((await getAccountBalance(prisma, "cash.idr")).toString()).toBe("0");
    expect((await getAccountBalance(prisma, "adjustment.idr")).toString()).toBe("0");
  });

  it(`${CONCURRENCY} concurrent posts of the same key all succeed and produce exactly one transaction`, async () => {
    const key = "ORDER_PAYMENT:payment:99";
    const entries = [dr("cash.idr", "250000", "IDR"), cr("wallet_liability.idr", "250000", "IDR")];

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        postFinancialTransaction(prisma, postArgs(entries, { idempotencyKey: key })),
      ),
    );

    // Surface WHY on failure — a bare length assertion loses the rejection.
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected.length > 0) {
      throw new Error(
        `Expected all ${CONCURRENCY} concurrent posts to resolve (create or reclaim); ${rejected.length} rejected: ${JSON.stringify(rejected.map((r) => String(r.reason)))}`,
      );
    }
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof postFinancialTransaction>>> =>
        r.status === "fulfilled",
    );

    // Every caller got the SAME row back: the losers of the race reclaimed the
    // winner's transaction instead of throwing a raw P2002 at a webhook handler.
    expect(new Set(fulfilled.map((r) => r.value.id)).size).toBe(1);
    expect(await prisma.financialTransaction.count({ where: { idempotencyKey: key } })).toBe(1);
    // One economic effect, not CONCURRENCY of them — the entries of a rolled
    // back racer must not survive either.
    expect(await ledgerCounts()).toEqual({ transactions: 1, entries: 2 });
    expect((await getAccountBalance(prisma, "cash.idr")).toString()).toBe("250000");
  });

  it(`${CONCURRENCY} concurrent posts of DIFFERENT keys are not serialized away`, async () => {
    // Sanity control for the test above: the idempotency guard must reject
    // duplicates without also swallowing unrelated concurrent postings.
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        postFinancialTransaction(
          prisma,
          postArgs([dr("cash.idr", "1000", "IDR"), cr("adjustment.idr", "1000", "IDR")], {
            type: FinancialTransactionType.ADJUSTMENT,
            referenceType: "manual",
            referenceId: i + 1,
            idempotencyKey: `ADJUSTMENT:manual:${i + 1}`,
            description: `Manual opening adjustment ${i + 1}.`,
          }),
        ),
      ),
    );

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected.length > 0) {
      throw new Error(
        `Expected all ${CONCURRENCY} distinct concurrent posts to succeed; ${rejected.length} rejected: ${JSON.stringify(rejected.map((r) => String(r.reason)))}`,
      );
    }

    expect(await ledgerCounts()).toEqual({ transactions: CONCURRENCY, entries: CONCURRENCY * 2 });
    expect((await getAccountBalance(prisma, "cash.idr")).toString()).toBe(String(1000 * CONCURRENCY));
    // adjustment.idr is EQUITY (credit-normal), so its credits read positive.
    expect((await getAccountBalance(prisma, "adjustment.idr")).toString()).toBe(String(1000 * CONCURRENCY));
  });
});

describe("getAccountBalance", () => {
  it("reads a debit-normal and a credit-normal account with opposite signs from the same entries", async () => {
    // A wallet top-up: cash comes in (ASSET, debit-normal) and the shop now
    // owes the buyer that credit (LIABILITY, credit-normal). Both balances are
    // positive, which is only true because the sign convention differs by type.
    await postFinancialTransaction(
      prisma,
      postArgs([dr("cash.idr", "100000", "IDR"), cr("wallet_liability.idr", "100000", "IDR")], {
        type: FinancialTransactionType.WALLET_DEPOSIT,
        referenceType: "wallet_topup",
        idempotencyKey: "WALLET_DEPOSIT:wallet_topup:1",
      }),
    );
    expect((await getAccountBalance(prisma, "cash.idr")).toString()).toBe("100000");
    expect((await getAccountBalance(prisma, "wallet_liability.idr")).toString()).toBe("100000");

    // The buyer now spends 30000 of that credit: the liability is DEBITed, and
    // a debit to a credit-normal account must DECREASE it.
    await postFinancialTransaction(
      prisma,
      postArgs([dr("wallet_liability.idr", "30000", "IDR"), cr("sales_revenue.idr", "30000", "IDR")], {
        idempotencyKey: "ORDER_PAYMENT:order:2",
        referenceType: "order",
      }),
    );
    expect((await getAccountBalance(prisma, "wallet_liability.idr")).toString()).toBe("70000");
    // cash.idr is untouched by the spend — the money is already in the shop.
    expect((await getAccountBalance(prisma, "cash.idr")).toString()).toBe("100000");
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe("30000");
  });

  it("takes a debit-normal account negative when it is credited beyond its debits", async () => {
    await postFinancialTransaction(
      prisma,
      postArgs([dr("wallet_liability.idr", "50000", "IDR"), cr("cash.idr", "50000", "IDR")], {
        type: FinancialTransactionType.WALLET_WITHDRAWAL,
        idempotencyKey: "WALLET_WITHDRAWAL:wallet_topup:3",
      }),
    );
    // A signed balance, not an absolute one: an ASSET account with more credits
    // than debits is genuinely negative, and hiding that would hide the bug.
    expect((await getAccountBalance(prisma, "cash.idr")).toString()).toBe("-50000");
    expect((await getAccountBalance(prisma, "wallet_liability.idr")).toString()).toBe("-50000");
  });

  it("returns zero for a seeded account with no entries", async () => {
    expect((await getAccountBalance(prisma, "refund_clearing.idr")).toString()).toBe("0");
  });

  it("rejects an unknown account code", async () => {
    await expect(getAccountBalance(prisma, "petty_cash.idr")).rejects.toMatchObject({
      name: "ValidationError",
      key: "error.ledger_account_not_found",
      formatArgs: { accountCode: "petty_cash.idr" },
    });
  });
});

describe("trialBalance", () => {
  it("returns every active account of the requested currency, with balances matching getAccountBalance", async () => {
    await postFinancialTransaction(
      prisma,
      postArgs([dr("provider_clearing.idr", "100000", "IDR"), cr("sales_revenue.idr", "100000", "IDR")], {
        idempotencyKey: "ORDER_PAYMENT:payment:101",
      }),
    );
    await postFinancialTransaction(
      prisma,
      postArgs([
        dr("cash.idr", "97500", "IDR"),
        dr("payment_fee.idr", "2500", "IDR"),
        cr("provider_clearing.idr", "100000", "IDR"),
      ], {
        type: FinancialTransactionType.SETTLEMENT,
        referenceType: "manual",
        idempotencyKey: "SETTLEMENT:manual:101",
      }),
    );
    // A USDT posting that must not leak into the IDR trial balance.
    await postFinancialTransaction(
      prisma,
      postArgs([dr("cash.usdt", "6.25", "USDT"), cr("sales_revenue.usdt", "6.25", "USDT")], {
        idempotencyKey: "ORDER_PAYMENT:payment:102",
      }),
    );

    const rows = await trialBalance(prisma, OrderCurrency.IDR);

    const idrCodes = CHART_OF_ACCOUNTS.filter((a) => a.currency === OrderCurrency.IDR).map((a) => a.code).sort();
    expect(idrCodes).toHaveLength(8);
    expect(rows.map((r) => r.accountCode).sort()).toEqual(idrCodes);
    // No USDT account may appear, however much was posted to one.
    expect(rows.some((r) => r.currency !== OrderCurrency.IDR)).toBe(false);

    // Every row agrees with what getAccountBalance says on its own — the two
    // functions share one sign convention rather than each carrying a copy.
    for (const row of rows) {
      const alone = await getAccountBalance(prisma, row.accountCode);
      expect(row.balance.toString(), `trialBalance disagrees with getAccountBalance on ${row.accountCode}`).toBe(
        alone.toString(),
      );
      const seeded = CHART_OF_ACCOUNTS.find((a) => a.code === row.accountCode);
      expect(row.accountType).toBe(seeded?.type);
    }

    const byCode = new Map(rows.map((r) => [r.accountCode, r.balance.toString()] as const));
    expect(byCode.get("cash.idr")).toBe("97500");
    expect(byCode.get("payment_fee.idr")).toBe("2500");
    expect(byCode.get("sales_revenue.idr")).toBe("100000");
    // Received in full and settled in full, so the clearing account is back to
    // zero — the property that makes a stuck balance here a real signal.
    expect(byCode.get("provider_clearing.idr")).toBe("0");
    expect(byCode.get("refund_clearing.idr")).toBe("0");

    // The books balance as a whole: for a set of postings each balanced per
    // currency, the debit-normal and credit-normal totals must agree.
    const debitNormal = ["ASSET", "EXPENSE", "CLEARING"];
    const totals = rows.reduce(
      (acc, r) =>
        debitNormal.includes(r.accountType) ? { ...acc, debit: acc.debit.plus(r.balance) } : { ...acc, credit: acc.credit.plus(r.balance) },
      { debit: new Decimal(0), credit: new Decimal(0) },
    );
    expect(totals.debit.toString()).toBe(totals.credit.toString());
  });

  it("omits an account an admin retired", async () => {
    await prisma.ledgerAccount.update({ where: { code: "refund_clearing.idr" }, data: { isActive: false } });

    const rows = await trialBalance(prisma, OrderCurrency.IDR);

    expect(rows.map((r) => r.accountCode)).not.toContain("refund_clearing.idr");
    expect(rows).toHaveLength(7);
  });

  it("returns an empty list for a currency with no accounts", async () => {
    await expect(trialBalance(prisma, "EUR")).resolves.toEqual([]);
  });
});

describe("ValidationError shape", () => {
  it("throws the repo's ValidationError class, not a bare Error", async () => {
    // The web layer distinguishes a 422 from a 500 by this class (and its
    // `key`, which humanize() resolves against packages/core/locales).
    await expect(postFinancialTransaction(prisma, postArgs([]))).rejects.toBeInstanceOf(ValidationError);
  });
});

/**
 * `reverseFinancialTransaction` (whole-branch review decision D5) — the only
 * supported way to undo a posting.
 *
 * What these tests actually protect: the ledger is append-only and raw SQL
 * against its two tables is forbidden, so if this function mirrors a posting
 * incorrectly there is no second mechanism to catch it — the correction itself
 * becomes the error, and every account it touched is then wrong in a way a trial
 * balance still shows as perfectly balanced.
 */
describe("reverseFinancialTransaction", () => {
  /** A posted ORDER_PAYMENT to reverse: one IDR group, deliberately three legs. */
  async function postOriginal(overrides: Partial<PostFinancialTransactionArgs> = {}) {
    return postFinancialTransaction(
      prisma,
      postArgs(
        [
          dr("cash.idr", "97500", "IDR"),
          dr("payment_fee.idr", "2500", "IDR"),
          cr("sales_revenue.idr", "100000", "IDR"),
        ],
        { idempotencyKey: "ORDER_PAYMENT:payment:41", ...overrides },
      ),
    );
  }

  it("mirrors every entry, keeps the original's occurredAt, and nets each account to zero", async () => {
    const original = await postOriginal();

    const reversal = await reverseFinancialTransaction(prisma, {
      originalId: original.id,
      reason: "The TokoPay webhook was redelivered under a new reference and posted this sale twice.",
    });

    expect({
      type: reversal.type,
      referenceType: reversal.referenceType,
      referenceId: reversal.referenceId,
      idempotencyKey: reversal.idempotencyKey,
      reversalOfId: reversal.reversalOfId,
      // The original's own event time, NOT now: a period report reads
      // `occurredAt`, so a reversal stamped today would move the original's
      // revenue out of the month it was earned in.
      occurredAt: reversal.occurredAt.toISOString(),
    }).toEqual({
      type: FinancialTransactionType.REVERSAL,
      referenceType: "payment",
      referenceId: 41,
      idempotencyKey: `reversal:${original.id}`,
      reversalOfId: original.id,
      occurredAt: OCCURRED_AT.toISOString(),
    });
    // The reason is quoted verbatim into admin-facing prose, alongside the
    // original's own description, so the ledger view explains itself.
    expect(reversal.description).toContain("The TokoPay webhook was redelivered");
    expect(reversal.description).toContain(`Reversed financial transaction ${original.id}`);

    // Same accounts, same amounts, opposite sides — never a negated amount,
    // which LedgerEntry's "amount is always positive" invariant forbids.
    expect(await storedEntries(reversal.id)).toEqual([
      { accountCode: "cash.idr", direction: "CREDIT", amount: "97500", currency: "IDR" },
      { accountCode: "payment_fee.idr", direction: "CREDIT", amount: "2500", currency: "IDR" },
      { accountCode: "sales_revenue.idr", direction: "DEBIT", amount: "100000", currency: "IDR" },
    ]);

    // The whole point: every account the original touched is back where it was.
    for (const code of ["cash.idr", "payment_fee.idr", "sales_revenue.idr"]) {
      expect((await getAccountBalance(prisma, code)).toString(), code).toBe("0");
    }
    // And the original is still there — a reversal adds, it never edits.
    expect(await ledgerCounts()).toEqual({ transactions: 2, entries: 6 });
    await expect(
      prisma.financialTransaction.findUnique({ where: { id: original.id } }),
    ).resolves.toMatchObject({ type: FinancialTransactionType.ORDER_PAYMENT, reversalOfId: null });
  });

  it("mirrors a multi-currency posting within each currency", async () => {
    const original = await postFinancialTransaction(
      prisma,
      postArgs(
        [
          dr("provider_clearing.idr", "50000", "IDR"),
          cr("sales_revenue.idr", "50000", "IDR"),
          dr("wallet_liability.usdt", "3.25", "USDT"),
          cr("sales_revenue.usdt", "3.25", "USDT"),
        ],
        { idempotencyKey: "ORDER_PAYMENT:payment:77" },
      ),
    );

    const reversal = await reverseFinancialTransaction(prisma, {
      originalId: original.id,
      reason: "The order was never actually paid; the poller matched an unrelated deposit.",
    });

    expect(await storedEntries(reversal.id)).toEqual([
      { accountCode: "provider_clearing.idr", direction: "CREDIT", amount: "50000", currency: "IDR" },
      { accountCode: "sales_revenue.idr", direction: "DEBIT", amount: "50000", currency: "IDR" },
      { accountCode: "wallet_liability.usdt", direction: "CREDIT", amount: "3.25", currency: "USDT" },
      { accountCode: "sales_revenue.usdt", direction: "DEBIT", amount: "3.25", currency: "USDT" },
    ]);
    for (const code of [
      "provider_clearing.idr",
      "sales_revenue.idr",
      "wallet_liability.usdt",
      "sales_revenue.usdt",
    ]) {
      expect((await getAccountBalance(prisma, code)).toString(), code).toBe("0");
    }
  });

  it("is idempotent: reversing twice returns the same reversal and posts nothing new", async () => {
    const original = await postOriginal();

    const first = await reverseFinancialTransaction(prisma, {
      originalId: original.id,
      reason: "Duplicate posting.",
    });
    const second = await reverseFinancialTransaction(prisma, {
      originalId: original.id,
      reason: "Duplicate posting.",
    });

    // A replay must NOT be rejected by the already-reversed guard — an operator
    // re-running a correction script is ordinary, and the deterministic key is
    // what makes it safe.
    expect(second.id).toBe(first.id);
    expect(await ledgerCounts()).toEqual({ transactions: 2, entries: 6 });
  });

  it("produces exactly one reversal under a concurrent burst against the same transaction", async () => {
    const original = await postOriginal();

    // Several writers can pass the pre-checks before any of them commits; the
    // losers hit `ix_financial_tx_idempotency_key` and are handed the winner's
    // row. Tested concurrently rather than sequentially for the same reason the
    // idempotency tests above are: a check-then-insert guard proves nothing
    // under a sequential await.
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        reverseFinancialTransaction(prisma, { originalId: original.id, reason: "Duplicate posting." }),
      ),
    );
    const ids = new Set(results.flatMap((r) => (r.status === "fulfilled" ? [r.value.id] : [])));

    // At most one distinct reversal id however many callers succeeded, and
    // exactly one row in the table — a caller that lost the race either got the
    // winner's row back or failed outright, never wrote a second cancellation.
    expect(ids.size).toBeLessThanOrEqual(1);
    expect(await prisma.financialTransaction.count({ where: { reversalOfId: original.id } })).toBe(1);
    expect(await ledgerCounts()).toEqual({ transactions: 2, entries: 6 });
  });

  it("refuses to reverse a reversal, and writes nothing", async () => {
    const original = await postOriginal();
    const reversal = await reverseFinancialTransaction(prisma, {
      originalId: original.id,
      reason: "Duplicate posting.",
    });
    const before = await ledgerCounts();

    await expect(
      reverseFinancialTransaction(prisma, { originalId: reversal.id, reason: "Changed my mind." }),
    ).rejects.toMatchObject({ key: "error.ledger_cannot_reverse_a_reversal" });
    expect(await ledgerCounts()).toEqual(before);
  });

  it("refuses a second reversal of an already-reversed transaction, even under a caller's own key", async () => {
    const original = await postOriginal();
    await reverseFinancialTransaction(prisma, { originalId: original.id, reason: "Duplicate posting." });
    const before = await ledgerCounts();

    // A fresh key sidesteps the deterministic-key replay, which is exactly the
    // case the already-reversed read exists for: without it, this would double
    // the cancellation and leave every account wrong by the original amount in
    // the opposite direction.
    await expect(
      reverseFinancialTransaction(prisma, {
        originalId: original.id,
        reason: "Trying again.",
        idempotencyKey: `reversal:${original.id}:again`,
      }),
    ).rejects.toMatchObject({ key: "error.ledger_already_reversed" });
    expect(await ledgerCounts()).toEqual(before);
  });

  it("refuses an id that names no transaction", async () => {
    await expect(
      reverseFinancialTransaction(prisma, { originalId: 987654, reason: "Nothing to see." }),
    ).rejects.toMatchObject({ key: "error.ledger_transaction_not_found" });
    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });

  it("refuses to mirror an entry on an account an admin has since retired", async () => {
    const original = await postOriginal();
    await prisma.ledgerAccount.update({ where: { code: "payment_fee.idr" }, data: { isActive: false } });
    const before = await ledgerCounts();

    // Not a special case in the reversal path: `prepareEntries` refuses a write
    // to a retired account for every posting, and a reversal is a posting. The
    // refusal is the honest outcome — reviving the account is an accounting
    // decision, not something a correction may make silently.
    await expect(
      reverseFinancialTransaction(prisma, { originalId: original.id, reason: "Duplicate posting." }),
    ).rejects.toMatchObject({ key: "error.ledger_account_retired" });
    expect(await ledgerCounts()).toEqual(before);
  });

  it("accepts a caller's transaction, so a reversal can be part of a larger correction", async () => {
    const original = await postOriginal();

    const reversal = await prisma.$transaction((tx) =>
      reverseFinancialTransaction(tx, { originalId: original.id, reason: "Duplicate posting." }),
    );

    expect(reversal.reversalOfId).toBe(original.id);
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe("0");
  });
});

describe("postFinancialTransaction — REVERSAL shape", () => {
  it("refuses a REVERSAL with no reversalOfId", async () => {
    await expect(
      postFinancialTransaction(
        prisma,
        postArgs([dr("cash.idr", "1000", "IDR"), cr("sales_revenue.idr", "1000", "IDR")], {
          type: FinancialTransactionType.REVERSAL,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.ledger_reversal_shape_invalid" });
    expect(await ledgerCounts()).toEqual({ transactions: 0, entries: 0 });
  });

  it("refuses a non-REVERSAL carrying a reversalOfId", async () => {
    const original = await postFinancialTransaction(
      prisma,
      postArgs([dr("cash.idr", "1000", "IDR"), cr("sales_revenue.idr", "1000", "IDR")], {
        idempotencyKey: "ORDER_PAYMENT:payment:9",
      }),
    );

    await expect(
      postFinancialTransaction(
        prisma,
        postArgs([dr("cash.idr", "1000", "IDR"), cr("sales_revenue.idr", "1000", "IDR")], {
          idempotencyKey: "ORDER_PAYMENT:payment:10",
          reversalOfId: original.id,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.ledger_reversal_shape_invalid" });
    expect(await prisma.financialTransaction.count()).toBe(1);
  });
});
