/**
 * A notification that cannot be queued must never undo a wallet top-up credit
 * (backend audit pass 2, final review).
 *
 * `settleWalletTopup` and `flagWalletTopupOverpayment` run inside the payment
 * rail's `$transaction`, after the gateway already took the buyer's money. The
 * owner email, the buyer's "balance credited" DM and the admin overpaid alert
 * are side effects: if one fails, the claim, the wallet credit and the ledger
 * posting must still commit, and the failure is only logged.
 *
 * Two failure shapes, as in settlePaidOrderNotifyIsolation.test.ts:
 * - a JavaScript throw from the enqueue helper (stubbed below);
 * - a database error from the outbox INSERT itself (a trigger below), which
 *   would abort the whole Postgres transaction without a savepoint.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createWalletTopupOrder, settleWalletTopup, flagWalletTopupOverpayment } from "./wallet_topup";
import { addAdminIdToDb } from "./admins";
import { setSetting, deleteSetting } from "./settings";
import { NotificationEvent, OrderStatus, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";

const faults = vi.hoisted(() => ({ throwIn: new Set<string>() }));

vi.mock("./notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./notifications")>();
  const wrap = <F extends (...args: never[]) => Promise<unknown>>(name: string, fn: F) =>
    (async (...args: Parameters<F>) => {
      if (faults.throwIn.has(name)) throw new Error(`simulated ${name} failure`);
      return fn(...args);
    }) as F;
  return {
    ...actual,
    enqueueOwnerWalletTopupEmail: wrap("enqueueOwnerWalletTopupEmail", actual.enqueueOwnerWalletTopupEmail),
    enqueueWalletTopupCreditedDm: wrap("enqueueWalletTopupCreditedDm", actual.enqueueWalletTopupCreditedDm),
    enqueueAdminOverpaid: wrap("enqueueAdminOverpaid", actual.enqueueAdminOverpaid),
  };
});

const EVENTS = [
  NotificationEvent.OWNER_EMAIL_WALLET_TOPUP,
  NotificationEvent.WALLET_TOPUP_CREDITED_DM,
  NotificationEvent.ADMIN_OVERPAID,
];
const OWNER_EMAIL_KEYS = ["owner_email_enabled", "owner_email", "owner_email_on_wallet_topup"];

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
  faults.throwIn.clear();
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  await addAdminIdToDb(prisma, 987654321);
  await setSetting(prisma, "owner_email_enabled", "true");
  await setSetting(prisma, "owner_email", "owner@example.com");
  await setSetting(prisma, "owner_email_on_wallet_topup", "true");
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of OWNER_EMAIL_KEYS) await deleteSetting(prisma, key);
  await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS reject_outbox_event ON notification_outbox");
  await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS reject_outbox_event()");
});

/** Make the outbox INSERT itself fail, in the database, for these event names. */
async function rejectOutboxEvents(events: string[]) {
  const list = events.map((e) => `'${e}'`).join(", ");
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION reject_outbox_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ` +
      `IF NEW.event IN (${list}) THEN RAISE EXCEPTION 'simulated outbox insert failure for %', NEW.event; END IF; ` +
      `RETURN NEW; END $$`,
  );
  await prisma.$executeRawUnsafe(
    "CREATE TRIGGER reject_outbox_event BEFORE INSERT ON notification_outbox FOR EACH ROW EXECUTE FUNCTION reject_outbox_event()",
  );
}

/** Settle an overpaid top-up exactly the way a rail does: claim, credit, then
 * flag the excess, all inside the rail's one transaction. */
async function settleOverpaidInRailTransaction() {
  const order = await prisma.$transaction((tx) =>
    createWalletTopupOrder(tx, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
  );
  const before = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
  await prisma.$transaction(async (tx) => {
    const { credited } = await settleWalletTopup(tx, order.id, { amount: "25000" });
    await flagWalletTopupOverpayment(tx, {
      order, credited, paid: "25000", expected: order.totalAmount, rail: "Test",
      markLedgerOverpaid: async () => undefined,
    });
  });
  return { order, balanceBefore: new Decimal(before.walletBalance) };
}

async function expectCredited(orderId: number, balanceBefore: Decimal) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  expect(order.status).toBe(OrderStatus.DELIVERED);
  expect(order.paymentState).toBe("PAID");
  expect(order.walletCreditState).toBe("CREDITED");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
  expect(new Decimal(user.walletBalance).minus(balanceBefore).equals(order.totalAmount)).toBe(true);
  expect(await prisma.financialTransaction.count({ where: { idempotencyKey: `order:${orderId}:topup` } })).toBe(1);
}

function outboxCount(orderId: number, event: string) {
  return prisma.notificationOutbox.count({ where: { orderId, event } });
}

describe("settleWalletTopup: notification enqueue failures never roll back the credit", () => {
  it("baseline: with nothing failing, all three notifications are queued", async () => {
    const { order, balanceBefore } = await settleOverpaidInRailTransaction();
    await expectCredited(order.id, balanceBefore);
    for (const event of EVENTS) expect(await outboxCount(order.id, event)).toBeGreaterThanOrEqual(1);
  });

  it("every enqueue helper throws, the credit and ledger posting still commit", async () => {
    faults.throwIn = new Set(["enqueueOwnerWalletTopupEmail", "enqueueWalletTopupCreditedDm", "enqueueAdminOverpaid"]);
    const errorLog = vi.spyOn(logger, "error");

    const { order, balanceBefore } = await settleOverpaidInRailTransaction();

    await expectCredited(order.id, balanceBefore);
    const logged = errorLog.mock.calls.filter(([meta]) => (meta as { orderId?: number })?.orderId === order.id);
    expect(logged.length).toBeGreaterThanOrEqual(3);
  });

  it("the outbox INSERT fails in the database, the credit still commits and no row is left", async () => {
    await rejectOutboxEvents(EVENTS);

    const { order, balanceBefore } = await settleOverpaidInRailTransaction();

    await expectCredited(order.id, balanceBefore);
    for (const event of EVENTS) expect(await outboxCount(order.id, event)).toBe(0);
  });

  it("one failing DB enqueue does not drop the others", async () => {
    await rejectOutboxEvents([NotificationEvent.OWNER_EMAIL_WALLET_TOPUP]);

    const { order, balanceBefore } = await settleOverpaidInRailTransaction();

    await expectCredited(order.id, balanceBefore);
    expect(await outboxCount(order.id, NotificationEvent.OWNER_EMAIL_WALLET_TOPUP)).toBe(0);
    expect(await outboxCount(order.id, NotificationEvent.WALLET_TOPUP_CREDITED_DM)).toBe(1);
    expect(await outboxCount(order.id, NotificationEvent.ADMIN_OVERPAID)).toBeGreaterThanOrEqual(1);
  });
});
