import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect } from "./orders";
import { createRefund, createRefundItem, executeRefund } from "./refunds";

let db: TestDb;
let sample: SampleData;
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => { await resetDb(db.prisma); sample = await buildSampleData(db.prisma); });
async function fixture(currency = "USDT", total = "4.94") {
  const order = (await createOrderDirect(db.prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
  await db.prisma.order.update({ where: { id: order.id }, data: { currency, totalAmount: total, fxRate: "16000" } });
  const item = await db.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  await db.prisma.orderItem.update({ where: { id: item.id }, data: { unitPrice: "79000" } });
  return { order, item, adminId: sample.user.id };
}
describe("refund currency and order budgets", () => {
  it("refuses 5000 USDT against a Rp79000 item even on a legacy oversized refund", async () => {
    const { order, item, adminId } = await fixture();
    const refund = await db.prisma.refund.create({ data: { orderId: order.id, amount: "5000", currency: "USDT" } });
    await expect(createRefundItem(db.prisma, { refundId: refund.id, orderItemId: item.id, amount: "5000", adminId })).rejects.toMatchObject({ key: "error.refund_exceeds_item_subtotal" });
  });
  it.each([["USDT", "4.94"], ["IDR", "79000"]])("accepts the exact %s item cap", async (currency, total) => {
    const { order, item, adminId } = await fixture(currency, total);
    const refund = await createRefund(db.prisma, { orderId: order.id, amount: total, currency, adminId });
    const row = await createRefundItem(db.prisma, { refundId: refund.id, orderItemId: item.id, amount: total, adminId });
    expect(row.amount.toString()).toBe(total);
  });
  it("refuses drafts over the order total and reserves concurrent drafts atomically", async () => {
    const { order, adminId } = await fixture();
    await expect(createRefund(db.prisma, { orderId: order.id, amount: "5", currency: "USDT", adminId })).rejects.toMatchObject({ key: "error.refund_exceeds_refundable_amount" });
    const results = await Promise.allSettled([1, 2].map(() => createRefund(db.prisma, { orderId: order.id, amount: "3", currency: "USDT", adminId })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
  });
  it.each([
    ["USDT", "0", "USDT", "5", "5"],
    ["USDT", "3", "USDT", "2", "5"],
    ["IDR", "0", "IDR", "79000", "79000"],
    ["IDR", "49000", "IDR", "30000", "79000"],
    ["USDT", "3", "IDR", "32000", "5"],
  ])("includes actual wallet debit for %s gateway %s and %s wallet %s", async (currency, total, walletCurrency, debit, cap) => {
    const { order, adminId } = await fixture(currency, total);
    await db.prisma.walletTransaction.create({ data: { userId: sample.user.id, orderId: order.id, currency: walletCurrency, reason: "order_payment", delta: `-${debit}`, balanceAfter: "0" } });
    const refund = await createRefund(db.prisma, { orderId: order.id, amount: cap, currency, adminId });
    await db.prisma.refund.update({ where: { id: refund.id }, data: { status: "PROCESSING" } });
    const payout = await executeRefund(db.prisma, { refundId: refund.id, amount: cap, method: "WALLET", executedBy: adminId });
    expect(payout.amount.toString()).toBe(cap);
  });
  it("deducts released wallet holds from the enlarged budget", async () => {
    const { order, adminId } = await fixture("USDT", "3");
    await db.prisma.walletTransaction.createMany({ data: [
      { userId: sample.user.id, orderId: order.id, currency: "USDT", reason: "order_payment", delta: "-2", balanceAfter: "0" },
      { userId: sample.user.id, orderId: order.id, currency: "USDT", reason: "order_refund", delta: "2", balanceAfter: "2" },
    ] });
    await expect(createRefund(db.prisma, { orderId: order.id, amount: "5", currency: "USDT", adminId })).rejects.toMatchObject({ key: "error.refund_exceeds_refundable_amount" });
  });
  it("refuses cross-currency refund items and missing historical exchange rates", async () => {
    const { order, item, adminId } = await fixture();
    const refund = await createRefund(db.prisma, { orderId: order.id, amount: "4.94", currency: "USDT", adminId });
    await db.prisma.order.update({ where: { id: order.id }, data: { fxRate: null } });
    await expect(createRefundItem(db.prisma, { refundId: refund.id, orderItemId: item.id, amount: "1", adminId })).rejects.toMatchObject({ key: "error.refund_exchange_rate_missing" });
    await db.prisma.refund.update({ where: { id: refund.id }, data: { currency: "IDR" } });
    await expect(createRefundItem(db.prisma, { refundId: refund.id, orderItemId: item.id, amount: "1", adminId })).rejects.toMatchObject({ key: "error.refund_currency_mismatch" });
  });

});
