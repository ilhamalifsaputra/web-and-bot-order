/**
 * Settlement ingestion (task F1) — the caller `postSettlementPosting` shipped
 * without (decision D1, known gap 6 in docs/FINANCE_ARCHITECTURE.md).
 *
 * What these tests are really about is the ATOMICITY of three writes that must
 * agree or not happen: the `Settlement` row, its `SettlementTransaction` lines,
 * and the `SETTLEMENT` ledger posting that drains `provider_clearing` into
 * `cash`. A batch row with no posting leaves `cash.*` understated forever (the
 * ledger is append-only, so nothing later notices); a posting with no batch row
 * leaves an admin unable to find what the entry describes. So every refusal case
 * below asserts that NOTHING was written, not merely that an error was raised.
 *
 * The amount arithmetic itself belongs to `postSettlementPosting` and is covered
 * in `ledger_postings.test.ts`; what is re-asserted here is that this service
 * refuses an inconsistent batch BEFORE writing rather than relying on the
 * posting to reject it after — and that when it does rely on the posting (a
 * shape only the posting can judge), the rollback is real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import {
  FinancialTransactionType,
  LedgerDirection,
  PaymentMethod,
  SettlementStatus,
} from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  getAccountBalance,
  listSettlements,
  recordSettlement,
} from "@app/db";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

/** A REAL admin row's id: the audit row this service writes carries an
 *  `admin_id` foreign key, so an invented number aborts the whole transaction —
 *  which is itself the atomicity these tests are about. */
let ADMIN_ID: number;
/** A fixed provider date, so the posting's `occurredAt` is asserted against the
 *  batch's own date rather than the moment the test keyed it in. */
const SETTLED_AT = new Date("2026-09-01T00:00:00.000Z");

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
  const admin = await prisma.user.create({
    data: {
      telegramId: 999_001,
      username: "settlement-admin",
      fullName: "Settlement Admin",
      role: "ADMIN",
      referralCode: `s${Math.random()}`,
    },
  });
  ADMIN_ID = admin.id;
  baseBatch.adminId = ADMIN_ID;
});

/** Debits equal credits inside every currency of one posting — the property a
 *  settlement exists to preserve while moving money between two asset accounts. */
async function expectBalanced(financialTransactionId: number) {
  const rows = await prisma.ledgerEntry.findMany({
    where: { financialTransactionId },
    include: { account: true },
  });
  const sums = new Map<string, { debit: Decimal; credit: Decimal }>();
  for (const row of rows) {
    const sum = sums.get(row.currency) ?? { debit: new Decimal(0), credit: new Decimal(0) };
    if (row.direction === LedgerDirection.DEBIT) sum.debit = sum.debit.plus(new Decimal(row.amount));
    else sum.credit = sum.credit.plus(new Decimal(row.amount));
    sums.set(row.currency, sum);
  }
  expect(sums.size, "a posting with no entries is not a posting").toBeGreaterThan(0);
  for (const [currency, sum] of sums) {
    expect(sum.debit.toString(), `debits != credits in ${currency}`).toBe(sum.credit.toString());
  }
}

/** Nothing at all was written — the assertion every refusal below shares. */
async function expectNothingWritten() {
  expect(await prisma.settlement.count()).toBe(0);
  expect(await prisma.settlementTransaction.count()).toBe(0);
  expect(await prisma.financialTransaction.count()).toBe(0);
  expect(await prisma.auditLog.count()).toBe(0);
}

/** A PENDING order with a PENDING `Payment` carrying `providerTransactionId`,
 *  so a settlement line has something real to match against. */
async function makePayableOrder(providerTransactionId: string) {
  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
  const order = await createOrderDirect(prisma, {
    user: { id: buyer.id, role: buyer.role, walletBalance: buyer.walletBalance },
    productId: sample.product.id,
    quantity: 1,
  });
  const payment = await prisma.payment.create({
    data: {
      orderId: order!.id,
      method: PaymentMethod.TOKOPAY,
      amount: order!.totalAmount,
      currency: order!.currency,
      status: "PENDING",
      providerTransactionId,
    },
  });
  return { order: order!, payment };
}

const baseBatch: {
  provider: string;
  batchReference: string | null;
  settlementDate: Date;
  currency: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  adminId: number;
} = {
  provider: PaymentMethod.TOKOPAY,
  batchReference: "STMT-2026-09-01",
  settlementDate: SETTLED_AT,
  currency: "IDR",
  grossAmount: "1000000",
  feeAmount: "23500",
  netAmount: "976500",
  adminId: 0, // replaced per test by `beforeEach` with a real admin row's id
};

describe("recordSettlement", () => {
  it("writes the batch, its lines and the ledger posting in one go", async () => {
    const result = await recordSettlement(prisma, {
      ...baseBatch,
      lines: [{ amount: "600000" }, { amount: "400000" }],
    });

    const settlement = await prisma.settlement.findUniqueOrThrow({
      where: { id: result.settlement.id },
    });
    expect(settlement.provider).toBe(PaymentMethod.TOKOPAY);
    expect(settlement.batchReference).toBe("STMT-2026-09-01");
    expect(settlement.status).toBe(SettlementStatus.RECORDED);
    expect(settlement.createdBy).toBe(ADMIN_ID);
    expect(new Decimal(settlement.grossAmount).toString()).toBe("1000000");
    expect(new Decimal(settlement.feeAmount).toString()).toBe("23500");
    expect(new Decimal(settlement.netAmount).toString()).toBe("976500");
    // UTC as stored, the provider's own date — never the import time.
    expect(settlement.settlementDate.toISOString()).toBe(SETTLED_AT.toISOString());

    const lines = await prisma.settlementTransaction.findMany({
      where: { settlementId: settlement.id },
      orderBy: { id: "asc" },
    });
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => new Decimal(l.amount).toString())).toEqual(["600000", "400000"]);
    // An unmatched line carries no payment and no match timestamp — the single
    // most important shape this table has to be able to hold.
    expect(lines.every((l) => l.paymentId === null && l.matchedAt === null)).toBe(true);
    expect(lines.every((l) => l.currency === "IDR")).toBe(true);

    const posting = await prisma.financialTransaction.findUniqueOrThrow({
      where: { idempotencyKey: `settlement:${settlement.id}` },
    });
    expect(posting.type).toBe(FinancialTransactionType.SETTLEMENT);
    expect(posting.referenceType).toBe("settlement");
    expect(posting.referenceId).toBe(settlement.id);
    expect(posting.occurredAt.toISOString()).toBe(SETTLED_AT.toISOString());
    await expectBalanced(posting.id);
    expect(result.posting?.id).toBe(posting.id);
  });

  it("moves cash up and provider_clearing down by the amounts the batch reports", async () => {
    const clearingBefore = await getAccountBalance(prisma, "provider_clearing.idr");
    const cashBefore = await getAccountBalance(prisma, "cash.idr");
    const feeBefore = await getAccountBalance(prisma, "payment_fee.idr");

    await recordSettlement(prisma, { ...baseBatch, lines: [] });

    // `cash.*` is DEBIT-normal and rises by the net; `provider_clearing.*` is
    // debit-normal too, so draining it by the gross shows as a FALL of the gross.
    expect(
      (await getAccountBalance(prisma, "cash.idr")).minus(cashBefore).toString(),
    ).toBe("976500");
    expect(
      (await getAccountBalance(prisma, "provider_clearing.idr")).minus(clearingBefore).toString(),
    ).toBe("-1000000");
    expect(
      (await getAccountBalance(prisma, "payment_fee.idr")).minus(feeBefore).toString(),
    ).toBe("23500");
  });

  it("matches a line to the Payment whose provider transaction id it names", async () => {
    const { payment } = await makePayableOrder("TP-12345");

    const { settlement } = await recordSettlement(prisma, {
      ...baseBatch,
      lines: [{ amount: "600000", providerTransactionId: "TP-12345" }, { amount: "400000" }],
    });

    const lines = await prisma.settlementTransaction.findMany({
      where: { settlementId: settlement.id },
      orderBy: { id: "asc" },
    });
    expect(lines[0]!.paymentId).toBe(payment.id);
    expect(lines[0]!.matchedAt).not.toBeNull();
    // The second line named nothing, so it stays unmatched rather than being
    // guessed at.
    expect(lines[1]!.paymentId).toBeNull();
    expect(lines[1]!.matchedAt).toBeNull();
  });

  it("leaves a line unmatched when the provider transaction id matches no Payment", async () => {
    const { settlement } = await recordSettlement(prisma, {
      ...baseBatch,
      lines: [{ amount: "1000000", providerTransactionId: "TP-NOBODY-HAS-THIS" }],
    });

    const line = await prisma.settlementTransaction.findFirstOrThrow({
      where: { settlementId: settlement.id },
    });
    expect(line.paymentId).toBeNull();
    expect(line.matchedAt).toBeNull();
    // Recorded, not refused: a provider reporting money this shop has no Payment
    // row for is precisely the discrepancy reconciliation exists to surface.
    expect(new Decimal(line.amount).toString()).toBe("1000000");
  });

  it("writes one audit row, in natural language, naming the amounts an admin can check", async () => {
    const { settlement } = await recordSettlement(prisma, { ...baseBatch, lines: [{ amount: "1000000" }] });

    const rows = await prisma.auditLog.findMany({ where: { targetType: "settlement" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.adminId).toBe(ADMIN_ID);
    expect(rows[0]!.targetId).toBe(settlement.id);
    expect(rows[0]!.details).toContain("1000000");
    expect(rows[0]!.details).toContain("976500");
    expect(rows[0]!.details).toContain("23500");
    // Shop-admin prose, never key=value shorthand (docs/LOGGING.md).
    expect(rows[0]!.details).not.toMatch(/=/);
  });

  it("accepts a zero fee, and posts no fee leg for it", async () => {
    const { settlement } = await recordSettlement(prisma, {
      ...baseBatch,
      feeAmount: "0",
      netAmount: "1000000",
      lines: [],
    });

    const posting = await prisma.financialTransaction.findUniqueOrThrow({
      where: { idempotencyKey: `settlement:${settlement.id}` },
    });
    const entries = await prisma.ledgerEntry.findMany({
      where: { financialTransactionId: posting.id },
      include: { account: true },
    });
    expect(entries.map((e) => e.account.code).sort()).toEqual(["cash.idr", "provider_clearing.idr"]);
    await expectBalanced(posting.id);
  });

  it("refuses a batch whose net plus fee is not its gross, writing nothing", async () => {
    await expect(
      recordSettlement(prisma, { ...baseBatch, netAmount: "900000", lines: [{ amount: "900000" }] }),
    ).rejects.toMatchObject({ key: "error.settlement_amounts_inconsistent" });

    await expectNothingWritten();
  });

  it("refuses a negative fee, writing nothing", async () => {
    await expect(
      recordSettlement(prisma, { ...baseBatch, feeAmount: "-1", netAmount: "1000001", lines: [] }),
    ).rejects.toMatchObject({ key: "error.settlement_amounts_invalid" });

    await expectNothingWritten();
  });

  it("refuses a gross of zero or less, writing nothing", async () => {
    await expect(
      recordSettlement(prisma, { ...baseBatch, grossAmount: "0", feeAmount: "0", netAmount: "0", lines: [] }),
    ).rejects.toMatchObject({ key: "error.settlement_gross_not_positive" });

    await expectNothingWritten();
  });

  it("refuses an unknown provider, writing nothing", async () => {
    await expect(
      recordSettlement(prisma, { ...baseBatch, provider: "CASH_UNDER_THE_MAT", lines: [] }),
    ).rejects.toMatchObject({ key: "error.settlement_provider_unknown" });

    await expectNothingWritten();
  });

  it("refuses a currency the chart of accounts has no settlement accounts for", async () => {
    await expect(
      recordSettlement(prisma, { ...baseBatch, currency: "EUR", lines: [] }),
    ).rejects.toMatchObject({ key: "error.settlement_currency_unknown" });

    await expectNothingWritten();
  });

  it("refuses a non-finite or unparsable amount, writing nothing", async () => {
    for (const bad of ["NaN", "Infinity", "not-a-number", ""]) {
      await expect(
        recordSettlement(prisma, { ...baseBatch, grossAmount: bad, lines: [] }),
      ).rejects.toMatchObject({ key: "error.settlement_amount_not_a_number" });
    }

    await expectNothingWritten();
  });

  it("refuses a line whose amount is not a positive number, writing nothing", async () => {
    await expect(
      recordSettlement(prisma, { ...baseBatch, lines: [{ amount: "0" }] }),
    ).rejects.toMatchObject({ key: "error.settlement_line_amount_invalid" });
    await expect(
      recordSettlement(prisma, { ...baseBatch, lines: [{ amount: "-5" }] }),
    ).rejects.toMatchObject({ key: "error.settlement_line_amount_invalid" });

    await expectNothingWritten();
  });

  it("refuses lines that add up to more than the batch's gross, writing nothing", async () => {
    // A statement whose lines exceed the batch total is a typo, not a
    // discrepancy to record: the lines are meant to be the batch broken down.
    await expect(
      recordSettlement(prisma, {
        ...baseBatch,
        lines: [{ amount: "900000" }, { amount: "200000" }],
      }),
    ).rejects.toMatchObject({ key: "error.settlement_lines_exceed_gross" });

    await expectNothingWritten();
  });

  it("is safe to retry: a second call with the same details records a SECOND batch, each posted once", async () => {
    // Deliberately NOT deduplicated on `batchReference` — the column is
    // admin-typed free text the schema leaves non-unique on purpose, so a
    // provider reusing its own statement id must not swallow a real second
    // batch. What IS guaranteed is that each batch posts exactly once, under its
    // own row id.
    const first = await recordSettlement(prisma, { ...baseBatch, lines: [] });
    const second = await recordSettlement(prisma, { ...baseBatch, lines: [] });

    expect(second.settlement.id).not.toBe(first.settlement.id);
    const postings = await prisma.financialTransaction.findMany({ orderBy: { id: "asc" } });
    expect(postings.map((p) => p.idempotencyKey)).toEqual([
      `settlement:${first.settlement.id}`,
      `settlement:${second.settlement.id}`,
    ]);
  });

  it("posts one batch exactly once even if the same row is handed to the posting again", async () => {
    const { settlement } = await recordSettlement(prisma, { ...baseBatch, lines: [] });

    // What a retried route call would do if it re-posted an existing row: the
    // idempotency key is derived from the row id, so the first posting comes back.
    const { postSettlementPosting } = await import("@app/db");
    const again = await postSettlementPosting(prisma, {
      ...settlement,
      batchReference: settlement.batchReference,
    });

    expect(
      await prisma.financialTransaction.count({ where: { referenceType: "settlement" } }),
    ).toBe(1);
    expect(again?.idempotencyKey).toBe(`settlement:${settlement.id}`);
  });

  it("runs inside a caller's own transaction when given one", async () => {
    // The route wraps its own $transaction around this; a nested one would throw.
    const result = await prisma.$transaction((tx) =>
      recordSettlement(tx, { ...baseBatch, lines: [{ amount: "1000000" }] }),
    );

    expect(await prisma.settlement.count()).toBe(1);
    expect(
      await prisma.financialTransaction.count({ where: { referenceId: result.settlement.id } }),
    ).toBe(1);
  });
});

describe("listSettlements", () => {
  it("returns batches newest settlement date first, with their line count and posting", async () => {
    const older = await recordSettlement(prisma, {
      ...baseBatch,
      batchReference: "OLD",
      settlementDate: new Date("2026-08-01T00:00:00.000Z"),
      lines: [{ amount: "1000000" }],
    });
    const newer = await recordSettlement(prisma, {
      ...baseBatch,
      batchReference: "NEW",
      settlementDate: new Date("2026-09-15T00:00:00.000Z"),
      lines: [],
    });

    const { rows, total } = await listSettlements(prisma, {});

    expect(total).toBe(2);
    expect(rows.map((r) => r.id)).toEqual([newer.settlement.id, older.settlement.id]);
    expect(rows[0]!.lineCount).toBe(0);
    expect(rows[1]!.lineCount).toBe(1);
    expect(rows[0]!.postingId).not.toBeNull();
  });

  it("filters by provider and by currency", async () => {
    await recordSettlement(prisma, { ...baseBatch, lines: [] });
    await recordSettlement(prisma, {
      ...baseBatch,
      provider: PaymentMethod.NOWPAYMENTS,
      currency: "USDT",
      grossAmount: "100",
      feeAmount: "1",
      netAmount: "99",
      lines: [],
    });

    expect((await listSettlements(prisma, { provider: PaymentMethod.TOKOPAY })).total).toBe(1);
    expect((await listSettlements(prisma, { currency: "USDT" })).total).toBe(1);
    expect((await listSettlements(prisma, { provider: PaymentMethod.BYBIT })).total).toBe(0);
  });

  it("pages, and reports the providers and currencies the caller may filter by", async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordSettlement(prisma, {
        ...baseBatch,
        settlementDate: new Date(`2026-09-0${i + 1}T00:00:00.000Z`),
        lines: [],
      });
    }

    const page = await listSettlements(prisma, { limit: 2, offset: 0 });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.providers).toContain(PaymentMethod.TOKOPAY);
    expect(page.currencies).toEqual(["IDR", "USDT"]);

    const second = await listSettlements(prisma, { limit: 2, offset: 2 });
    expect(second.rows).toHaveLength(1);
  });
});
