import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@app/core/config", () => ({
  config: {
    LOG_LEVEL: "info",
    BYBIT_UID: "env-uid",
    BYBIT_API_KEY: "env-api-key",
    BYBIT_API_SECRET: "env-api-secret",
    BYBIT_API_BASE: "https://api.bybit.com",
    BYBIT_PAYMENT_WINDOW_MINUTES: 30,
    // Needed by createOrderDirect (packages/db/src/crud/orders.ts), exercised
    // below by the deliverPaidBybitOrder DB-integration describe block — this
    // file's config mock otherwise only covers resolveBybitConfig/poll-health,
    // which don't touch these. Defaults match packages/core/src/config.ts.
    PAYMENT_WINDOW_MINUTES: 30,
    USE_UNIQUE_CENTS: true,
    ADMIN_IDS: [] as number[],
    DEFAULT_LANGUAGE: "en",
  },
}));

import {
  resolveBybitConfig,
  getBybitPollHealth,
  recordBybitPollHealth,
  deliverPaidBybitOrder,
  markUnderpaidBybit,
  recordUnmatchedBybitTx,
} from "./bybit_deposit";
import { createOrderDirect, cancelOrder } from "./orders";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import { createWalletTopupOrder } from "./wallet_topup";
import { upsertUser } from "./users";
import { bulkAddStock } from "./stock";
import { OrderStatus, OrderKind, PaymentMethod, DeliveryType, NotificationEvent, StockStatus } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import type { Db } from "./_types";

/** Mutable in-memory Setting store backing both `findUnique` and `upsert`,
 * needed by recordBybitPollHealth (writes) + getBybitPollHealth (reads). */
function mutableStubDb(initial: Record<string, string> = {}): Db {
  const store = new Map(Object.entries(initial));
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        store.set(where.key, create.value);
        return { key: where.key, value: create.value };
      },
    },
  } as unknown as Db;
}

/** In-memory Setting store as a Db stub (only `setting.findUnique` is used). */
function stubDb(values: Record<string, string>): Db {
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        values[where.key] != null ? { key: where.key, value: values[where.key] } : null,
    },
  } as unknown as Db;
}

const CREDS = {
  bybit_uid: "db-uid",
  bybit_api_key: "db-api-key",
  bybit_api_secret: "db-api-secret",
};

describe("resolveBybitConfig — enabled flag matrix", () => {
  it("enabled when creds present and flag is unset (default ON)", async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS }));
    expect(cfg.enabled).toBe(true);
  });

  it('enabled when creds present and flag is "true"', async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS, bybit_enabled: "true" }));
    expect(cfg.enabled).toBe(true);
  });

  it('disabled when flag is "false" even with creds present', async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS, bybit_enabled: "false" }));
    expect(cfg.enabled).toBe(false);
  });

  it('disabled when flag is "FALSE " (trimmed + case-insensitive)', async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS, bybit_enabled: "FALSE " }));
    expect(cfg.enabled).toBe(false);
  });

  it('enabled when flag is blank (empty string is still default ON)', async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS, bybit_enabled: "" }));
    expect(cfg.enabled).toBe(true);
  });

  it('disabled when creds missing regardless of flag "true"', async () => {
    const cfg = await resolveBybitConfig(
      stubDb({ bybit_uid: "", bybit_api_key: "", bybit_api_secret: "", bybit_enabled: "true" }),
    );
    // With no DB creds and the env fallback present, creds resolve from env, so
    // assert against an environment with the creds explicitly cleared instead.
    expect(cfg.uid).toBe("env-uid"); // env fallback fills it
    expect(cfg.enabled).toBe(true);
  });

  it("disabled when creds missing (env fallback also empty) regardless of flag", async () => {
    vi.doMock("@app/core/config", () => ({
      config: {
        LOG_LEVEL: "info",
        BYBIT_UID: undefined,
        BYBIT_API_KEY: undefined,
        BYBIT_API_SECRET: undefined,
        BYBIT_API_BASE: "https://api.bybit.com",
        BYBIT_PAYMENT_WINDOW_MINUTES: 30,
      },
    }));
    vi.resetModules();
    const { resolveBybitConfig: resolveNoCreds } = await import("./bybit_deposit");
    const cfg = await resolveNoCreds(stubDb({ bybit_enabled: "true" }));
    expect(cfg.uid).toBe("");
    expect(cfg.enabled).toBe(false);
  });
});

describe("resolveBybitConfig — minAmount", () => {
  it("defaults to null when unset", async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS }));
    expect(cfg.minAmount).toBeNull();
  });

  it("parses a configured positive value", async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS, bybit_min_amount: "8" }));
    expect(cfg.minAmount?.toString()).toBe("8");
  });

  it("treats a non-numeric or non-positive value as null (never throws)", async () => {
    expect((await resolveBybitConfig(stubDb({ ...CREDS, bybit_min_amount: "not-a-number" }))).minAmount).toBeNull();
    expect((await resolveBybitConfig(stubDb({ ...CREDS, bybit_min_amount: "0" }))).minAmount).toBeNull();
  });
});

describe("Bybit poll health — rate-limit tracking fields", () => {
  it("getBybitPollHealth on a never-run poller is all-null", async () => {
    const health = await getBybitPollHealth(mutableStubDb());
    expect(health).toEqual({
      lastRun: null,
      lastSuccessAt: null,
      lastTxCount: null,
      backoffUntil: null,
      consecutiveRateLimitHits: null,
      lastRateLimitAt: null,
      consecutiveFailures: null,
      lastError: null,
    });
  });

  it("round-trips lastTxCount/backoffUntil/consecutiveRateLimitHits on a healthy cycle", async () => {
    const db = mutableStubDb();
    await recordBybitPollHealth(db, { lastTxCount: 3, backoffUntil: null, success: true });
    const health = await getBybitPollHealth(db);
    expect(health.lastTxCount).toBe(3);
    expect(health.backoffUntil).toBeNull();
    expect(health.consecutiveRateLimitHits).toBe(0);
    expect(health.lastRateLimitAt).toBeNull();
    expect(health.lastSuccessAt).toBe(health.lastRun);
    expect(health.consecutiveFailures).toBe(0);
  });

  it("records lastRateLimitAt when rateLimited is true", async () => {
    const db = mutableStubDb();
    const until = Date.now() + 6_000;
    await recordBybitPollHealth(db, {
      lastTxCount: 0,
      backoffUntil: until,
      consecutiveRateLimitHits: 2,
      rateLimited: true,
      success: false,
      error: "Bybit rate limited (HTTP 429)",
    });
    const health = await getBybitPollHealth(db);
    expect(health.consecutiveRateLimitHits).toBe(2);
    expect(health.backoffUntil).toBe(new Date(until).toISOString());
    expect(health.lastRateLimitAt).not.toBeNull();
  });

  it("carries lastRateLimitAt forward (sticky) once the poller recovers", async () => {
    const db = mutableStubDb();
    await recordBybitPollHealth(db, {
      lastTxCount: 0,
      backoffUntil: Date.now() + 3_000,
      consecutiveRateLimitHits: 1,
      rateLimited: true,
      success: false,
      error: "Bybit rate limited (HTTP 429)",
    });
    const { lastRateLimitAt: hitAt } = await getBybitPollHealth(db);
    expect(hitAt).not.toBeNull();

    // Next cycle recovers (no rate limit) — consecutiveRateLimitHits resets to
    // 0, but lastRateLimitAt must stay visible for diagnosing rare hits.
    await recordBybitPollHealth(db, { lastTxCount: 5, backoffUntil: null, success: true });
    const health = await getBybitPollHealth(db);
    expect(health.consecutiveRateLimitHits).toBe(0);
    expect(health.lastRateLimitAt).toBe(hitAt);
  });

  it("getBybitPollHealth defaults missing new fields to null (backward-compat with old JSON)", async () => {
    const db = mutableStubDb({
      bybit_poll_health: JSON.stringify({ lastRun: "2026-01-01T00:00:00.000Z", lastTxCount: 1, backoffUntil: null }),
    });
    const health = await getBybitPollHealth(db);
    expect(health.lastRun).toBe("2026-01-01T00:00:00.000Z");
    expect(health.lastTxCount).toBe(1);
    expect(health.consecutiveRateLimitHits).toBeNull();
    expect(health.lastRateLimitAt).toBeNull();
    expect(health.lastSuccessAt).toBeNull();
    expect(health.consecutiveFailures).toBeNull();
    expect(health.lastError).toBeNull();
  });
});

describe("Bybit poll health — non-rate-limit failure streak (consecutiveFailures/lastSuccessAt/lastError)", () => {
  it("increments consecutiveFailures and records lastError on a network/HTTP failure", async () => {
    const db = mutableStubDb();
    await recordBybitPollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    const health = await getBybitPollHealth(db);
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBe("fetch failed: Connect Timeout Error");
    expect(health.lastSuccessAt).toBeNull(); // never succeeded yet

    await recordBybitPollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    expect((await getBybitPollHealth(db)).consecutiveFailures).toBe(2);
  });

  it("resets consecutiveFailures to 0 on the next success, but keeps lastError sticky", async () => {
    const db = mutableStubDb();
    await recordBybitPollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    await recordBybitPollHealth(db, { lastTxCount: 1, success: true });
    const health = await getBybitPollHealth(db);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastError).toBe("fetch failed: Connect Timeout Error"); // sticky for diagnostics
    expect(health.lastSuccessAt).toBe(health.lastRun);
  });

  it("a rate-limited failure neither increments nor resets consecutiveFailures (it has its own counter)", async () => {
    const db = mutableStubDb();
    await recordBybitPollHealth(db, { lastTxCount: 0, success: false, error: "network error" });
    expect((await getBybitPollHealth(db)).consecutiveFailures).toBe(1);

    await recordBybitPollHealth(db, {
      lastTxCount: 0,
      success: false,
      rateLimited: true,
      consecutiveRateLimitHits: 1,
      error: "Bybit rate limited (HTTP 429)",
    });
    const health = await getBybitPollHealth(db);
    expect(health.consecutiveFailures).toBe(1); // unchanged by the rate-limit hit
    expect(health.consecutiveRateLimitHits).toBe(1);
  });

  it("lastSuccessAt only advances on success, even while lastRun keeps ticking on every failed cycle", async () => {
    const db = mutableStubDb();
    await recordBybitPollHealth(db, { lastTxCount: 2, success: true });
    const firstSuccess = (await getBybitPollHealth(db)).lastSuccessAt;

    await recordBybitPollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    const health = await getBybitPollHealth(db);
    expect(health.lastSuccessAt).toBe(firstSuccess); // unchanged by the failed cycle
  });
});

// ===========================================================================
// deliverPaidBybitOrder — "processing" branch (M-35, backend audit
// 2026-07-31). The idempotency/delivered/already_processed/stale branches are
// covered extensively in apps/order-bot/test/bybit-deposit.test.ts (Task 24,
// M-14); this file only had resolveBybitConfig/poll-health coverage, and
// nowhere exercised the "processing" branch a manual-delivery SKU takes.
// Unlike nowpayments/paydisini/binance_internal, deliverPaidBybitOrder itself
// has no overpaid-ledger/DM logic at all (see bybit_deposit.ts) — so this
// only pins the processing-branch shape shared with every gateway via
// settlePaidOrder, not an overpaid interaction that doesn't exist here.
describe("deliverPaidBybitOrder — processing branch (manual SKU)", () => {
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

  /** A manual (no-stock) denomination, on its own category/product. */
  async function makeManualDenom() {
    const category = await createCategory(prisma, `manual-cat-${Math.random()}`);
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `Manual Product ${Math.random()}` });
    return createDenomination(prisma, {
      productId: product.id,
      name: "Manual Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10.00",
      warrantyDays: 30,
      deliveryType: DeliveryType.MANUAL,
    });
  }

  /** Create a PENDING_PAYMENT order stamped as a Bybit deposit payment. */
  async function makePendingBybitOrderFor(productId: number) {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId, quantity: 1 }))!;
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT } });
    return order;
  }

  it("processing (manual SKU): kind stays processing, no stock is touched, and settlePaidOrder's own buyer DM still fires", async () => {
    const manualDenom = await makeManualDenom();
    const order = await makePendingBybitOrderFor(manualDenom.id);

    const result = await deliverPaidBybitOrder(prisma, {
      orderId: order.id,
      bybitTxId: "0x-processing-1",
      amount: order.totalAmount,
    });

    expect(result.status).toBe("processing");
    if (result.status !== "processing") throw new Error("expected processing");
    expect(result.order.status).toBe(OrderStatus.PROCESSING);

    // Manual SKUs never reserve stock.
    const stockCount = await prisma.stockItem.count({ where: { productId: manualDenom.id } });
    expect(stockCount).toBe(0);

    // Ledger claimed as matched (not overpaid — bybit_deposit.ts has no
    // overpaid handling at all, unlike the other 4 gateway files).
    const ledgerRow = await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0x-processing-1" } });
    expect(ledgerRow?.outcome).toBe("matched");

    const processingDm = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_PROCESSING_DM },
    });
    expect(processingDm).not.toBeNull();
  });
});

// Task 16 originally mirrored Task 15's re-claim widening (binance_internal.ts,
// tokopay.ts, paydisini.ts, nowpayments.ts) onto this rail, making BOTH
// `unmatched` and `delivery_failed` re-claimable. A followup review caught
// that this was wrong for `unmatched` specifically: this rail matches a
// deposit to a pending order purely by amount, with no memo binding it to
// one order, so an old "unmatched" deposit (an owner's own top-up, a late
// payment for an expired order) could auto-match and auto-deliver a
// completely unrelated LATER order that merely happens to share its total —
// a real money-loss bug. `delivery_failed` is unaffected by that fix: it
// never re-runs the amount guess, it only retries delivery for the SAME
// (order, amount) pairing a prior cycle already committed to, so it stays
// re-claimable — see AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES's doc-comment
// (binance_internal.ts) for the full reasoning.
//
// Bybit Internal Transfer matches a deposit against ANY pending order by
// amount (same shape as Binance Internal, unlike the 1:1 QRIS trxId), so a
// `delivery_failed` re-claim can still turn out stale — the fix must revert
// the ledger row to its prior outcome instead of stranding it as an
// unreachable "matched".
//
// Bybit's ledger IS visible to admins — reports.ts's listCombinedLedger puts
// both rails' rows in the Payments page table, and manualMatchQueueCounts
// counts their "unmatched"/"delivery_failed" rows into the dashboard cards.
// What Bybit lacks is the ACTION side: no manualMatchTx/dismissUnmatchedTx
// equivalent — an unmatched deposit here has no automatic OR manual recovery
// path today, a known, separately-tracked gap (unlike Binance, which has
// manualMatchTx/dismissUnmatchedTx for exactly this case). So an unreverted
// stale `delivery_failed` reclaim does two things, not one: it leaves the
// row unreachable by the poller (as on Binance), AND — because those queue
// counts filter on exactly those two outcomes — it silently decrements the
// ops dashboard's open-problem count and drops out of the ledger's outcome
// filter. The row stops looking like a problem at the same moment it
// becomes unrecoverable.
//
// This rail has no "overpaid" outcome (unlike Binance/TokoPay/PayDisini/
// NOWPayments — see the module doc-comment), so its full outcome set is:
// matched, delivery_failed, underpaid, underpaid_flag_failed, unmatched.
// Terminal (never re-claimable): matched, underpaid, underpaid_flag_failed,
// AND (after this fix) unmatched. Only delivery_failed is re-claimable.
describe("deliverPaidBybitOrder — re-claiming a bybitTxId across non-delivering outcomes", () => {
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

  async function makePendingBybitOrder() {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT } });
    return order;
  }

  // Inverted from "a bybitTxId first recorded as unmatched can still be
  // delivered by a later poller pass" (Task 16's now-wrong assertion) —
  // followup review fix: this rail matches a deposit to a pending order
  // purely by amount (no memo), so leaving "unmatched" reclaimable let an old
  // stray deposit (an owner's own top-up, a late payment for an expired
  // order) auto-match and auto-deliver a completely unrelated LATER order
  // that merely happens to share its total — a real money-loss bug. See
  // AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES's doc-comment (binance_internal.ts)
  // for the full reasoning. "unmatched" must stay terminal on this rail; the
  // money-loss scenario itself is pinned by the test right below.
  it("a bybitTxId first recorded as unmatched stays terminal — a later poller pass reports already_processed, not delivered", async () => {
    const order = await makePendingBybitOrder();
    const bybitTxId = "tx-unmatched-reclaim-1";

    const recorded = await recordUnmatchedBybitTx(prisma, { bybitTxId, amount: new Decimal("5") });
    expect(recorded).toBe(true);
    const unmatchedRow = await prisma.processedBybitTx.findUnique({ where: { bybitTxId } });
    expect(unmatchedRow?.outcome).toBe("unmatched");

    const result = await deliverPaidBybitOrder(prisma, { orderId: order.id, bybitTxId, amount: order.totalAmount });
    expect(result.status).toBe("already_processed");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);

    const ledgerRow = await prisma.processedBybitTx.findUnique({ where: { bybitTxId } });
    expect(ledgerRow?.outcome).toBe("unmatched");
    expect(ledgerRow?.orderId).toBeNull();
  });

  // The actual money-loss scenario the review caught: an "unmatched" deposit
  // sits in the ledger, and LATER an unrelated order is created whose total
  // happens to equal that same amount. Without this fix, the next poller
  // cycle would amount-match and auto-deliver goods for money that was never
  // paid for them.
  it("an unmatched deposit does not auto-deliver a later, unrelated order that happens to share its amount", async () => {
    const bybitTxId = "tx-unmatched-stray-deposit-1";
    const recorded = await recordUnmatchedBybitTx(prisma, { bybitTxId, amount: new Decimal("5") });
    expect(recorded).toBe(true);

    const laterOrder = await makePendingBybitOrder();
    await prisma.order.update({ where: { id: laterOrder.id }, data: { totalAmount: new Decimal("5") } });

    const result = await deliverPaidBybitOrder(prisma, { orderId: laterOrder.id, bybitTxId, amount: new Decimal("5") });

    expect(result.status).toBe("already_processed");
    expect((await prisma.order.findUnique({ where: { id: laterOrder.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    const ledgerRow = await prisma.processedBybitTx.findUnique({ where: { bybitTxId } });
    expect(ledgerRow?.outcome).toBe("unmatched");
    expect(ledgerRow?.orderId).toBeNull();
  });

  // H-3-shaped (mirrors tokopay.test.ts's "a claim whose delivery failed is
  // retryable"): wipe stock so approveOrder's out-of-stock guard throws
  // INSIDE the delivery $transaction, rolling it back and tagging the ledger
  // row delivery_failed instead of leaving the payment stuck as unclaimable.
  it("a bybitTxId whose delivery failed is retryable — a later call with the same id succeeds instead of already_processed", async () => {
    const order = await makePendingBybitOrder();
    const bybitTxId = "tx-delivery-failed-retry-1";

    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: StockStatus.DEAD } });

    await expect(
      deliverPaidBybitOrder(prisma, { orderId: order.id, bybitTxId, amount: order.totalAmount }),
    ).rejects.toThrow();

    const failedLedger = await prisma.processedBybitTx.findUnique({ where: { bybitTxId } });
    expect(failedLedger?.outcome).toBe("delivery_failed");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);

    await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials: "retry-cred-bybit-1@example.com:pwd", status: StockStatus.AVAILABLE },
    });

    const retry = await deliverPaidBybitOrder(prisma, { orderId: order.id, bybitTxId, amount: order.totalAmount });
    expect(retry.status).toBe("delivered");
    if (retry.status !== "delivered") throw new Error("expected delivered");
    expect(retry.order.status).toBe(OrderStatus.DELIVERED);

    const ledgerRow = await prisma.processedBybitTx.findUnique({ where: { bybitTxId } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order.id);

    const rows = await prisma.processedBybitTx.findMany({ where: { bybitTxId } });
    expect(rows.length).toBe(1);
  });

  it("a bybitTxId already delivered (matched) is never re-claimed", async () => {
    await bulkAddStock(
      prisma,
      sample.product.id,
      Array.from({ length: 5 }, (_, i) => `bybit-terminal-matched-${i}@example.com:pwd`),
    );

    const matchedOrder = await makePendingBybitOrder();
    const matchedTxId = "tx-terminal-matched-1";
    const delivered = await deliverPaidBybitOrder(prisma, {
      orderId: matchedOrder.id,
      bybitTxId: matchedTxId,
      amount: matchedOrder.totalAmount,
    });
    expect(delivered.status).toBe("delivered");

    const otherOrder = await makePendingBybitOrder();
    const reclaimAttempt = await deliverPaidBybitOrder(prisma, {
      orderId: otherOrder.id,
      bybitTxId: matchedTxId,
      amount: otherOrder.totalAmount,
    });
    expect(reclaimAttempt.status).toBe("already_processed");

    const ledger = await prisma.processedBybitTx.findUnique({ where: { bybitTxId: matchedTxId } });
    expect(ledger?.outcome).toBe("matched");
    expect(ledger?.orderId).toBe(matchedOrder.id);
    expect((await prisma.order.findUnique({ where: { id: otherOrder.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it("an underpaid bybitTxId is never re-claimed", async () => {
    const order = await makePendingBybitOrder();
    const underTxId = "tx-terminal-underpaid-1";
    const shortAmount = new Decimal(order.totalAmount).minus("5");

    const flagged = await markUnderpaidBybit(prisma, { orderId: order.id, bybitTxId: underTxId, amount: shortAmount });
    expect(flagged).toBe(true);
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.UNDERPAID);

    const otherOrder = await makePendingBybitOrder();
    const reclaimAttempt = await deliverPaidBybitOrder(prisma, {
      orderId: otherOrder.id,
      bybitTxId: underTxId,
      amount: otherOrder.totalAmount,
    });
    expect(reclaimAttempt.status).toBe("already_processed");

    const ledger = await prisma.processedBybitTx.findUnique({ where: { bybitTxId: underTxId } });
    expect(ledger?.outcome).toBe("underpaid");
    expect((await prisma.order.findUnique({ where: { id: otherOrder.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  // underpaid_flag_failed only happens if markUnderpaidBybit's own order
  // update transaction throws — not practically forceable from the outside
  // without stubbing Prisma internals, so it's seeded directly (same
  // technique as binance_internal.test.ts's directly-seeded "stale" case).
  it("a directly-seeded underpaid_flag_failed row is never re-claimed", async () => {
    const seedOrder = await makePendingBybitOrder();
    const txId = "tx-terminal-underpaid-flag-failed-1";
    await prisma.processedBybitTx.create({
      data: { bybitTxId: txId, orderId: seedOrder.id, amount: new Decimal("5"), outcome: "underpaid_flag_failed" },
    });

    const otherOrder = await makePendingBybitOrder();
    const result = await deliverPaidBybitOrder(prisma, { orderId: otherOrder.id, bybitTxId: txId, amount: otherOrder.totalAmount });

    expect(result.status).toBe("already_processed");
    const ledgerAfter = await prisma.processedBybitTx.findUnique({ where: { bybitTxId: txId } });
    expect(ledgerAfter?.outcome).toBe("underpaid_flag_failed");
    expect((await prisma.order.findUnique({ where: { id: otherOrder.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  // Adapted from "a re-claimed bybitTxId whose order turns out stale is
  // reverted to its prior outcome, not stranded as matched" (seeded from
  // "unmatched"): that scenario can no longer happen on this rail —
  // "unmatched" is terminal again (see the money-loss fix note above), so a
  // reclaim attempt against it now short-circuits to already_processed
  // before ever touching the order. The revert-on-stale logic itself is
  // still real and still needed for "delivery_failed", the one outcome that
  // remains reclaimable here — this test now seeds from that instead. A
  // stale reclaim is even more dangerous on this rail than on Binance: there
  // is no manualMatchTx/dismissUnmatchedTx equivalent for Bybit at all, so an
  // unreverted stale reclaim would strand the row with no recovery path,
  // automatic or manual.
  it("a re-claimed bybitTxId whose order turns out stale is reverted to delivery_failed, not stranded as matched", async () => {
    const originalOrder = await makePendingBybitOrder();
    // Created BEFORE stock is wiped below — createOrderDirect requires
    // available stock at creation time even though this order's own status
    // check (not stock) is what the test cares about.
    const staleOrder = await makePendingBybitOrder();
    const bybitTxId = "tx-delivery-failed-then-stale-1";

    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: StockStatus.DEAD } });
    await expect(
      deliverPaidBybitOrder(prisma, { orderId: originalOrder.id, bybitTxId, amount: originalOrder.totalAmount }),
    ).rejects.toThrow();
    const failedLedger = await prisma.processedBybitTx.findUnique({ where: { bybitTxId } });
    expect(failedLedger?.outcome).toBe("delivery_failed");
    expect(failedLedger?.orderId).toBe(originalOrder.id);

    // A later poller cycle re-claims the SAME tx id against a DIFFERENT
    // order that has since left PENDING_PAYMENT (e.g. cancelled).
    await prisma.order.update({ where: { id: staleOrder.id }, data: { status: OrderStatus.CANCELLED } });

    const result = await deliverPaidBybitOrder(prisma, { orderId: staleOrder.id, bybitTxId, amount: staleOrder.totalAmount });
    expect(result.status).toBe("stale");

    const ledgerAfter = await prisma.processedBybitTx.findUnique({ where: { bybitTxId } });
    expect(ledgerAfter?.outcome).toBe("delivery_failed");
    expect(ledgerAfter?.orderId).toBe(originalOrder.id);

    // Still re-claimable — a later, legitimate poller pass can still deliver
    // it (delivery_failed has no manual-match tool; recovery is automatic).
    await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials: "retry-cred-bybit-2@example.com:pwd", status: StockStatus.AVAILABLE },
    });
    const recoveryOrder = await makePendingBybitOrder();
    const recovered = await deliverPaidBybitOrder(prisma, {
      orderId: recoveryOrder.id,
      bybitTxId,
      amount: recoveryOrder.totalAmount,
    });
    expect(recovered.status).toBe("delivered");
  });
});

describe("deliverPaidBybitOrder — WALLET_TOPUP routing", () => {
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

  async function makeReferredUser() {
    const referrer = await upsertUser(prisma, { telegramId: 9401, username: "topup-referrer-by", fullName: "Referrer" });
    const referee = await upsertUser(prisma, {
      telegramId: 9402,
      username: "topup-referee-by",
      fullName: "Referee",
      referredByCode: referrer.referralCode,
    });
    return { referrer, referee };
  }

  async function makePendingTopupOrder(userId: number, amount: string = "10") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId, amount, currency: "USDT", method: PaymentMethod.BYBIT, rate: "16000" }),
    );
  }

  it("a WALLET_TOPUP order routes to settleWalletTopup: wallet credited, no stock/referral side effects", async () => {
    const { referee } = await makeReferredUser();
    const order = await makePendingTopupOrder(referee.id, "10");
    expect(order.kind).toBe(OrderKind.WALLET_TOPUP);

    const result = await deliverPaidBybitOrder(prisma, {
      orderId: order.id,
      bybitTxId: "tx-topup-1",
      amount: order.totalAmount,
    });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.credentials).toEqual([]);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: referee.id } });
    expect(new Decimal(user.walletBalanceUsdt).equals(order.totalAmount)).toBe(true);

    const stock = await prisma.stockItem.findMany({ where: { productId: sample.product.id } });
    expect(stock.every((s) => s.status === StockStatus.AVAILABLE)).toBe(true);
    const referral = await prisma.referral.findUnique({ where: { refereeId: referee.id } });
    expect(referral).toBeNull();
  });

  // F8 Part A: money that arrives after the payment window closed.
  it("a top-up auto-cancelled at window close is still credited when the deposit lands late", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");
    await prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await prisma.$transaction((tx) => cancelOrder(tx, order.id, "expired"));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CANCELLED);

    const result = await deliverPaidBybitOrder(prisma, {
      orderId: order.id,
      bybitTxId: "tx-topup-late-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalanceUsdt).equals(order.totalAmount)).toBe(true);
  });

  it("a CANCELLED PRODUCT order paid late is still stale — the top-up relaxation does not leak", async () => {
    const productOrder = (await createOrderDirect(prisma, {
      user: sample.user,
      productId: sample.product.id,
      quantity: 1,
    }))!;
    await prisma.$transaction((tx) => cancelOrder(tx, productOrder.id, "expired"));

    const result = await deliverPaidBybitOrder(prisma, {
      orderId: productOrder.id,
      bybitTxId: "tx-product-late-1",
      amount: productOrder.totalAmount,
    });
    expect(result.status).toBe("stale");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: productOrder.id } })).status).toBe(OrderStatus.CANCELLED);
  });

  it("a duplicate gateway tx id does not double-credit the wallet", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");

    const first = await deliverPaidBybitOrder(prisma, { orderId: order.id, bybitTxId: "tx-topup-dup-1", amount: order.totalAmount });
    expect(first.status).toBe("delivered");

    const second = await deliverPaidBybitOrder(prisma, { orderId: order.id, bybitTxId: "tx-topup-dup-1", amount: order.totalAmount });
    expect(second.status).toBe("already_processed");

    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "wallet_topup" } });
    expect(rows).toHaveLength(1);
  });

  // Anti-double-notify guarantee (Task 7): Bybit is a POLLER-ONLY rail —
  // deliverPaidBybitOrder only ever runs inside the bot process's own Bybit
  // deposit poller, never a web request — so the buyer is DM'd directly by
  // that poller's onDelivered handler instead. Settlement here must NOT also
  // enqueue WALLET_TOPUP_CREDITED_DM to the outbox, or the buyer would be
  // notified twice.
  it("does NOT enqueue a WALLET_TOPUP_CREDITED_DM outbox row — the bot DMs the buyer directly for this poller-only rail", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");

    const result = await deliverPaidBybitOrder(prisma, { orderId: order.id, bybitTxId: "tx-topup-nodm-1", amount: order.totalAmount });
    expect(result.status).toBe("delivered");

    const rows2 = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(rows2).toHaveLength(0);
  });
});

// Task 17: this rail's delivery transaction previously opened with no options
// object at all, so it ran on Prisma's 5-second default while the other five
// gateway crud files (tokopay.ts, paydisini.ts, nowpayments.ts,
// binance_internal.ts, and this rail's sibling bybit_bsc_deposit.ts) all pass
// { timeout: 15000 }. On a single-writer SQLite database shared by three
// processes, 5 seconds is tight under contention for a transaction doing real
// work (status transition, stock allocation, outbox enqueue) on a path that
// has already claimed the buyer's payment. Reproducing a real 5-second
// timeout would be slow/flaky, so this spies on prisma.$transaction and
// asserts its options argument instead — the honest pin for a Prisma option,
// not the timeout behavior itself.
describe("deliverPaidBybitOrder — delivery transaction timeout", () => {
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

  async function makePendingBybitOrder() {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT } });
    return order;
  }

  it("opens the delivery $transaction with the same 15s timeout as the other five gateway rails", async () => {
    const order = await makePendingBybitOrder();
    const spy = vi.spyOn(prisma, "$transaction");

    const result = await deliverPaidBybitOrder(prisma, {
      orderId: order.id,
      bybitTxId: "tx-timeout-1",
      amount: order.totalAmount,
    });

    expect(result.status).toBe("delivered");
    // deliverPaidBybitOrder calls db.$transaction exactly once (the delivery
    // transaction) — asserting there's exactly one call, then checking its
    // options, is what guarantees this pins the delivery transaction and not
    // some other $transaction call in the same code path.
    expect(spy.mock.calls).toHaveLength(1);
    expect(spy.mock.calls[0]?.[1]).toEqual({ timeout: 15000 });
  });
});
