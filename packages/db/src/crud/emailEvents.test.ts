import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { EMAIL_EVENT_REGISTRY } from "@app/core/email";
import { OrderStatus, StockActorType, SenderType, RefundStatus, RefundExecutionMethod } from "@app/core/enums";
import { enqueueEmailEvent } from "./emailEvents";
import { setSetting } from "./settings";
import { emailPolicyKey, isEmailEventEnabled } from "./emailPolicy";
import { createOrderDirect, attachPaymentProof, settlePaidOrder, cancelOrder, enqueueBuyerOrderReadyEmailIfGuest, getOrder } from "./orders";
import { markOrderUnderpaid, transitionOrderStatus } from "./orderStatus";
import { createTicket, addTicketMessage } from "./support";
import { bulkAddStock } from "./stock";
import { createRefund, transitionRefundStatus, executeRefund } from "./refunds";
import { recordEmailLoginFailure, recordEmailProviderHealth, clearEmailLoginFailures } from "./emailSecurity";
import { setLoginCredentials } from "./webauth";
import { queueEmailReports, closedEmailReportPeriods } from "./emailReports";
import { refundUnderpaidOrder } from "./binance_internal";

let testDb: TestDb, db: PrismaClient, sample: SampleData;
beforeAll(async () => { testDb = await makeTestDb(); db = testDb.prisma; });
afterAll(async () => { await testDb.cleanup(); });
beforeEach(async () => {
  await resetDb(db); sample = await buildSampleData(db);
  await db.notificationOutbox.deleteMany({ where: { channel: "EMAIL" } });
  await db.user.update({ where: { id: sample.user.id }, data: { email: "buyer@example.com", passwordHash: "existing-password-hash" } });
  await setSetting(db, "owner_email", "owner@example.com");
  for (const row of EMAIL_EVENT_REGISTRY) await setSetting(db, emailPolicyKey(row.key), "true");
});
const events = () => db.notificationOutbox.findMany({ where: { channel: "EMAIL" }, orderBy: { id: "asc" } });
const order = async () => (await db.$transaction((tx) => createOrderDirect(tx, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1 })))!;

describe("all 23 event policies and durable target dedup", () => {
  it.each(EMAIL_EVENT_REGISTRY)("$key resolves audience, persists exactly one target, and handles disabled/no recipient", async (row) => {
    const args = { key: row.key, aggregateId: "fact", userId: sample.user.id, payload: row.mandatory ? { reset_url: "https://shop.example/reset/one-use-secret" } : {} };
    expect(await enqueueEmailEvent(db, args)).toBe(true);
    expect(await enqueueEmailEvent(db, args)).toBe(false);
    let rows = await events(); expect(rows).toHaveLength(1); expect(rows[0]!.status).toBe("PENDING");
    expect(JSON.parse(rows[0]!.payloadJson).to).toBe(row.audience === "admin" ? "owner@example.com" : "buyer@example.com");
    if (row.mandatory) expect(rows[0]!.payloadJson).not.toContain("one-use-secret");
    await setSetting(db, emailPolicyKey(row.key), "false");
    expect(await isEmailEventEnabled(db, row.key)).toBe(row.mandatory);
    await enqueueEmailEvent(db, { ...args, aggregateId: "disabled" });
    rows = await events(); expect(rows[1]!.status).toBe(row.mandatory ? "PENDING" : "SKIPPED");
    if (!row.mandatory) expect(rows[1]!.lastError).toBe("SKIPPED_DISABLED");
    await setSetting(db, emailPolicyKey(row.key), "true");
    await enqueueEmailEvent(db, { ...args, aggregateId: "no-email", to: null });
    rows = await events(); expect(rows[2]!.status).toBe("SKIPPED"); expect(rows[2]!.lastError).toBe("SKIPPED_NO_RECIPIENT");
  });
});

describe("skipped email events never hold the dedupe slot", () => {
  it("re-enabling an event lets a later occurrence of the same fact enqueue, while repeats of a skip stay deduped", async () => {
    const key = "support.ticket.created.admin" as const;
    const args = { key, aggregateId: "ticket-1", userId: sample.user.id, payload: {} };
    await setSetting(db, emailPolicyKey(key), "false");
    expect(await enqueueEmailEvent(db, args)).toBe(true);
    expect(await enqueueEmailEvent(db, args)).toBe(false); // repeated skip: no pile-up of SKIPPED rows
    let rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("SKIPPED");
    await setSetting(db, emailPolicyKey(key), "true");
    expect(await enqueueEmailEvent(db, args)).toBe(true);
    rows = await events();
    expect(rows.map((r) => r.status)).toEqual(["SKIPPED", "PENDING"]);
    expect(await enqueueEmailEvent(db, args)).toBe(false); // the real PENDING row still dedupes
  });
});

describe("real authoritative lifecycle producers", () => {
  it("new web order fans out once, true payment and registered completion are durable, repeated receipt dedups", async () => {
    const created = await order();
    expect((await events()).filter((r) => r.event.startsWith("order.received"))).toHaveLength(2);
    expect((await events()).some((r) => r.event === "payment.confirmed.customer")).toBe(false);
    await attachPaymentProof(db, created.id, { fileId: "fake-fixture-proof", txid: "trusted-admin-evidence" });
    await db.$transaction((tx) => settlePaidOrder(tx, created.id, { adminId: sample.user.id }));
    expect((await events()).filter((r) => r.event === "payment.confirmed.customer")).toHaveLength(1);
    const completed = (await getOrder(db, created.id))!;
    await enqueueBuyerOrderReadyEmailIfGuest(db, completed);
    const receipts = (await events()).filter((r) => r.event === "BUYER_EMAIL_ORDER_READY");
    expect(receipts).toHaveLength(1); expect(JSON.parse(receipts[0]!.payloadJson).to).toBe("buyer@example.com");
    expect(receipts[0]!.payloadJson).not.toContain("pwd1");
  });
  it("terminal failure fans out once while pending does not", async () => {
    const created = await order();
    await transitionOrderStatus(db, { orderId: created.id, from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.FAILED });
    expect((await events()).filter((r) => r.event.startsWith("order.failed"))).toHaveLength(2);
    await expect(transitionOrderStatus(db, { orderId: created.id, from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.FAILED })).rejects.toBeTruthy();
    expect((await events()).filter((r) => r.event.startsWith("order.failed"))).toHaveLength(2);
  });
  it("verified underpayment and expiry generate the appropriate facts without a second callback email", async () => {
    const created = await order();
    await db.order.update({ where: { id: created.id }, data: { paymentMethod: "PAYDISINI" } });
    expect(await markOrderUnderpaid(db, { orderId: created.id, gateway: "PayDisini", expectedAmount: created.totalAmount, receivedAmount: "2" })).toBe(true);
    expect(await markOrderUnderpaid(db, { orderId: created.id, gateway: "PayDisini", expectedAmount: created.totalAmount, receivedAmount: "2" })).toBe(false);
    expect((await events()).filter((r) => r.event.startsWith("payment.underpaid"))).toHaveLength(2);
    const expiring = await order(); await db.order.update({ where: { id: expiring.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await db.$transaction((tx) => cancelOrder(tx, expiring.id, "expired", { type: StockActorType.SYSTEM }));
    expect((await events()).filter((r) => r.event === "payment.expired.customer")).toHaveLength(1);
  });
  it("direct underpaid wallet refunds emit one completion only after money moves", async () => {
    const created = await order();
    await db.order.update({ where: { id: created.id }, data: { paymentMethod: "PAYDISINI" } });
    expect(await markOrderUnderpaid(db, { orderId: created.id, gateway: "PayDisini", expectedAmount: created.totalAmount, receivedAmount: "2" })).toBe(true);
    const refunded = await refundUnderpaidOrder(db, { orderId: created.id, adminId: sample.user.id });
    expect(refunded.refunded.toString()).toBe("2");
    const completed = (await events()).filter((r) => r.event === "refund.completed.customer");
    expect(completed).toHaveLength(1);
    expect(JSON.parse(completed[0]!.payloadJson)).toMatchObject({ amount: "2", currency: "IDR", payout_method: "WALLET" });
    await expect(refundUnderpaidOrder(db, { orderId: created.id, adminId: sample.user.id })).rejects.toBeTruthy();
    expect((await events()).filter((r) => r.event === "refund.completed.customer")).toHaveLength(1);
  });
  it.each([
    ["0", "5", "PayDisini"], ["-1", "5", "PayDisini"], ["5", "5", "PayDisini"], ["6", "5", "PayDisini"],
    ["NaN", "5", "PayDisini"], ["2", "Infinity", "PayDisini"], ["2", "10", "PayDisini"], ["2", "5", "TokoPay"],
  ])("invalid underpayment evidence %s/%s from %s produces no status or email fact", async (received, expected, gateway) => {
    const created = await order();
    await db.order.update({ where: { id: created.id }, data: { paymentMethod: "PAYDISINI" } });
    expect(await markOrderUnderpaid(db, { orderId: created.id, gateway, expectedAmount: expected, receivedAmount: received })).toBe(false);
    expect((await getOrder(db, created.id))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(await db.qrisUnderpaidTx.count({ where: { orderId: created.id } })).toBe(0);
    expect((await events()).filter((r) => r.event.startsWith("payment.underpaid"))).toHaveLength(0);
  });
  it("stock episodes cross critical/out/recovery once and supplier SKUs are excluded", async () => {
    for (let i = 0; i < 5; i++) await order();
    const stockEvents = (await events()).filter((r) => r.event.startsWith("inventory.sku"));
    expect(stockEvents.map((r) => r.event)).toEqual(["inventory.sku.critical", "inventory.sku.out_of_stock"]);
    await bulkAddStock(db, sample.product.id, ["a:pw", "b:pw", "c:pw", "d:pw"]);
    expect((await events()).filter((r) => r.event === "inventory.sku.restocked")).toHaveLength(1);
    await bulkAddStock(db, sample.product.id, ["e:pw"]);
    expect((await events()).filter((r) => r.event === "inventory.sku.restocked")).toHaveLength(1);
    await db.denomination.update({ where: { id: sample.product.id }, data: { autoDeliverySource: "digiflazz" } });
    await bulkAddStock(db, sample.product.id, ["f:pw"]);
    expect((await events()).filter((r) => r.event.startsWith("inventory.sku"))).toHaveLength(3);
  });
  it("concurrent checkouts serialize threshold counts without conflicting denomination foreign-key locks", async () => {
    const created = await Promise.all(Array.from({ length: 5 }, () => order()));
    expect(created).toHaveLength(5);
    expect((await events()).filter((r) => r.event.startsWith("inventory.sku")).map((r) => r.event))
      .toEqual(["inventory.sku.critical", "inventory.sku.out_of_stock"]);
  });
  it("expiry mail requires an elapsed unpaid invoice and a concurrent payment keeps its stock", async () => {
    const future = await order();
    await cancelOrder(db, future.id, "expired", { type: StockActorType.SYSTEM });
    expect((await events()).filter((r) => r.event === "payment.expired.customer")).toHaveLength(0);

    const paying = await order();
    await attachPaymentProof(db, paying.id, { fileId: "fixture-proof", txid: "fixture-evidence" });
    await db.order.update({ where: { id: paying.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    let paymentClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { paymentClaimed = resolve; });
    let finishPayment!: () => void;
    const finish = new Promise<void>((resolve) => { finishPayment = resolve; });
    const payment = db.$transaction(async (tx) => {
      await settlePaidOrder(tx, paying.id, { adminId: sample.user.id });
      paymentClaimed();
      await finish;
    });
    await claimed;
    const expiry = cancelOrder(db, paying.id, "expired", { type: StockActorType.SYSTEM });
    finishPayment();
    await payment;
    await expect(expiry).rejects.toBeTruthy();
    expect((await getOrder(db, paying.id))?.status).toBe(OrderStatus.DELIVERED);
    expect((await events()).filter((r) => r.event === "payment.expired.customer")).toHaveLength(0);
  });
  it("support creation fans out, only an actual non-internal admin reply emails the owner", async () => {
    const ticket = await createTicket(db, sample.user.id, "Question");
    await addTicketMessage(db, { ticketId: ticket.id, senderType: SenderType.USER, senderId: sample.user.id, content: "Details" });
    await addTicketMessage(db, { ticketId: ticket.id, senderType: SenderType.ADMIN, senderId: sample.user.id, content: "Internal", internal: true });
    expect((await events()).filter((r) => r.event === "support.ticket.replied.customer")).toHaveLength(0);
    await addTicketMessage(db, { ticketId: ticket.id, senderType: SenderType.ADMIN, senderId: sample.user.id, content: "Reply" });
    expect((await events()).filter((r) => r.event.startsWith("support.ticket"))).toHaveLength(3);
  });
  it("concurrent public admin replies each persist one message and notification", async () => {
    const ticket = await createTicket(db, sample.user.id, "Question");
    const replies = await Promise.all(Array.from({ length: 3 }, (_, i) => addTicketMessage(db, {
      ticketId: ticket.id, senderType: SenderType.ADMIN, senderId: sample.user.id, content: `Reply ${i}`,
    })));
    expect(replies).toHaveLength(3);
    expect(await db.ticketMessage.count({ where: { ticketId: ticket.id } })).toBe(3);
    expect((await events()).filter((r) => r.event === "support.ticket.replied.customer")).toHaveLength(3);
  });
  it("refund processing requires state; completion mail requires recorded payout, not just marking a record", async () => {
    const created = await order();
    const refund = await createRefund(db, { orderId: created.id, amount: "2", currency: "IDR", adminId: sample.user.id });
    await transitionRefundStatus(db, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: sample.user.id });
    expect((await events()).filter((r) => r.event === "refund.initiated.customer")).toHaveLength(1);
    await executeRefund(db, { refundId: refund.id, method: RefundExecutionMethod.WALLET, amount: "2", executedBy: sample.user.id });
    expect((await events()).filter((r) => r.event === "refund.completed.customer")).toHaveLength(1);
  });
  it("refund record-keeping cannot claim payout and completion reports the executed amount", async () => {
    const created = await order();
    const unpaid = await createRefund(db, { orderId: created.id, amount: "2", currency: "IDR", adminId: sample.user.id });
    await transitionRefundStatus(db, { refundId: unpaid.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: sample.user.id });
    await transitionRefundStatus(db, { refundId: unpaid.id, from: RefundStatus.PROCESSING, to: RefundStatus.COMPLETED, adminId: sample.user.id, acknowledgeNoPayout: true });
    expect((await events()).filter((r) => r.event === "refund.completed.customer")).toHaveLength(0);
    const paid = await createRefund(db, { orderId: created.id, amount: "2", currency: "IDR", adminId: sample.user.id });
    await transitionRefundStatus(db, { refundId: paid.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: sample.user.id });
    await expect(executeRefund(db, { refundId: paid.id, method: RefundExecutionMethod.MANUAL_TRANSFER, amount: "1", executedBy: sample.user.id })).rejects.toBeTruthy();
    expect((await events()).filter((r) => r.event === "refund.completed.customer")).toHaveLength(0);
    await executeRefund(db, { refundId: paid.id, method: RefundExecutionMethod.WALLET, amount: "1", executedBy: sample.user.id });
    const completion = (await events()).filter((r) => r.event === "refund.completed.customer");
    expect(completion).toHaveLength(1);
    expect(JSON.parse(completion[0]!.payloadJson)).toMatchObject({ amount: "1", currency: "IDR", payout_method: "WALLET" });
  });
  it("password mutation and five measured failures emit once, provider threshold/recovery has cooldown", async () => {
    await setLoginCredentials(db, sample.user.id, { passwordHash: "new-password-hash" });
    await setLoginCredentials(db, sample.user.id, { passwordHash: "new-password-hash" });
    expect((await events()).filter((r) => r.event === "security.password.changed")).toHaveLength(1);
    const now = new Date("2026-10-10T12:00:00Z");
    for (let i = 0; i < 4; i++) await recordEmailLoginFailure(db, sample.user.id, now);
    expect((await events()).filter((r) => r.event === "security.login.suspicious")).toHaveLength(0);
    for (let i = 0; i < 5; i++) await recordEmailLoginFailure(db, sample.user.id, now);
    expect((await events()).filter((r) => r.event === "security.login.suspicious")).toHaveLength(1);
    for (let i = 0; i < 5; i++) await recordEmailProviderHealth(db, "TOKOPAY", false, now);
    expect((await events()).filter((r) => r.event === "provider.incident.opened")).toHaveLength(1);
    await recordEmailProviderHealth(db, "TOKOPAY", true, now);
    for (let i = 0; i < 3; i++) await recordEmailProviderHealth(db, "TOKOPAY", false, now);
    expect((await events()).filter((r) => r.event === "provider.incident.opened")).toHaveLength(1);
  });
  it("daily and weekly scheduler close local periods once and preserve separate currencies", async () => {
    const now = new Date("2026-10-12T01:00:00Z");
    for (const key of ["report.daily_sales_inventory", "report.weekly_revenue"]) await setSetting(db, `email_report_enabled_at:${key}`, "2026-10-01T00:00:00Z");
    expect(await queueEmailReports(db, now)).toBe(2); expect(await queueEmailReports(db, now)).toBe(0);
    const reports = (await events()).filter((r) => r.event.startsWith("report.")); expect(reports).toHaveLength(2);
    expect(JSON.parse(reports[0]!.payloadJson).period_end).toBe("2026-10-11T17:00:00.000Z");
    const boundary = closedEmailReportPeriods(new Date("2026-10-11T16:59:59Z"), { timezone: "Asia/Jakarta", dailyTime: "00:00", weeklyDay: 1, weeklyTime: "00:00" });
    expect(boundary[1]!.end.toISOString()).toBe("2026-10-04T17:00:00.000Z");
  });
  it("concurrent security/provider observations aggregate without losing counts or bypassing cooldown", async () => {
    const now = new Date("2026-10-10T12:00:00Z");
    await Promise.all(Array.from({ length: 5 }, () => recordEmailLoginFailure(db, sample.user.id, now)));
    expect((await events()).filter((r) => r.event === "security.login.suspicious")).toHaveLength(1);
    await clearEmailLoginFailures(db, sample.user.id);
    await Promise.all(Array.from({ length: 5 }, () => recordEmailLoginFailure(db, sample.user.id, now)));
    expect((await events()).filter((r) => r.event === "security.login.suspicious")).toHaveLength(1);
    await Promise.all(Array.from({ length: 3 }, () => recordEmailProviderHealth(db, "concurrent-provider", false, now)));
    expect((await events()).filter((r) => r.event === "provider.incident.opened")).toHaveLength(1);
  });
  it("report activation excludes history and configured send times preserve calendar periods", async () => {
    const now = new Date("2026-10-12T01:00:00Z");
    expect(await queueEmailReports(db, now)).toBe(0);
    expect(await queueEmailReports(db, now)).toBe(0);
    const boundary = closedEmailReportPeriods(new Date("2026-10-12T02:59:59Z"), { timezone: "Asia/Jakarta", dailyTime: "10:00", weeklyDay: 3, weeklyTime: "10:00" });
    expect(boundary[0]!.start.toISOString()).toBe("2026-10-09T17:00:00.000Z");
    expect(boundary[0]!.end.toISOString()).toBe("2026-10-10T17:00:00.000Z");
    expect(boundary[1]!.start.toISOString()).toBe("2026-09-27T17:00:00.000Z");
    expect(boundary[1]!.end.toISOString()).toBe("2026-10-04T17:00:00.000Z");
    expect(await queueEmailReports(db, new Date("2026-10-13T01:00:00Z"))).toBe(1);
  });
});
