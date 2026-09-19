/**
 * Shared test fixture — the Vitest port of conftest.py's `sample_data`:
 * 1 user, 1 category, 1 product with 5 stock items, 1 voucher.
 *
 * `resetDb` wipes all rows (FK-safe order) so a single test DB can be reused
 * across tests in a file — far cheaper than spinning a fresh `prisma db push`
 * per test. Call resetDb + buildSampleData in beforeEach.
 */
import type { PrismaClient } from "@prisma/client";
import {
  upsertUser,
  createCategory,
  createCatalogProduct,
  createDenomination,
  bulkAddStock,
  createVoucher,
  seedChartOfAccounts,
  setSetting,
  MIN_ORDER_AMOUNT_IDR_KEY,
  __clearSettingsCacheForTests,
} from "@app/db";
import { ProductType, VoucherType } from "@app/core/enums";

export async function buildSampleData(prisma: PrismaClient) {
  const user = await upsertUser(prisma, {
    telegramId: 42,
    username: "tester",
    fullName: "Test User",
  });
  const category = await createCategory(prisma, "Streaming", "🎬");
  const parentProduct = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: "Netflix Premium 1M",
    description: "Shared profile",
  });
  const product = await createDenomination(prisma, {
    productId: parentProduct.id,
    name: "Netflix Premium 1M",
    type: ProductType.SHARED,
    durationLabel: "1 Month",
    price: "5.00",
    resellerPrice: "4.00",
    warrantyDays: 30,
    description: "Shared profile",
  });
  await bulkAddStock(
    prisma,
    product.id,
    Array.from({ length: 5 }, (_, i) => `user${i + 1}@example.com:pwd${i + 1}`),
  );
  const voucher = await createVoucher(prisma, {
    code: "SAVE10",
    type: VoucherType.PERCENT,
    value: "10",
    usageLimit: 100,
    minPurchase: "3",
  });
  // The sample shop has NO shop-wide minimum order amount. Its product costs
  // Rp5.00 — two orders of magnitude under `min_order_amount_idr`'s real default
  // of Rp1.000 (crud/orderMinimums.ts, M11) — so leaving that default in force
  // here would make every fixture-built order unfinalizable on every gateway,
  // for a reason none of those tests are about. Written as an explicit "0"
  // rather than left unset, because unset is what SELECTS the default: this is
  // the fixture declaring a configuration, not bypassing one. The guard itself
  // is covered by packages/db/src/crud/orderMinimums.test.ts, which sets real
  // minimums, and any test that wants a minimum in force can set one too.
  await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
  // `product` is the Denomination/SKU (id used by the order/stock flow);
  // `parentProduct` is the mid-tier Product wrapper (the row the bot's flat
  // list shows and whose picker collapses to this single denomination).
  return { user, category, product, parentProduct, voucher };
}

export type SampleData = Awaited<ReturnType<typeof buildSampleData>>;

/** Delete every row, children before parents, so each test starts clean. */
export async function resetDb(prisma: PrismaClient) {
  // The Setting table is wiped below via a raw deleteMany (not deleteSetting),
  // which would otherwise leave getSetting's in-memory cache serving stale
  // values against a now-empty table.
  __clearSettingsCacheForTests(prisma);
  await prisma.idempotencyRecord.deleteMany();
  await prisma.notificationOutbox.deleteMany();
  // StockReplacement (Financial Ledger M18) points at an OrderItem, two
  // StockItems, a Refund and a SupportTicket, ALL onDelete: Restrict — a
  // replacement record is an audit record of a delivered-goods correction, so
  // it has to go before any of those five, which is why it leads this list
  // rather than sitting beside the refund rows further down.
  await prisma.stockReplacement.deleteMany();
  await prisma.ticketMessage.deleteMany();
  await prisma.supportTicket.deleteMany();
  await prisma.review.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.restockSubscription.deleteMany();
  // AdminTask.order/orderItem/refund are all onDelete:Restrict (Task 9a —
  // same operational-audit-record policy as Refund/RefundItem) — must be
  // cleared before RefundItem/Refund/OrderItem/Order, or a leftover
  // AdminTask row blocks any of those deletes below.
  await prisma.adminTask.deleteMany();
  // RefundExecution.refund is onDelete:Restrict (Financial Ledger M1 — a
  // recorded payout is a financial-audit record and must never be erasable by
  // deleting its Refund) — must be cleared before Refund, or a payout row left
  // behind by `executeRefund` blocks that delete and every later one with it.
  await prisma.refundExecution.deleteMany();
  // RefundItem.orderItem and Refund.order are both onDelete:Restrict
  // (Refund domain, Task 8a — same financial-audit-record policy as
  // OrderItem/OrderStatusHistory) — must be cleared before OrderItem/Order,
  // or a leftover Refund/RefundItem row blocks the delete below.
  await prisma.refundItem.deleteMany();
  await prisma.refund.deleteMany();
  // SettlementTransaction.payment and .settlement are both onDelete:Restrict
  // (Infra-5 policy — a settlement line is a financial-audit record that
  // neither its batch nor the Payment it matched may silently erase), so both
  // tables have to go before Payment, or a line left behind by
  // `recordSettlement` (task F1) blocks that delete and every later one with
  // it. Settlement itself has no FK of its own, but it is cleared here so a
  // batch row cannot survive into the next test and be counted by
  // `listSettlements`.
  await prisma.settlementTransaction.deleteMany();
  await prisma.settlement.deleteMany();
  // Payment.order is onDelete:Restrict (Trustance Phase A Task A2a — same
  // financial-audit-record policy as Refund/RefundItem/OrderStatusHistory) —
  // must be cleared before Order, or a leftover Payment row blocks the
  // delete below.
  await prisma.payment.deleteMany();
  await prisma.orderItem.deleteMany();
  // OrderStatusHistory.order is onDelete:Restrict (audit trail, same policy as
  // OrderItem/Review) — must be cleared before Order, or a row left over from
  // a transitionOrderStatus() call blocks the delete.
  await prisma.orderStatusHistory.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.bulkPricing.deleteMany();
  await prisma.stockItem.deleteMany();
  await prisma.denomination.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.broadcast.deleteMany();
  // Detection Engine knowledge/index tables. No FKs among them, and
  // DetectionOverride.createdBy → User is a plain nullable column (no
  // relation/cascade), so ordering vs. user.deleteMany() below is flexible.
  await prisma.detectionIssue.deleteMany();
  await prisma.detectionOverride.deleteMany();
  await prisma.detectionAlias.deleteMany();
  await prisma.detectionToken.deleteMany();
  await prisma.setting.deleteMany();
  // WalletTransaction.user is onDelete:Restrict (Infra-5 fix, security audit
  // 2026-06-23 — it's an append-only ledger, never auto-erased alongside its
  // user) — must be cleared explicitly before deleting users, since there's
  // no cascade to do it implicitly anymore.
  await prisma.walletTransaction.deleteMany();
  await prisma.user.deleteMany();
  // Ledger (Financial Ledger M3). Order settlement, wallet top-ups, manual
  // wallet adjustments and referral commissions all post to the double-entry
  // ledger now, so the chart of accounts has to exist in every test schema or
  // those paths fail on an unknown account code — the same way they would in
  // production if `pnpm seed-chart-of-accounts` had never been run.
  //
  // Postings are cleared each reset so a test can assert "this settlement posted
  // exactly one transaction" without counting another test's rows. The accounts
  // themselves are NOT cleared: they carry no per-test state, and re-seeding 15
  // rows in every beforeEach across the whole suite costs far more than the one
  // count check that skips it. Children first — LedgerEntry → FinancialTransaction
  // and → LedgerAccount are both onDelete: Restrict (Infra-5 policy).
  await prisma.ledgerEntry.deleteMany();
  await prisma.financialTransaction.deleteMany();
  if ((await prisma.ledgerAccount.count()) === 0) {
    await seedChartOfAccounts(prisma);
  }
}
