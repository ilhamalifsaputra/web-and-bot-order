/**
 * Account/stock replacement (reissue) service — Financial Ledger M19.
 *
 * Covers the two sanctioned mutators (`replaceStockItem`,
 * `refundInsteadOfReplace`), the `retryReplacementAllocation` resume path that
 * unblocks an AWAITING_STOCK request once a restock lands, the transition
 * table they all enforce, and the refund fallback's money movement — which is
 * this codebase's FIRST production use of `createRefund`/`createRefundItem`
 * and pays out through the existing `executeRefund` ledger path.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  NotificationEvent,
  OrderStatus,
  RefundExecutionMethod,
  RefundExecutionStatus,
  RefundStatus,
  DeadReason,
  StockActorType,
  StockEventType,
  StockReplacementStatus,
  StockStatus,
} from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { Decimal } from "@app/core/money";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { approveOrder, attachPaymentProof, createOrderDirect, getOrder } from "./orders";
import { bulkAddStock } from "./stock";
import { listStockItemEvents } from "./stockEvents";
import { checkStockIntegrity } from "./stockIntegrity";
import { decryptCredentials } from "@app/core/credentialCrypto";
import {
  STOCK_REPLACEMENT_LEGAL_TRANSITIONS,
  listStockReplacementsForOrder,
  refundInsteadOfReplace,
  replaceStockItem,
  retryReplacementAllocation,
} from "./stockReplacement";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let adminId: number;

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
      telegramId: 777001,
      username: "admin",
      fullName: "Admin",
      role: "ADMIN",
      referralCode: `a${Math.random()}`,
    },
  });
  adminId = admin.id;
});

/** A DELIVERED order with `quantity` units, each holding its own SOLD StockItem. */
async function makeDeliveredOrder(quantity = 1, voucherCode?: string) {
  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
  const created = await createOrderDirect(prisma, {
   channel: "bot",
    user: { id: buyer.id, role: buyer.role, walletBalance: buyer.walletBalance },
    productId: sample.product.id,
    quantity,
    voucherCode: voucherCode ?? null,
  });
  await attachPaymentProof(prisma, created!.id, { fileId: "proof", txid: `TX-${created!.id}` });
  await approveOrder(prisma, created!.id, { adminId });
  // approveOrder enqueues its own delivery rows; clear them so each test can
  // assert on exactly what the replacement itself enqueued.
  await prisma.notificationOutbox.deleteMany();
  // The shared fixture seeds 5 credentials, so a 1-unit order would leave 4
  // spares lying around and every request would silently find one. Drain them,
  // making "there is nothing to replace it with" the default and `restock()`
  // the explicit opt-in — which is the state most of this file is about.
  // Their IMPORTED events reference them (FK Restrict), so those go first.
  await prisma.stockItemEvent.deleteMany({
    where: { stockItem: { productId: sample.product.id, status: StockStatus.AVAILABLE } },
  });
  await prisma.stockItem.deleteMany({
    where: { productId: sample.product.id, status: StockStatus.AVAILABLE },
  });
  const order = (await getOrder(prisma, created!.id))!;
  const items = await prisma.orderItem.findMany({
    where: { orderId: order.id },
    orderBy: { id: "asc" },
  });
  return { order, items };
}

/** Top the sample SKU back up so a replacement has something to allocate. */
async function restock(count = 1) {
  await bulkAddStock(
    prisma,
    sample.product.id,
    Array.from({ length: count }, () => `spare-${Math.random()}@example.com:pwd`),
  );
}

describe("STOCK_REPLACEMENT_LEGAL_TRANSITIONS", () => {
  it("encodes exactly the documented shape — four terminal values with no outgoing edges", () => {
    expect(STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.REQUESTED]!.slice().sort()).toEqual(
      [
        StockReplacementStatus.AWAITING_STOCK,
        StockReplacementStatus.COMPLETED,
        StockReplacementStatus.CANCELLED,
        StockReplacementStatus.FAILED,
      ].sort(),
    );
    expect(
      STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.AWAITING_STOCK]!.slice().sort(),
    ).toEqual(
      [
        StockReplacementStatus.COMPLETED,
        StockReplacementStatus.REFUNDED_INSTEAD,
        StockReplacementStatus.CANCELLED,
        StockReplacementStatus.FAILED,
      ].sort(),
    );
    expect(STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.COMPLETED]).toEqual([]);
    expect(STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.REFUNDED_INSTEAD]).toEqual([]);
    expect(STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.CANCELLED]).toEqual([]);
    expect(STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.FAILED]).toEqual([]);
  });

  it("never offers REFUNDED_INSTEAD from REQUESTED — only a supply-blocked request may be refunded instead", () => {
    expect(STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.REQUESTED]).not.toContain(
      StockReplacementStatus.REFUNDED_INSTEAD,
    );
  });
});

describe("replaceStockItem — replacement stock available", () => {
  it("swaps the credential: original DEAD, a new SOLD row on the order item, request COMPLETED", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const item = items[0]!;
    const originalStockId = item.stockItemId!;
    await restock(1);

    const { replacement, replacementStockItem } = await replaceStockItem(prisma, {
      orderItemId: item.id,
      reason: "password changed by the account owner",
      executedBy: adminId,
    });

    expect(replacement.status).toBe(StockReplacementStatus.COMPLETED);
    expect(replacement.resolvedAt).not.toBeNull();
    expect(replacement.originalStockItemId).toBe(originalStockId);
    expect(replacement.replacementStockItemId).toBe(replacementStockItem!.id);
    expect(replacement.refundId).toBeNull();
    expect(replacement.requestedBy).toBe(adminId);
    expect(replacement.reason).toBe("password changed by the account owner");

    const original = await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } });
    expect(original.status).toBe(StockStatus.DEAD);
    expect(original.note).toContain(String(replacement.id));

    const fresh = await prisma.stockItem.findUniqueOrThrow({ where: { id: replacementStockItem!.id } });
    expect(fresh.status).toBe(StockStatus.SOLD);
    expect(fresh.soldAt).not.toBeNull();
    expect(fresh.orderId).toBe(order.id);

    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloadedItem.stockItemId).toBe(replacementStockItem!.id);
  });

  it("the retired credential releases its claim key (so it can be re-imported); the replacement keeps its own", async () => {
    const { items } = await makeDeliveredOrder(1);
    const item = items[0]!;
    const originalStockId = item.stockItemId!;
    const originalPlain = decryptCredentials(
      (await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } })).credentials,
    );
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } })).activeCredentialKey).not.toBeNull();
    await restock(1);

    const { replacementStockItem } = await replaceStockItem(prisma, {
      orderItemId: item.id,
      reason: "password changed by the account owner",
      executedBy: adminId,
    });

    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } })).activeCredentialKey).toBeNull();
    expect(
      (await prisma.stockItem.findUniqueOrThrow({ where: { id: replacementStockItem!.id } })).activeCredentialKey,
    ).not.toBeNull();
    expect(await bulkAddStock(prisma, sample.product.id, [originalPlain])).toMatchObject({ added: 1 });
  });

  it("records the swap in the stock event ledger: MARKED_DEAD for the retired credential, SOLD for its replacement", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const item = items[0]!;
    const originalStockId = item.stockItemId!;
    await restock(1);

    const { replacement, replacementStockItem } = await replaceStockItem(prisma, {
      orderItemId: item.id,
      reason: "password changed by the account owner",
      executedBy: adminId,
    });

    const retired = await prisma.stockItemEvent.findMany({
      where: { stockItemId: originalStockId },
      orderBy: { id: "asc" },
    });
    expect(retired.map((e) => e.eventType)).toEqual([
      StockEventType.IMPORTED,
      StockEventType.RESERVED,
      StockEventType.SOLD,
      StockEventType.MARKED_DEAD,
    ]);
    expect(retired.at(-1)).toMatchObject({
      fromStatus: StockStatus.SOLD,
      toStatus: StockStatus.DEAD,
      orderId: order.id,
      orderItemId: item.id,
      actorType: StockActorType.ADMIN,
      actorAdminId: adminId,
      reasonCode: DeadReason.OTHER,
      meta: { stockReplacementId: replacement.id },
    });
    // The buyer's free-text complaint and the credential stay out of the ledger.
    expect(JSON.stringify(retired)).not.toContain("password changed");

    const issued = await prisma.stockItemEvent.findMany({
      where: { stockItemId: replacementStockItem!.id },
      orderBy: { id: "asc" },
    });
    expect(issued.map((e) => e.eventType)).toEqual([
      StockEventType.IMPORTED,
      StockEventType.RESERVED,
      StockEventType.SOLD,
      StockEventType.WARRANTY_REPLACED,
    ]);
    expect(issued.at(-2)).toMatchObject({
      fromStatus: StockStatus.RESERVED,
      toStatus: StockStatus.SOLD,
      orderId: order.id,
      orderItemId: item.id,
      actorType: StockActorType.ADMIN,
      actorAdminId: adminId,
    });
    // Not a status change of its own (the SOLD event above is), so both
    // status columns stay null — same shape as SUBSTITUTED_IN.
    expect(issued.at(-1)).toMatchObject({
      fromStatus: null,
      toStatus: null,
      orderId: order.id,
      orderItemId: item.id,
      actorType: StockActorType.ADMIN,
      actorAdminId: adminId,
      meta: { stockReplacementId: replacement.id, replacesStockItemId: originalStockId },
    });
    expect(JSON.stringify(issued)).not.toContain("password changed");
    expect(JSON.stringify(issued)).not.toContain("spare-");
    // Both ledgers chain: each transition starts where the previous one ended.
    for (const chain of [retired, issued]) {
      const transitions = chain.filter((e) => e.toStatus !== null);
      for (let i = 1; i < transitions.length; i++) {
        expect(transitions[i]!.fromStatus).toBe(transitions[i - 1]!.toStatus);
      }
    }
  });

  it("redelivers through the notification outbox, the same ORDER_DELIVERED_DM row the resend path enqueues", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    await restock(1);

    await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "account banned within 24h",
      executedBy: adminId,
    });

    const queued = await prisma.notificationOutbox.findMany({ where: { orderId: order.id } });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.event).toBe(NotificationEvent.ORDER_DELIVERED_DM);
    const payload = JSON.parse(queued[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.order_code).toBe(order.orderCode);
    expect(payload.chat_id).toBe(Number(sample.user.telegramId));
    // A deliberate redelivery: sent even though the original file was acknowledged.
    expect(payload.resend).toBe(true);
    // The credential itself never rides in the payload — the dispatcher reads
    // it live, which is exactly why repointing the OrderItem redelivers the
    // NEW account (CLAUDE.md: never log/queue secrets).
    expect(queued[0]!.payloadJson).not.toContain("user1@example.com");
  });

  it("audits the swap with the acting admin id, in plain language naming the order", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    await restock(1);

    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "invalid credentials",
      executedBy: adminId,
    });

    const rows = await prisma.auditLog.findMany({
      where: { targetType: "stock_replacement", targetId: replacement.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.adminId).toBe(adminId);
    expect(rows[0]!.details).toContain(order.orderCode);
    expect(rows[0]!.details).not.toContain("=");
  });

  it("APPENDS its stamp to the retired credential's note, keeping what an admin had written there", async () => {
    const { items } = await makeDeliveredOrder(1);
    const originalStockId = items[0]!.stockItemId!;
    // An admin's own note about this very account — the kind of thing a support
    // investigation reads, and the thing an overwriting stamp would destroy.
    await prisma.stockItem.update({
      where: { id: originalStockId },
      data: { note: "Password rotated on request 2026-08-01; buyer confirmed access." },
    });
    await restock(1);

    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "stopped working a week later",
      executedBy: adminId,
    });

    const original = await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } });
    expect(original.note).toContain("Password rotated on request 2026-08-01");
    expect(original.note).toContain(`stock replacement #${replacement.id}`);
  });

  it("stamps a bare note when the credential had none, rather than a leading blank line", async () => {
    const { items } = await makeDeliveredOrder(1);
    const originalStockId = items[0]!.stockItemId!;
    expect(
      (await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } })).note,
    ).toBeNull();
    await restock(1);

    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });

    const original = await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } });
    expect(original.note).toBe(
      `Reported bad by the buyer and taken out of use under stock replacement #${replacement.id}.`,
    );
  });

  it("leaves every other unit of a bulk order completely untouched", async () => {
    const { items } = await makeDeliveredOrder(5);
    const target = items[0]!;
    const others = items.slice(1);
    const othersBefore = await prisma.stockItem.findMany({
      where: { id: { in: others.map((o) => o.stockItemId!) } },
      orderBy: { id: "asc" },
    });
    await restock(1);

    await replaceStockItem(prisma, {
      orderItemId: target.id,
      reason: "one of five is dead",
      executedBy: adminId,
    });

    const othersAfter = await prisma.orderItem.findMany({
      where: { id: { in: others.map((o) => o.id) } },
      orderBy: { id: "asc" },
    });
    expect(othersAfter.map((o) => o.stockItemId)).toEqual(others.map((o) => o.stockItemId));

    const stockAfter = await prisma.stockItem.findMany({
      where: { id: { in: others.map((o) => o.stockItemId!) } },
      orderBy: { id: "asc" },
    });
    expect(stockAfter).toEqual(othersBefore);

    expect(await prisma.stockReplacement.count()).toBe(1);
  });
});

/**
 * Who actually gets TOLD about a replacement, and what the shop claims about it.
 *
 * `enqueueOrderDeliveredDm` returns silently when `telegramId` is null, so a web
 * buyer's "redelivery" used to be a no-op that the audit line, the pino line and
 * the admin's toast all described as sent. The three cases below are the three
 * kinds of buyer this shop has, and each one's claim has to be true.
 */
describe("replaceStockItem — telling the buyer", () => {
  /** Turn the shared sample user into a guest shopper (no Telegram, one email)
   *  — the shape `establishGuestCustomer` produces at storefront checkout. */
  async function makeSampleUserAGuest(guestEmail: string | null) {
    await prisma.user.update({
      where: { id: sample.user.id },
      data: { telegramId: null, isGuest: true, guestEmail },
    });
  }

  it("DMs a buyer who has Telegram, and reports them as notified", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    await restock(1);

    const outcome = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });

    expect(outcome.buyerNotified).toBe(true);
    const queued = await prisma.notificationOutbox.findMany({ where: { orderId: order.id } });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.event).toBe(NotificationEvent.ORDER_DELIVERED_DM);
  });

  it("emails a GUEST buyer a link to their order page, the rail a DM cannot reach them on", async () => {
    await makeSampleUserAGuest("guest-buyer@example.com");
    const { order, items } = await makeDeliveredOrder(1);
    await restock(1);

    const outcome = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "account banned within 24h",
      executedBy: adminId,
    });

    expect(outcome.buyerNotified).toBe(true);
    const queued = await prisma.notificationOutbox.findMany({ where: { orderId: order.id } });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.event).toBe(NotificationEvent.BUYER_EMAIL_ORDER_READY);
    expect(queued[0]!.channel).toBe("EMAIL");
    const payload = JSON.parse(queued[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.to).toBe("guest-buyer@example.com");
    expect(payload.order_code).toBe(order.orderCode);
    // The email is a summary plus a link; the credential stays on the order
    // page, which reads the now-repointed stock row live (CLAUDE.md).
    expect(queued[0]!.payloadJson).not.toContain("@example.com:");
    expect(queued[0]!.payloadJson).not.toContain("spare-");

    const rows = await prisma.auditLog.findMany({
      where: { targetType: "stock_replacement", targetId: outcome.replacement.id },
    });
    expect(rows[0]!.details).toContain("emailed");
  });

  it("refuses to claim delivery for a buyer reachable by nobody — no Telegram, no guest email", async () => {
    // A registered web buyer who never linked Telegram: not a guest, so the
    // guest-email rail does not apply to them either.
    await prisma.user.update({
      where: { id: sample.user.id },
      data: { telegramId: null, isGuest: false, guestEmail: null },
    });
    const { order, items } = await makeDeliveredOrder(1);
    await restock(1);

    const outcome = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "invalid credentials",
      executedBy: adminId,
    });

    // The swap itself still happened — only the claim about telling them is
    // withheld.
    expect(outcome.replacementStockItem).not.toBeNull();
    expect(outcome.buyerNotified).toBe(false);
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id } })).toBe(0);

    const rows = await prisma.auditLog.findMany({
      where: { targetType: "stock_replacement", targetId: outcome.replacement.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toContain("nobody has told them");
    expect(rows[0]!.details).not.toContain("was sent to them");
  });

  it("does not claim delivery for a guest whose checkout left no email address", async () => {
    await makeSampleUserAGuest(null);
    const { order, items } = await makeDeliveredOrder(1);
    await restock(1);

    const outcome = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });

    expect(outcome.buyerNotified).toBe(false);
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("carries the same three outcomes through retryReplacementAllocation", async () => {
    await makeSampleUserAGuest("guest-buyer@example.com");
    const { order, items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    expect(replacement.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    // Nothing was issued, so nobody was told anything.
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id } })).toBe(0);
    await restock(1);

    const retried = await retryReplacementAllocation(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    expect(retried.buyerNotified).toBe(true);
    const queued = await prisma.notificationOutbox.findMany({ where: { orderId: order.id } });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.event).toBe(NotificationEvent.BUYER_EMAIL_ORDER_READY);
  });
});

describe("replaceStockItem — no replacement stock", () => {
  it("parks the request at AWAITING_STOCK, unresolved, with the original still DEAD", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const originalStockId = items[0]!.stockItemId!;

    const { replacement, replacementStockItem, buyerNotified } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead on arrival",
      executedBy: adminId,
    });

    expect(replacement.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    expect(replacement.resolvedAt).toBeNull();
    expect(replacement.replacementStockItemId).toBeNull();
    expect(replacementStockItem).toBeNull();
    // Nothing was handed over, so there is nothing the buyer could have been
    // told about — `buyerNotified` is about a real message, not about the
    // request being recorded.
    expect(buyerNotified).toBe(false);

    const original = await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } });
    expect(original.status).toBe(StockStatus.DEAD);

    // Nothing was redelivered — there is nothing to deliver yet.
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe("replaceStockItem — guards", () => {
  it("refuses an order that is not DELIVERED", async () => {
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    const created = await createOrderDirect(prisma, {
     channel: "bot",
      user: { id: buyer.id, role: buyer.role, walletBalance: buyer.walletBalance },
      productId: sample.product.id,
      quantity: 1,
    });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: created!.id } });
    expect((await getOrder(prisma, created!.id))!.status).not.toBe(OrderStatus.DELIVERED);

    await expect(
      replaceStockItem(prisma, { orderItemId: item.id, reason: "x", executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses an order item whose stock row is not SOLD", async () => {
    const { items } = await makeDeliveredOrder(1);
    await prisma.stockItem.update({
      where: { id: items[0]!.stockItemId! },
      data: { status: StockStatus.DEAD },
    });

    await expect(
      replaceStockItem(prisma, { orderItemId: items[0]!.id, reason: "x", executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses an order item with no stock row at all", async () => {
    const { items } = await makeDeliveredOrder(1);
    await prisma.orderItem.update({ where: { id: items[0]!.id }, data: { stockItemId: null } });

    await expect(
      replaceStockItem(prisma, { orderItemId: items[0]!.id, reason: "x", executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses an unknown order item", async () => {
    await expect(
      replaceStockItem(prisma, { orderItemId: 999_999_999, reason: "x", executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses a second request while one is still open (non-terminal) for the same unit", async () => {
    const { items } = await makeDeliveredOrder(1);
    const first = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    expect(first.replacement.status).toBe(StockReplacementStatus.AWAITING_STOCK);

    await expect(
      replaceStockItem(prisma, { orderItemId: items[0]!.id, reason: "dead again", executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
    expect(await prisma.stockReplacement.count()).toBe(1);
  });

  it("allows a fresh request once an earlier one reached a terminal status", async () => {
    const { items } = await makeDeliveredOrder(1);
    await restock(2);
    const first = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    expect(first.replacement.status).toBe(StockReplacementStatus.COMPLETED);

    const second = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "the replacement was dead too",
      executedBy: adminId,
    });
    expect(second.replacement.status).toBe(StockReplacementStatus.COMPLETED);
    expect(second.replacement.originalStockItemId).toBe(first.replacement.replacementStockItemId);
  });

  it("lets exactly one of two CONCURRENT requests for the same unit through", async () => {
    // No spare stock on purpose: the winner parks at AWAITING_STOCK, which is
    // NON-terminal, so the loser must meet the open-request guard. (With spare
    // stock the winner would resolve COMPLETED and the second call would be a
    // legitimate fresh request against the replacement — covered above.)
    const { items } = await makeDeliveredOrder(1);

    const results = await Promise.allSettled([
      replaceStockItem(prisma, { orderItemId: items[0]!.id, reason: "a", executedBy: adminId }),
      replaceStockItem(prisma, { orderItemId: items[0]!.id, reason: "b", executedBy: adminId }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    // The loser must be turned away by the open-request guard specifically —
    // not by a deadlock, a lock timeout or any other incidental error that
    // would happen to look the same from outside.
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ValidationError);
    expect((loser.reason as ValidationError).key).toBe("error.stock_replacement_already_open");
    expect(await prisma.stockReplacement.count()).toBe(1);
    // And the loser's whole transaction rolled back: the delivered credential
    // was retired exactly once, by the winner.
    expect(
      await prisma.stockItem.count({
        where: { productId: sample.product.id, status: StockStatus.DEAD },
      }),
    ).toBe(1);
  });
});

describe("retryReplacementAllocation", () => {
  it("completes an AWAITING_STOCK request once the SKU is restocked", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    await restock(1);

    const retried = await retryReplacementAllocation(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    expect(retried.replacement.status).toBe(StockReplacementStatus.COMPLETED);
    expect(retried.replacement.resolvedAt).not.toBeNull();
    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: items[0]!.id } });
    expect(reloadedItem.stockItemId).toBe(retried.replacementStockItem!.id);
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("leaves the request AWAITING_STOCK when there is still nothing to allocate", async () => {
    const { items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });

    const retried = await retryReplacementAllocation(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    expect(retried.replacement.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    expect(retried.replacementStockItem).toBeNull();
  });

  it("refuses a request that is not AWAITING_STOCK", async () => {
    const { items } = await makeDeliveredOrder(1);
    await restock(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    expect(replacement.status).toBe(StockReplacementStatus.COMPLETED);

    await expect(
      retryReplacementAllocation(prisma, { stockReplacementId: replacement.id, executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("replacement — stock traceability wiring (Fase 5e)", () => {
  it("stamps the spare as sold to this order line, links it to the row it replaces, and inherits (never extends) the warranty", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const item = items[0]!;
    const originalStockId = item.stockItemId!;
    const warrantyUntil = new Date("2026-12-01T00:00:00.000Z");
    await prisma.stockItem.update({ where: { id: originalStockId }, data: { warrantyUntil } });
    await restock(1);

    const { replacementStockItem } = await replaceStockItem(prisma, {
      orderItemId: item.id,
      reason: "password changed by the account owner",
      executedBy: adminId,
    });

    const spare = await prisma.stockItem.findUniqueOrThrow({ where: { id: replacementStockItem!.id } });
    expect(spare).toMatchObject({
      status: StockStatus.SOLD,
      orderId: order.id,
      soldToOrderId: order.id,
      soldToOrderItemId: item.id,
      replacesStockItemId: originalStockId,
      warrantyUntil,
    });
    expect(spare.soldAt).not.toBeNull();
    expect(spare.activeCredentialKey).not.toBeNull();
    expect(replacementStockItem).toMatchObject({ soldToOrderItemId: item.id, replacesStockItemId: originalStockId });
  });

  it("inherits a null warranty as null rather than inventing one", async () => {
    const { items } = await makeDeliveredOrder(1);
    await prisma.stockItem.update({ where: { id: items[0]!.stockItemId! }, data: { warrantyUntil: null } });
    await restock(1);
    const { replacementStockItem } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    expect(
      (await prisma.stockItem.findUniqueOrThrow({ where: { id: replacementStockItem!.id } })).warrantyUntil,
    ).toBeNull();
  });

  it("records the dead reason on the retired row, mapping a reason that names a DeadReason and falling back to OTHER", async () => {
    const { items } = await makeDeliveredOrder(2);
    await restock(2);

    await replaceStockItem(prisma, { orderItemId: items[0]!.id, reason: "Password changed", executedBy: adminId });
    await replaceStockItem(prisma, {
      orderItemId: items[1]!.id,
      reason: "the buyer says it stopped working",
      executedBy: adminId,
    });

    const first = await prisma.stockItem.findUniqueOrThrow({ where: { id: items[0]!.stockItemId! } });
    const second = await prisma.stockItem.findUniqueOrThrow({ where: { id: items[1]!.stockItemId! } });
    expect(first.deadReason).toBe(DeadReason.PASSWORD_CHANGED);
    expect(second.deadReason).toBe(DeadReason.OTHER);
    const deadEvents = await prisma.stockItemEvent.findMany({
      where: { eventType: StockEventType.MARKED_DEAD },
      orderBy: { id: "asc" },
    });
    expect(deadEvents.map((e) => [e.stockItemId, e.reasonCode])).toEqual([
      [first.id, DeadReason.PASSWORD_CHANGED],
      [second.id, DeadReason.OTHER],
    ]);
  });

  it("leaves checkStockIntegrity clean after a replacement", async () => {
    const { items } = await makeDeliveredOrder(1);
    await restock(1);
    await replaceStockItem(prisma, { orderItemId: items[0]!.id, reason: "dead", executedBy: adminId });

    const report = await checkStockIntegrity(prisma);
    const { legacyRowsWithoutEvents: _legacy, ...findings } = report;
    for (const finding of Object.values(findings)) expect(finding).toEqual({ count: 0, sampleIds: [] });
  });

  it("chains replacesStockItemId across two consecutive replacements, and the spare's history shows the swap", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const item = items[0]!;
    const originalStockId = item.stockItemId!;
    await restock(2);

    const first = await replaceStockItem(prisma, { orderItemId: item.id, reason: "dead", executedBy: adminId });
    const second = await replaceStockItem(prisma, { orderItemId: item.id, reason: "dead again", executedBy: adminId });

    const spare1 = await prisma.stockItem.findUniqueOrThrow({ where: { id: first.replacementStockItem!.id } });
    const spare2 = await prisma.stockItem.findUniqueOrThrow({ where: { id: second.replacementStockItem!.id } });
    expect(spare1.replacesStockItemId).toBe(originalStockId);
    expect(spare1.status).toBe(StockStatus.DEAD);
    expect(spare1.activeCredentialKey).toBeNull();
    expect(spare2.replacesStockItemId).toBe(spare1.id);
    // The chain is FK-valid: original <- spare1 <- spare2 resolves through the relation.
    const chained = await prisma.stockItem.findUniqueOrThrow({
      where: { id: spare2.id },
      include: { replacesStockItem: { include: { replacesStockItem: true } } },
    });
    expect(chained.replacesStockItem!.id).toBe(spare1.id);
    expect(chained.replacesStockItem!.replacesStockItem!.id).toBe(originalStockId);
    expect(spare2.status).toBe(StockStatus.SOLD);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).stockItemId).toBe(spare2.id);

    const history1 = await listStockItemEvents(prisma, spare1.id);
    expect(history1!.map((e) => e.eventType)).toEqual([
      StockEventType.IMPORTED,
      StockEventType.RESERVED,
      StockEventType.SOLD,
      StockEventType.WARRANTY_REPLACED,
      StockEventType.MARKED_DEAD,
    ]);
    const history2 = await listStockItemEvents(prisma, spare2.id);
    expect(history2!.map((e) => e.eventType)).toEqual([
      StockEventType.IMPORTED,
      StockEventType.RESERVED,
      StockEventType.SOLD,
      StockEventType.WARRANTY_REPLACED,
    ]);
    expect(history2!.at(-1)).toMatchObject({ orderCode: order.orderCode, actorType: StockActorType.ADMIN });

    const report = await checkStockIntegrity(prisma);
    expect(report.statusEventMismatch.count).toBe(0);
    expect(report.duplicateStockItemPointers.count).toBe(0);
  });

  it("wires the retry path the same way: the restocked spare is stamped, linked and evented", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const originalStockId = items[0]!.stockItemId!;
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    await restock(1);

    const retried = await retryReplacementAllocation(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    const spare = await prisma.stockItem.findUniqueOrThrow({ where: { id: retried.replacementStockItem!.id } });
    expect(spare).toMatchObject({
      status: StockStatus.SOLD,
      soldToOrderId: order.id,
      soldToOrderItemId: items[0]!.id,
      replacesStockItemId: originalStockId,
    });
    const events = await prisma.stockItemEvent.findMany({ where: { stockItemId: spare.id }, orderBy: { id: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual([
      StockEventType.IMPORTED,
      StockEventType.RESERVED,
      StockEventType.SOLD,
      StockEventType.WARRANTY_REPLACED,
    ]);
    expect(events.at(-1)!.meta).toEqual({ stockReplacementId: replacement.id, replacesStockItemId: originalStockId });
  });

  it("is atomic: a failure after the swap rolls back the rows AND the events", async () => {
    const { items } = await makeDeliveredOrder(1);
    const item = items[0]!;
    const originalStockId = item.stockItemId!;
    await restock(1);
    const spareId = (await prisma.stockItem.findFirstOrThrow({ where: { status: StockStatus.AVAILABLE } })).id;
    const eventsBefore = await prisma.stockItemEvent.count();

    await expect(
      prisma.$transaction(async (tx) => {
        await replaceStockItem(tx as unknown as PrismaClient, {
          orderItemId: item.id,
          reason: "dead",
          executedBy: adminId,
        });
        throw new Error("simulated failure after the replacement");
      }),
    ).rejects.toThrow("simulated failure");

    expect(await prisma.stockItemEvent.count()).toBe(eventsBefore);
    expect(await prisma.stockReplacement.count()).toBe(0);
    const original = await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } });
    expect(original).toMatchObject({ status: StockStatus.SOLD, deadReason: null });
    expect(original.activeCredentialKey).not.toBeNull();
    const spare = await prisma.stockItem.findUniqueOrThrow({ where: { id: spareId } });
    expect(spare).toMatchObject({
      status: StockStatus.AVAILABLE,
      soldToOrderId: null,
      soldToOrderItemId: null,
      replacesStockItemId: null,
    });
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).stockItemId).toBe(originalStockId);
  });
});

describe("listStockReplacementsForOrder", () => {
  it("returns nothing for an order no unit of which was ever complained about", async () => {
    const { order } = await makeDeliveredOrder(2);
    expect(await listStockReplacementsForOrder(prisma, order.id)).toEqual([]);
  });

  it("returns every unit's requests oldest-first, and only this order's", async () => {
    const mine = await makeDeliveredOrder(2);
    const first = await replaceStockItem(prisma, {
      orderItemId: mine.items[0]!.id,
      reason: "unit one is dead",
      executedBy: adminId,
    });
    const second = await replaceStockItem(prisma, {
      orderItemId: mine.items[1]!.id,
      reason: "unit two is dead too",
      executedBy: adminId,
    });
    // A second order's request must not leak into the first order's list.
    // `makeDeliveredOrder` drains the SKU's spares, so top it back up first or
    // this second order can't be checked out at all.
    await restock(1);
    const other = await makeDeliveredOrder(1);
    await replaceStockItem(prisma, {
      orderItemId: other.items[0]!.id,
      reason: "someone else's problem",
      executedBy: adminId,
    });

    const rows = await listStockReplacementsForOrder(prisma, mine.order.id);

    expect(rows.map((r) => r.id)).toEqual([first.replacement.id, second.replacement.id]);
    expect(rows.map((r) => r.orderItemId)).toEqual([mine.items[0]!.id, mine.items[1]!.id]);
    expect(rows[0]!.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    expect(rows[0]!.reason).toBe("unit one is dead");
    expect(rows[0]!.refund).toBeNull();
  });

  it("attaches the refund a REFUNDED_INSTEAD request paid out, so a reader can show the amount", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "nothing to replace it with",
      executedBy: adminId,
    });
    const { refund } = await refundInsteadOfReplace(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    const rows = await listStockReplacementsForOrder(prisma, order.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(StockReplacementStatus.REFUNDED_INSTEAD);
    expect(rows[0]!.resolvedAt).not.toBeNull();
    expect(rows[0]!.refund!.id).toBe(refund.id);
    expect(new Decimal(rows[0]!.refund!.amount).equals(new Decimal(items[0]!.unitPrice))).toBe(true);
    expect(rows[0]!.refund!.currency).toBe(order.currency);
  });

  it("names the replacement credential a COMPLETED request handed over, but never the credential itself", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    await restock(1);
    const { replacement, replacementStockItem } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });

    const rows = await listStockReplacementsForOrder(prisma, order.id);

    expect(rows[0]!.status).toBe(StockReplacementStatus.COMPLETED);
    expect(rows[0]!.replacementStockItemId).toBe(replacementStockItem!.id);
    expect(rows[0]!.id).toBe(replacement.id);
    // A reader gets ids and money, never the account itself — the delivered
    // credential reaches the buyer through the outbox and nowhere else.
    expect(JSON.stringify(rows)).not.toContain("@example.com");
  });
});

describe("refundInsteadOfReplace", () => {
  async function awaitingStockRequest(quantity = 1, voucherCode?: string) {
    const { order, items } = await makeDeliveredOrder(quantity, voucherCode);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "no stock to replace it with",
      executedBy: adminId,
    });
    expect(replacement.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    return { order, items, replacement };
  }

  it("pays the unit back to the buyer's wallet and closes the request REFUNDED_INSTEAD", async () => {
    const { order, items, replacement } = await awaitingStockRequest(1);
    const unitPrice = new Decimal(items[0]!.unitPrice);

    const result = await refundInsteadOfReplace(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    expect(result.replacement.status).toBe(StockReplacementStatus.REFUNDED_INSTEAD);
    expect(result.replacement.resolvedAt).not.toBeNull();
    expect(result.replacement.refundId).toBe(result.refund.id);
    expect(result.replacement.replacementStockItemId).toBeNull();

    const refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe(RefundStatus.COMPLETED);
    expect(refunds[0]!.currency).toBe(order.currency);
    expect(new Decimal(refunds[0]!.amount).equals(unitPrice)).toBe(true);

    const refundItems = await prisma.refundItem.findMany({ where: { refundId: result.refund.id } });
    expect(refundItems).toHaveLength(1);
    expect(refundItems[0]!.orderItemId).toBe(items[0]!.id);
    expect(new Decimal(refundItems[0]!.amount).equals(unitPrice)).toBe(true);

    const executions = await prisma.refundExecution.findMany({ where: { refundId: result.refund.id } });
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).toBe(RefundExecutionStatus.COMPLETED);
    expect(executions[0]!.method).toBe(RefundExecutionMethod.WALLET);
    expect(new Decimal(executions[0]!.amount).equals(unitPrice)).toBe(true);

    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).equals(unitPrice)).toBe(true);
  });

  it("posts the payout to the double-entry ledger through the existing executeRefund path", async () => {
    const { replacement } = await awaitingStockRequest(1);

    const result = await refundInsteadOfReplace(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    const posting = await prisma.financialTransaction.findFirstOrThrow({
      where: { referenceType: "refund_execution" },
    });
    const entries = await prisma.ledgerEntry.findMany({
      where: { financialTransactionId: posting.id },
    });
    expect(entries.length).toBeGreaterThan(0);
    const debits = entries
      .filter((e) => e.direction === "DEBIT")
      .reduce((acc, e) => acc.plus(new Decimal(e.amount)), new Decimal(0));
    const credits = entries
      .filter((e) => e.direction === "CREDIT")
      .reduce((acc, e) => acc.plus(new Decimal(e.amount)), new Decimal(0));
    expect(debits.equals(credits)).toBe(true);
    expect(new Decimal(result.execution.amount).greaterThan(0)).toBe(true);
  });

  it("leaves the original credential DEAD — the buyer's money back does not revive it", async () => {
    const { items, replacement } = await awaitingStockRequest(1);
    const originalStockId = replacement.originalStockItemId;
    expect(originalStockId).toBe(items[0]!.stockItemId);

    await refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId });

    const original = await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } });
    expect(original.status).toBe(StockStatus.DEAD);
  });

  it("refunds one unit of a five-unit order without touching the other four", async () => {
    const { order, items, replacement } = await awaitingStockRequest(5);
    const unitPrice = new Decimal(items[0]!.unitPrice);

    await refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId });

    expect(await prisma.refundItem.count()).toBe(1);
    // A single-unit refund must NOT flip a multi-unit order to REFUNDED.
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe(OrderStatus.DELIVERED);
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).equals(unitPrice)).toBe(true);
  });

  it("refunds the unit NET of its prorated share of an order-level voucher discount", async () => {
    const { items, replacement } = await awaitingStockRequest(2, "SAVE10");
    // 2 x 5.00 = 10.00 subtotal, 10% voucher = 1.00 off, so each unit is worth
    // 5.00 - (1.00 x 5.00/10.00) = 4.50 of what the buyer actually paid.
    const expected = new Decimal("4.5");
    expect(new Decimal(items[0]!.unitPrice).equals(new Decimal("5"))).toBe(true);

    const result = await refundInsteadOfReplace(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    expect(new Decimal(result.execution.amount).equals(expected)).toBe(true);
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).equals(expected)).toBe(true);
  });

  it("opens its OWN Refund row per refunded unit rather than reusing another one", async () => {
    const { order, items } = await makeDeliveredOrder(2);
    const first = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    const second = await replaceStockItem(prisma, {
      orderItemId: items[1]!.id,
      reason: "dead too",
      executedBy: adminId,
    });

    const a = await refundInsteadOfReplace(prisma, {
      stockReplacementId: first.replacement.id,
      executedBy: adminId,
    });
    const b = await refundInsteadOfReplace(prisma, {
      stockReplacementId: second.replacement.id,
      executedBy: adminId,
    });

    expect(a.refund.id).not.toBe(b.refund.id);
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(2);
    expect(await prisma.refundExecution.count()).toBe(2);
  });

  it("audits the fallback with the acting admin id and plain language", async () => {
    const { order, replacement } = await awaitingStockRequest(1);

    const result = await refundInsteadOfReplace(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    const rows = await prisma.auditLog.findMany({
      where: { targetType: "stock_replacement", targetId: result.replacement.id },
    });
    expect(rows.some((r) => r.adminId === adminId && r.details!.includes(order.orderCode))).toBe(true);
  });

  it("refuses a request that is not AWAITING_STOCK", async () => {
    const { items } = await makeDeliveredOrder(1);
    await restock(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    expect(replacement.status).toBe(StockReplacementStatus.COMPLETED);

    await expect(
      refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
    expect(await prisma.refund.count()).toBe(0);
  });

  it("refuses an already-refunded request, so a buyer can never be paid twice for one unit", async () => {
    const { replacement } = await awaitingStockRequest(1);
    await refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId });

    await expect(
      refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
    expect(await prisma.refundExecution.count()).toBe(1);
  });

  it("refuses an unknown request", async () => {
    await expect(
      refundInsteadOfReplace(prisma, { stockReplacementId: 999_999_999, executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a MANUAL_TRANSFER fallback with no proof of the transfer", async () => {
    const { replacement } = await awaitingStockRequest(1);

    await expect(
      refundInsteadOfReplace(prisma, {
        stockReplacementId: replacement.id,
        executedBy: adminId,
        method: RefundExecutionMethod.MANUAL_TRANSFER,
      }),
    ).rejects.toThrow(ValidationError);
    // The whole fallback rolled back — no half-written refund left behind.
    expect(await prisma.refund.count()).toBe(0);
    const reloaded = await prisma.stockReplacement.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(reloaded.status).toBe(StockReplacementStatus.AWAITING_STOCK);
  });
});

/**
 * `refundableAmountForUnit`'s FX branch, driven end-to-end (whole-branch review
 * B7). `OrderItem.unitPrice` is ALWAYS the catalog's central-IDR price and does
 * not follow `Order.currency`, so a USDT order's unit has to come back divided
 * by that order's own `fxRate` snapshot. Nothing else in this file exercised
 * that divide — every other case above is an IDR order, where the branch is
 * skipped — which left a USDT buyer being paid an IDR figure as though it were
 * USDT (a ~16000x overpayment at a real rate) invisible to the suite.
 *
 * The order is converted after delivery rather than created as USDT because
 * `createOrderDirect` mints IDR orders only; this is the same
 * update-currency-and-fxRate-afterwards pattern `binance_internal.test.ts`'s own
 * USDT refund test uses. The rate is a deliberately unrealistic 2.5 so the
 * expected figures stay exact at 4dp and a reader can check the arithmetic by
 * eye — the branch under test is a plain divide, and a 16000-ish rate would only
 * hide it behind rounding.
 */
describe("refundInsteadOfReplace — a USDT order pays back in USDT", () => {
  /** An AWAITING_STOCK request on a `quantity`-unit order re-denominated in USDT
   *  at `fxRate`, with `totalAmount` restated in USDT the way a real USDT
   *  checkout would have stored it (that column is `executeRefund`'s own payout
   *  ceiling, so leaving it as rupiah would make this test pass for the wrong
   *  reason). */
  async function usdtAwaitingStockRequest(opts: {
    quantity?: number;
    voucherCode?: string;
    fxRate: string;
    usdtTotal: string;
  }) {
    const { order, items } = await makeDeliveredOrder(opts.quantity ?? 1, opts.voucherCode);
    await prisma.order.update({
      where: { id: order.id },
      data: { currency: "USDT", fxRate: opts.fxRate, totalAmount: opts.usdtTotal },
    });
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "no stock to replace it with",
      executedBy: adminId,
    });
    expect(replacement.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    return { order, items, replacement };
  }

  it("divides the unit's rupiah price by the order's own fxRate snapshot", async () => {
    // 1 unit at the catalog's 5.00 IDR, order fxRate 2.5 -> 2.0000 USDT.
    const { items, replacement } = await usdtAwaitingStockRequest({ fxRate: "2.5", usdtTotal: "2" });
    expect(new Decimal(items[0]!.unitPrice).equals(new Decimal("5"))).toBe(true);

    const result = await refundInsteadOfReplace(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    expect(new Decimal(result.execution.amount).equals(new Decimal("2"))).toBe(true);
    // Not the raw rupiah figure — the whole point of the branch.
    expect(new Decimal(result.execution.amount).equals(new Decimal("5"))).toBe(false);
    expect(result.execution.currency).toBe("USDT");
    expect(result.refund.currency).toBe("USDT");
  });

  it("credits walletBalanceUsdt, leaving the buyer's rupiah balance untouched", async () => {
    const { replacement } = await usdtAwaitingStockRequest({ fxRate: "2.5", usdtTotal: "2" });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });

    await refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(after.walletBalanceUsdt).minus(before.walletBalanceUsdt).equals(new Decimal("2"))).toBe(true);
    expect(new Decimal(after.walletBalance).equals(new Decimal(before.walletBalance))).toBe(true);
  });

  it("prorates the order-level discount BEFORE converting, not after", async () => {
    // 2 x 5.00 = 10.00 IDR subtotal, 10% voucher = 1.00 off, so the unit is
    // worth 4.50 IDR; at fxRate 2.5 that is 1.8000 USDT. Converting first and
    // prorating after would give the same figure here only by luck of the
    // arithmetic being linear — what this pins is that the discount is applied
    // at all on the USDT path, which the IDR voucher test above cannot show.
    const { replacement } = await usdtAwaitingStockRequest({
      quantity: 2,
      voucherCode: "SAVE10",
      fxRate: "2.5",
      usdtTotal: "3.6",
    });

    const result = await refundInsteadOfReplace(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    expect(new Decimal(result.execution.amount).equals(new Decimal("1.8"))).toBe(true);
  });

  it("posts the USDT payout to the USDT side of the ledger, balanced", async () => {
    const { replacement } = await usdtAwaitingStockRequest({ fxRate: "2.5", usdtTotal: "2" });

    await refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId });

    const posting = await prisma.financialTransaction.findFirstOrThrow({
      where: { referenceType: "refund_execution" },
    });
    const entries = await prisma.ledgerEntry.findMany({
      where: { financialTransactionId: posting.id },
    });
    expect(entries.length).toBeGreaterThan(0);
    // Every leg in USDT — an IDR leg here would mean the payout was booked
    // against the rupiah control account while the buyer was paid in USDT.
    expect(entries.every((e) => e.currency === "USDT")).toBe(true);
    const sum = (direction: string) =>
      entries
        .filter((e) => e.direction === direction)
        .reduce((acc, e) => acc.plus(new Decimal(e.amount)), new Decimal(0));
    expect(sum("DEBIT").equals(sum("CREDIT"))).toBe(true);
    expect(sum("DEBIT").equals(new Decimal("2"))).toBe(true);
  });

  it("falls back to the rupiah figure when a USDT order carries no fxRate snapshot", async () => {
    // The `order.fxRate != null` half of the guard. A USDT order with no rate
    // recorded is a data defect, not a state checkout can produce — this pins
    // that the divide is SKIPPED rather than throwing or dividing by zero, so an
    // admin gets a refusable figure instead of a crash. The payout is then
    // refused by `executeRefund`'s own ceiling, which is the fail-closed
    // outcome: nothing is paid out against a rate nobody recorded.
    const { replacement } = await usdtAwaitingStockRequest({ fxRate: "2.5", usdtTotal: "2" });
    await prisma.order.update({
      where: { id: (await prisma.stockReplacement.findUniqueOrThrow({
        where: { id: replacement.id },
        select: { orderItem: { select: { orderId: true } } },
      })).orderItem.orderId },
      data: { fxRate: null },
    });

    await expect(
      refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
    expect(await prisma.refundExecution.count()).toBe(0);
  });
});
