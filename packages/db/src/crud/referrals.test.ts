import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { OrderCurrency } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { upsertUser, setSetting } from "@app/db";
import { maybePayReferralCommission, getReferralSummary } from "./referrals";

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

async function freshUser(id: number) {
  return prisma.user.findUniqueOrThrow({ where: { id } });
}

async function makeReferrerAndReferee() {
  const referrer = await upsertUser(prisma, { telegramId: 501, username: "referrer", fullName: "Referrer" });
  const referee = await upsertUser(prisma, {
    telegramId: 502,
    username: "referee",
    fullName: "Referee",
    referredByCode: referrer.referralCode,
  });
  return { referrer, referee };
}

/** A minimal DELIVERED Order row — Referral.orderId has a real FK to Order,
 * so maybePayReferralCommission needs a genuine row to attach to. */
async function makeDeliveredOrder(args: {
  userId: number;
  orderCode: string;
  totalAmount: string;
  currency: string;
  fxRate?: string;
}) {
  return prisma.order.create({
    data: {
      orderCode: args.orderCode,
      userId: args.userId,
      subtotalAmount: args.totalAmount,
      totalAmount: args.totalAmount,
      currency: args.currency,
      fxRate: args.fxRate ?? null,
      status: "DELIVERED",
    },
  });
}

describe("maybePayReferralCommission", () => {
  it("no referrer: no-op, no Referral row, no wallet change", async () => {
    const user = await upsertUser(prisma, { telegramId: 503, username: "lone", fullName: "Lone" });
    const order = await makeDeliveredOrder({
      userId: user.id,
      orderCode: "ORD-1",
      totalAmount: "10",
      currency: OrderCurrency.USDT,
    });

    await maybePayReferralCommission(prisma, { ...order, userId: user.id });

    const referral = await prisma.referral.findUnique({ where: { refereeId: user.id } });
    expect(referral).toBeNull();
  });

  it("USDT order: credits the referrer's walletBalanceUsdt (not walletBalance)", async () => {
    const { referrer, referee } = await makeReferrerAndReferee();
    const order = await makeDeliveredOrder({
      userId: referee.id,
      orderCode: "ORD-2",
      totalAmount: "100",
      currency: OrderCurrency.USDT,
    });

    await maybePayReferralCommission(prisma, { ...order, userId: referee.id });

    const referral = await prisma.referral.findUnique({ where: { refereeId: referee.id } });
    expect(referral).toBeTruthy();
    expect(referral?.referrerId).toBe(referrer.id);
    expect(referral?.paid).toBe(true);

    const after = await freshUser(referrer.id);
    expect(new Decimal(after.walletBalanceUsdt).greaterThan(0)).toBe(true);
    expect(new Decimal(after.walletBalance).equals(0)).toBe(true); // IDR bucket untouched
  });

  it("second DELIVERED order for the same referee: no-op (Referral.refereeId is unique)", async () => {
    const { referrer, referee } = await makeReferrerAndReferee();

    const order1 = await makeDeliveredOrder({
      userId: referee.id,
      orderCode: "ORD-3",
      totalAmount: "100",
      currency: OrderCurrency.USDT,
    });
    await maybePayReferralCommission(prisma, { ...order1, userId: referee.id });
    const afterFirst = await freshUser(referrer.id);

    const order2 = await makeDeliveredOrder({
      userId: referee.id,
      orderCode: "ORD-4",
      totalAmount: "100",
      currency: OrderCurrency.USDT,
    });
    await maybePayReferralCommission(prisma, { ...order2, userId: referee.id });
    const afterSecond = await freshUser(referrer.id);

    expect(afterSecond.walletBalanceUsdt.toString()).toBe(afterFirst.walletBalanceUsdt.toString());
    const referrals = await prisma.referral.findMany({ where: { refereeId: referee.id } });
    expect(referrals).toHaveLength(1);
  });

  it("IDR order with an fxRate snapshot: converts totalAmount/fxRate to USDT before crediting", async () => {
    const { referrer, referee } = await makeReferrerAndReferee();
    const order = await makeDeliveredOrder({
      userId: referee.id,
      orderCode: "ORD-5",
      totalAmount: "150000",
      currency: OrderCurrency.IDR,
      fxRate: "15000", // 150000 / 15000 = 10 USDT base
    });

    await maybePayReferralCommission(prisma, { ...order, userId: referee.id });

    const after = await freshUser(referrer.id);
    expect(new Decimal(after.walletBalanceUsdt).greaterThan(0)).toBe(true);
  });

  it("IDR order without an fxRate snapshot: falls back to getUsdIdrRate (the usd_idr_rate setting)", async () => {
    const { referrer, referee } = await makeReferrerAndReferee();
    await setSetting(prisma, "usd_idr_rate", "15000");
    const order = await makeDeliveredOrder({
      userId: referee.id,
      orderCode: "ORD-6",
      totalAmount: "150000",
      currency: OrderCurrency.IDR,
    });

    await maybePayReferralCommission(prisma, { ...order, userId: referee.id });

    const referral = await prisma.referral.findUnique({ where: { refereeId: referee.id } });
    expect(referral).toBeTruthy();
    const after = await freshUser(referrer.id);
    expect(new Decimal(after.walletBalanceUsdt).greaterThan(0)).toBe(true);
  });

  it("IDR order with no rate available anywhere: skips silently, no Referral row, no wallet change", async () => {
    const { referrer, referee } = await makeReferrerAndReferee();
    // No fxRate snapshot, no usd_idr_rate setting, no config.USDT_IDR_RATE fallback in test env.
    const order = await makeDeliveredOrder({
      userId: referee.id,
      orderCode: "ORD-7",
      totalAmount: "150000",
      currency: OrderCurrency.IDR,
    });

    await maybePayReferralCommission(prisma, { ...order, userId: referee.id });

    const referral = await prisma.referral.findUnique({ where: { refereeId: referee.id } });
    expect(referral).toBeNull();
    const after = await freshUser(referrer.id);
    expect(new Decimal(after.walletBalanceUsdt).equals(0)).toBe(true);
  });
});

describe("getReferralSummary", () => {
  it("no referrals: zero count and Decimal(0), not null/NaN", async () => {
    const user = await upsertUser(prisma, { telegramId: 601, username: "solo", fullName: "Solo" });

    const summary = await getReferralSummary(prisma, user.id);

    expect(summary.referredCount).toBe(0);
    expect(summary.earnedUsdt).toBeInstanceOf(Decimal);
    expect(summary.earnedUsdt.equals(0)).toBe(true);
  });

  it("one paid referral: reflects the same commission maybePayReferralCommission credited", async () => {
    const { referrer, referee } = await makeReferrerAndReferee();
    const order = await makeDeliveredOrder({
      userId: referee.id,
      orderCode: "ORD-8",
      totalAmount: "100",
      currency: OrderCurrency.USDT,
    });
    await maybePayReferralCommission(prisma, { ...order, userId: referee.id });
    const referralRow = await prisma.referral.findUniqueOrThrow({ where: { refereeId: referee.id } });

    const summary = await getReferralSummary(prisma, referrer.id);

    expect(summary.referredCount).toBe(1);
    expect(summary.earnedUsdt.equals(new Decimal(referralRow.commission))).toBe(true);
  });

  it("two referees who both bought: sums commission across referrals, counts distinct referees", async () => {
    const referrer = await upsertUser(prisma, { telegramId: 604, username: "ref2", fullName: "Ref2" });
    const refereeA = await upsertUser(prisma, {
      telegramId: 605,
      username: "refA",
      fullName: "RefA",
      referredByCode: referrer.referralCode,
    });
    const refereeB = await upsertUser(prisma, {
      telegramId: 606,
      username: "refB",
      fullName: "RefB",
      referredByCode: referrer.referralCode,
    });
    const orderA = await makeDeliveredOrder({
      userId: refereeA.id,
      orderCode: "ORD-9",
      totalAmount: "100",
      currency: OrderCurrency.USDT,
    });
    const orderB = await makeDeliveredOrder({
      userId: refereeB.id,
      orderCode: "ORD-10",
      totalAmount: "50",
      currency: OrderCurrency.USDT,
    });
    await maybePayReferralCommission(prisma, { ...orderA, userId: refereeA.id });
    await maybePayReferralCommission(prisma, { ...orderB, userId: refereeB.id });

    const summary = await getReferralSummary(prisma, referrer.id);

    expect(summary.referredCount).toBe(2);
    const after = await freshUser(referrer.id);
    expect(summary.earnedUsdt.equals(new Decimal(after.walletBalanceUsdt))).toBe(true);
  });
});
