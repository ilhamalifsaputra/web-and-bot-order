import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@app/core/config", () => ({
  config: {
    LOG_LEVEL: "info",
    BYBIT_DEPOSIT_ADDRESS: "env-deposit-address",
    BYBIT_DEPOSIT_CHAIN: "BSC",
    BYBIT_API_KEY: "env-api-key",
    BYBIT_API_SECRET: "env-api-secret",
    BYBIT_API_BASE: "https://api.bybit.com",
    BYBIT_BSC_PAYMENT_WINDOW_MINUTES: 15,
    BSCSCAN_API_BASE: "https://api.bscscan.com/api",
    BSCSCAN_API_KEY: "env-bscscan-key",
    BYBIT_BSC_REQUIRED_CONFIRMATIONS: 15,
    // Needed by createOrderDirect (packages/db/src/crud/orders.ts), exercised
    // below by the deliverPaidBybitBscOrder DB-integration describe block —
    // this file's config mock otherwise only covers
    // resolveBybitBscConfig/poll-health, which don't touch these. Defaults
    // match packages/core/src/config.ts.
    PAYMENT_WINDOW_MINUTES: 30,
    USE_UNIQUE_CENTS: true,
    ADMIN_IDS: [] as number[],
    DEFAULT_LANGUAGE: "en",
  },
}));

import {
  resolveBybitBscConfig,
  resolveBybitBscTrackerConfig,
  getBybitBscPollHealth,
  recordBybitBscPollHealth,
  deliverPaidBybitBscOrder,
  markUnderpaidBybitBsc,
  recordUnmatchedBybitBscTx,
} from "./bybit_bsc_deposit";
import { createOrderDirect } from "./orders";
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
 * needed by recordBybitBscPollHealth (writes) + getBybitBscPollHealth (reads). */
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
  bybit_bsc_deposit_address: "db-deposit-address",
  bybit_api_key: "db-api-key",
  bybit_api_secret: "db-api-secret",
};

describe("resolveBybitBscConfig — enabled flag matrix", () => {
  it("enabled when creds present and flag is unset (default ON)", async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS }));
    expect(cfg.enabled).toBe(true);
  });

  it('enabled when creds present and flag is "true"', async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_enabled: "true" }));
    expect(cfg.enabled).toBe(true);
  });

  it('disabled when flag is "false" even with creds present', async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_enabled: "false" }));
    expect(cfg.enabled).toBe(false);
  });

  it('disabled when flag is "FALSE " (trimmed + case-insensitive)', async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_enabled: "FALSE " }));
    expect(cfg.enabled).toBe(false);
  });

  it('enabled when flag is blank (empty string is still default ON)', async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_enabled: "" }));
    expect(cfg.enabled).toBe(true);
  });

  it('disabled when creds missing (env fallback also empty) regardless of flag "true"', async () => {
    vi.doMock("@app/core/config", () => ({
      config: {
        LOG_LEVEL: "info",
        BYBIT_DEPOSIT_ADDRESS: undefined,
        BYBIT_DEPOSIT_CHAIN: "BSC",
        BYBIT_API_KEY: undefined,
        BYBIT_API_SECRET: undefined,
        BYBIT_API_BASE: "https://api.bybit.com",
        BYBIT_BSC_PAYMENT_WINDOW_MINUTES: 15,
      },
    }));
    vi.resetModules();
    const { resolveBybitBscConfig: resolveNoCreds } = await import("./bybit_bsc_deposit");
    const cfg = await resolveNoCreds(stubDb({ bybit_bsc_enabled: "true" }));
    expect(cfg.depositAddress).toBe("");
    expect(cfg.enabled).toBe(false);
  });
});

describe("resolveBybitBscConfig — minAmount", () => {
  it("defaults to null when unset", async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS }));
    expect(cfg.minAmount).toBeNull();
  });

  it("parses a configured positive value", async () => {
    const cfg = await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_min_amount: "12.5" }));
    expect(cfg.minAmount?.toString()).toBe("12.5");
  });

  it("treats a non-numeric or non-positive value as null (never throws)", async () => {
    expect((await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_min_amount: "not-a-number" }))).minAmount).toBeNull();
    expect((await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_min_amount: "0" }))).minAmount).toBeNull();
    expect((await resolveBybitBscConfig(stubDb({ ...CREDS, bybit_bsc_min_amount: "-5" }))).minAmount).toBeNull();
  });
});

describe("resolveBybitBscTrackerConfig", () => {
  it("falls back to the env BscScan key and the default required-confirmations when no Setting is configured", async () => {
    const cfg = await resolveBybitBscTrackerConfig(stubDb({}));
    expect(cfg.apiKey).toBe("env-bscscan-key");
    expect(cfg.requiredConfirmations).toBe(15);
    expect(cfg.apiBase).toBe("https://api.bscscan.com/api");
  });

  it("Setting wins over the env fallback for both the key and the confirmation count", async () => {
    const cfg = await resolveBybitBscTrackerConfig(
      stubDb({ bscscan_api_key: "db-bscscan-key", bybit_bsc_required_confirmations: "20" }),
    );
    expect(cfg.apiKey).toBe("db-bscscan-key");
    expect(cfg.requiredConfirmations).toBe(20);
  });

  it("treats a non-numeric or non-positive required-confirmations Setting as the env/default instead of throwing", async () => {
    expect((await resolveBybitBscTrackerConfig(stubDb({ bybit_bsc_required_confirmations: "not-a-number" }))).requiredConfirmations).toBe(15);
    expect((await resolveBybitBscTrackerConfig(stubDb({ bybit_bsc_required_confirmations: "0" }))).requiredConfirmations).toBe(15);
    expect((await resolveBybitBscTrackerConfig(stubDb({ bybit_bsc_required_confirmations: "-3" }))).requiredConfirmations).toBe(15);
  });
});

describe("Bybit BSC poll health — rate-limit tracking fields", () => {
  it("getBybitBscPollHealth on a never-run poller is all-null", async () => {
    const health = await getBybitBscPollHealth(mutableStubDb());
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
    await recordBybitBscPollHealth(db, { lastTxCount: 3, backoffUntil: null, success: true });
    const health = await getBybitBscPollHealth(db);
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
    await recordBybitBscPollHealth(db, {
      lastTxCount: 0,
      backoffUntil: until,
      consecutiveRateLimitHits: 2,
      rateLimited: true,
      success: false,
      error: "Bybit rate limited (HTTP 429)",
    });
    const health = await getBybitBscPollHealth(db);
    expect(health.consecutiveRateLimitHits).toBe(2);
    expect(health.backoffUntil).toBe(new Date(until).toISOString());
    expect(health.lastRateLimitAt).not.toBeNull();
  });
});

describe("Bybit BSC poll health — non-rate-limit failure streak", () => {
  it("increments consecutiveFailures and records lastError on a network/HTTP failure", async () => {
    const db = mutableStubDb();
    await recordBybitBscPollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    const health = await getBybitBscPollHealth(db);
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBe("fetch failed: Connect Timeout Error");
    expect(health.lastSuccessAt).toBeNull(); // never succeeded yet
  });

  it("resets consecutiveFailures to 0 on the next success, but keeps lastError sticky", async () => {
    const db = mutableStubDb();
    await recordBybitBscPollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    await recordBybitBscPollHealth(db, { lastTxCount: 1, success: true });
    const health = await getBybitBscPollHealth(db);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastError).toBe("fetch failed: Connect Timeout Error"); // sticky for diagnostics
    expect(health.lastSuccessAt).toBe(health.lastRun);
  });
});

// ===========================================================================
// deliverPaidBybitBscOrder — "processing" branch (M-35, backend audit
// 2026-07-31). The idempotency/delivered/already_processed/stale/tracking
// branches are covered extensively in
// apps/order-bot/test/bybit-bsc-deposit.test.ts (Task 24, M-14); this file
// only had resolveBybitBscConfig/poll-health coverage, and nowhere exercised
// the "processing" branch a manual-delivery SKU takes. Like bybit_deposit.ts,
// deliverPaidBybitBscOrder has no overpaid-ledger/DM logic at all — so this
// only pins the processing-branch shape shared with every gateway via
// settlePaidOrder, not an overpaid interaction that doesn't exist here.
describe("deliverPaidBybitBscOrder — processing branch (manual SKU)", () => {
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

  /** Create a PENDING_PAYMENT order stamped as a Bybit BSC deposit payment. */
  async function makePendingBybitBscOrderFor(productId: number) {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId, quantity: 1 }))!;
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT_BSC } });
    return order;
  }

  it("processing (manual SKU): kind stays processing, no stock is touched, and settlePaidOrder's own buyer DM still fires", async () => {
    const manualDenom = await makeManualDenom();
    const order = await makePendingBybitBscOrderFor(manualDenom.id);
    const txId = "0x" + "9".repeat(64);

    const result = await deliverPaidBybitBscOrder(prisma, {
      orderId: order.id,
      bybitTxId: txId,
      amount: order.totalAmount,
    });

    expect(result.status).toBe("processing");
    if (result.status !== "processing") throw new Error("expected processing");
    expect(result.order.status).toBe(OrderStatus.PROCESSING);

    // Manual SKUs never reserve stock.
    const stockCount = await prisma.stockItem.count({ where: { productId: manualDenom.id } });
    expect(stockCount).toBe(0);

    // Ledger claimed as matched (not overpaid — bybit_bsc_deposit.ts has no
    // overpaid handling at all, unlike nowpayments/paydisini/binance_internal).
    const ledgerRow = await prisma.processedBybitTx.findUnique({ where: { bybitTxId: txId } });
    expect(ledgerRow?.outcome).toBe("matched");

    const processingDm = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_PROCESSING_DM },
    });
    expect(processingDm).not.toBeNull();
  });
});

// Task 16: mirrors Task 15's re-claim widening (binance_internal.ts,
// tokopay.ts, paydisini.ts, nowpayments.ts) onto this rail — the one
// deliverPaid*Order with NO re-claim at all before Task 16 touched it (a
// unique violation returned already_processed unconditionally). An
// `unmatched` or `delivery_failed` ledger row never delivered anything, so
// the SAME bybitTxId must stay re-claimable by a later poller pass, or the
// buyer's payment is stuck forever behind the bybit_tx_id UNIQUE gate.
//
// Bybit BSC matches an on-chain deposit against ANY pending order by amount
// (same shape as Binance Internal, unlike the 1:1 QRIS trxId), so a re-claim
// can turn out stale — the fix must revert the ledger row to its prior
// outcome instead of stranding it as an unreachable "matched".
//
// Bybit's ledger IS visible to admins — reports.ts's listCombinedLedger puts
// both rails' rows in the Payments page table, and manualMatchQueueCounts
// counts their "unmatched"/"delivery_failed" rows into the dashboard cards.
// What Bybit lacks is the ACTION side: no manualMatchTx/dismissUnmatchedTx
// equivalent. So an unreverted stale reclaim does two things, not one: it
// leaves the row unreachable by the poller (as on Binance), AND — because
// those queue counts filter on exactly those two outcomes — it silently
// decrements the ops dashboard's open-problem count and drops out of the
// ledger's outcome filter. The row stops looking like a problem at the same
// moment it becomes unrecoverable.
//
// This rail has no "overpaid" outcome (unlike Binance/TokoPay/PayDisini/
// NOWPayments — see the module doc-comment), so its full outcome set is:
// matched, delivery_failed, underpaid, underpaid_flag_failed, unmatched.
// Terminal (never re-claimable): matched, underpaid, underpaid_flag_failed.
describe("deliverPaidBybitBscOrder — re-claiming a bybitTxId across non-delivering outcomes", () => {
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

  async function makePendingBybitBscOrder() {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT_BSC } });
    return order;
  }

  it("a bybitTxId first recorded as unmatched can still be delivered by a later poller pass", async () => {
    const order = await makePendingBybitBscOrder();
    const bybitTxId = "0x-unmatched-reclaim-1";

    const recorded = await recordUnmatchedBybitBscTx(prisma, { bybitTxId, amount: new Decimal("5") });
    expect(recorded).toBe(true);
    const unmatchedRow = await prisma.processedBybitTx.findUnique({ where: { bybitTxId } });
    expect(unmatchedRow?.outcome).toBe("unmatched");

    const result = await deliverPaidBybitBscOrder(prisma, { orderId: order.id, bybitTxId, amount: order.totalAmount });
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    const ledgerRow = await prisma.processedBybitTx.findUnique({ where: { bybitTxId } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order.id);

    const rows = await prisma.processedBybitTx.findMany({ where: { bybitTxId } });
    expect(rows.length).toBe(1);
  });

  // Wipe stock so approveOrder's out-of-stock guard throws INSIDE the
  // delivery $transaction, rolling it back and tagging the ledger row
  // delivery_failed. Unlike bybit_deposit.ts (Internal Transfer) — and
  // tokopay/paydisini/nowpayments — this rail's catch handler ALSO moves the
  // order itself to FAILED (see deliverPaidBybitBscOrder's catch block,
  // tryTransitionOrderStatus + enqueueOrderPipelineFailed), so a retry
  // against the SAME order correctly comes back "stale" (FAILED is not in
  // PRE_DELIVERY_STATUSES) rather than re-delivering it. The re-claim exists
  // for the ledger row itself — the on-chain deposit — which a later poller
  // cycle can still match to a DIFFERENT pending order by amount.
  it("a bybitTxId whose delivery failed can still be delivered by a later poller pass against a fresh pending order", async () => {
    const order = await makePendingBybitBscOrder();
    const bybitTxId = "0x-delivery-failed-retry-1";

    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: StockStatus.DEAD } });

    await expect(
      deliverPaidBybitBscOrder(prisma, { orderId: order.id, bybitTxId, amount: order.totalAmount }),
    ).rejects.toThrow();

    const failedLedger = await prisma.processedBybitTx.findUnique({ where: { bybitTxId } });
    expect(failedLedger?.outcome).toBe("delivery_failed");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.FAILED);

    await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials: "retry-cred-bybit-bsc-1@example.com:pwd", status: StockStatus.AVAILABLE },
    });

    const recoveryOrder = await makePendingBybitBscOrder();
    const retry = await deliverPaidBybitBscOrder(prisma, {
      orderId: recoveryOrder.id,
      bybitTxId,
      amount: recoveryOrder.totalAmount,
    });
    expect(retry.status).toBe("delivered");
    if (retry.status !== "delivered") throw new Error("expected delivered");
    expect(retry.order.status).toBe(OrderStatus.DELIVERED);

    const ledgerRow = await prisma.processedBybitTx.findUnique({ where: { bybitTxId } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(recoveryOrder.id);

    const rows = await prisma.processedBybitTx.findMany({ where: { bybitTxId } });
    expect(rows.length).toBe(1);
  });

  it("a bybitTxId already delivered (matched) is never re-claimed", async () => {
    await bulkAddStock(
      prisma,
      sample.product.id,
      Array.from({ length: 5 }, (_, i) => `bybit-bsc-terminal-matched-${i}@example.com:pwd`),
    );

    const matchedOrder = await makePendingBybitBscOrder();
    const matchedTxId = "0x-terminal-matched-1";
    const delivered = await deliverPaidBybitBscOrder(prisma, {
      orderId: matchedOrder.id,
      bybitTxId: matchedTxId,
      amount: matchedOrder.totalAmount,
    });
    expect(delivered.status).toBe("delivered");

    const otherOrder = await makePendingBybitBscOrder();
    const reclaimAttempt = await deliverPaidBybitBscOrder(prisma, {
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
    const order = await makePendingBybitBscOrder();
    const underTxId = "0x-terminal-underpaid-1";
    const shortAmount = new Decimal(order.totalAmount).minus("5");

    const flagged = await markUnderpaidBybitBsc(prisma, { orderId: order.id, bybitTxId: underTxId, amount: shortAmount });
    expect(flagged).toBe(true);
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.UNDERPAID);

    const otherOrder = await makePendingBybitBscOrder();
    const reclaimAttempt = await deliverPaidBybitBscOrder(prisma, {
      orderId: otherOrder.id,
      bybitTxId: underTxId,
      amount: otherOrder.totalAmount,
    });
    expect(reclaimAttempt.status).toBe("already_processed");

    const ledger = await prisma.processedBybitTx.findUnique({ where: { bybitTxId: underTxId } });
    expect(ledger?.outcome).toBe("underpaid");
    expect((await prisma.order.findUnique({ where: { id: otherOrder.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  // underpaid_flag_failed only happens if markUnderpaidBybitBsc's own order
  // update transaction throws — not practically forceable from the outside
  // without stubbing Prisma internals, so it's seeded directly (same
  // technique as binance_internal.test.ts's directly-seeded "stale" case).
  it("a directly-seeded underpaid_flag_failed row is never re-claimed", async () => {
    const seedOrder = await makePendingBybitBscOrder();
    const txId = "0x-terminal-underpaid-flag-failed-1";
    await prisma.processedBybitTx.create({
      data: { bybitTxId: txId, orderId: seedOrder.id, amount: new Decimal("5"), outcome: "underpaid_flag_failed" },
    });

    const otherOrder = await makePendingBybitBscOrder();
    const result = await deliverPaidBybitBscOrder(prisma, { orderId: otherOrder.id, bybitTxId: txId, amount: otherOrder.totalAmount });

    expect(result.status).toBe("already_processed");
    const ledgerAfter = await prisma.processedBybitTx.findUnique({ where: { bybitTxId: txId } });
    expect(ledgerAfter?.outcome).toBe("underpaid_flag_failed");
    expect((await prisma.order.findUnique({ where: { id: otherOrder.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  // Bybit BSC matches by amount against ANY pending order — a re-claim can
  // therefore land on the WRONG order, one that turns out to no longer be a
  // PRE_DELIVERY_STATUSES member (e.g. cancelled). Without a revert, the row
  // would be stranded "matched" against an order that received nothing,
  // forever excluded from NON_DELIVERING_OUTCOMES and with no manual-match
  // tool to fall back on either — a true dead end for the buyer's money. The
  // fix must restore the exact prior outcome/orderId/amount instead.
  it("a re-claimed bybitTxId whose order turns out stale is reverted to its prior outcome, not stranded as matched", async () => {
    const bybitTxId = "0x-unmatched-then-stale-1";
    const recorded = await recordUnmatchedBybitBscTx(prisma, { bybitTxId, amount: new Decimal("5") });
    expect(recorded).toBe(true);

    const staleOrder = await makePendingBybitBscOrder();
    await prisma.order.update({ where: { id: staleOrder.id }, data: { status: OrderStatus.CANCELLED } });

    const result = await deliverPaidBybitBscOrder(prisma, { orderId: staleOrder.id, bybitTxId, amount: staleOrder.totalAmount });
    expect(result.status).toBe("stale");

    const ledgerAfter = await prisma.processedBybitTx.findUnique({ where: { bybitTxId } });
    expect(ledgerAfter?.outcome).toBe("unmatched");
    expect(ledgerAfter?.orderId).toBeNull();

    // Still re-claimable — a later, legitimate poller pass can still deliver it.
    const recoveryOrder = await makePendingBybitBscOrder();
    const recovered = await deliverPaidBybitBscOrder(prisma, {
      orderId: recoveryOrder.id,
      bybitTxId,
      amount: recoveryOrder.totalAmount,
    });
    expect(recovered.status).toBe("delivered");
  });
});

describe("deliverPaidBybitBscOrder — WALLET_TOPUP routing", () => {
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
    const referrer = await upsertUser(prisma, { telegramId: 9501, username: "topup-referrer-bb", fullName: "Referrer" });
    const referee = await upsertUser(prisma, {
      telegramId: 9502,
      username: "topup-referee-bb",
      fullName: "Referee",
      referredByCode: referrer.referralCode,
    });
    return { referrer, referee };
  }

  async function makePendingTopupOrder(userId: number, amount: string = "10") {
    return prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId, amount, currency: "USDT", method: PaymentMethod.BYBIT_BSC, rate: "16000" }),
    );
  }

  it("a WALLET_TOPUP order routes to settleWalletTopup: wallet credited, no stock/referral side effects", async () => {
    const { referee } = await makeReferredUser();
    const order = await makePendingTopupOrder(referee.id, "10");
    expect(order.kind).toBe(OrderKind.WALLET_TOPUP);
    const txId = "0x" + "1".repeat(64);

    const result = await deliverPaidBybitBscOrder(prisma, {
      orderId: order.id,
      bybitTxId: txId,
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

  it("a duplicate gateway tx id does not double-credit the wallet", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");
    const txId = "0x" + "2".repeat(64);

    const first = await deliverPaidBybitBscOrder(prisma, { orderId: order.id, bybitTxId: txId, amount: order.totalAmount });
    expect(first.status).toBe("delivered");

    const second = await deliverPaidBybitBscOrder(prisma, { orderId: order.id, bybitTxId: txId, amount: order.totalAmount });
    expect(second.status).toBe("already_processed");

    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "wallet_topup" } });
    expect(rows).toHaveLength(1);
  });

  // Regression: unlike the other 5 gateways, an on-chain Bybit BSC deposit
  // legitimately passes through PAYMENT_DETECTED/CONFIRMING/CONFIRMED (the
  // confirmation tracker, kind-agnostic) BEFORE Bybit reports status 3
  // ("Success") and this function is called — so by delivery time,
  // order.status is very often NOT PENDING_PAYMENT anymore. Pin that this
  // still credits the wallet (not a silent no-op) even when the order has
  // already progressed to CONFIRMED before this call.
  it("still credits the wallet when the order already progressed to CONFIRMED before delivery", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED } });
    const txId = "0x" + "3".repeat(64);

    const result = await deliverPaidBybitBscOrder(prisma, { orderId: order.id, bybitTxId: txId, amount: order.totalAmount });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalanceUsdt).equals(order.totalAmount)).toBe(true);

    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "wallet_topup" } });
    expect(rows).toHaveLength(1);
  });

  // Anti-double-notify guarantee (Task 7): Bybit BSC is a POLLER-ONLY rail —
  // deliverPaidBybitBscOrder only ever runs inside the bot process's own
  // Bybit BSC deposit poller, never a web request — so the buyer is DM'd
  // directly by that poller's onDelivered handler instead. Settlement here
  // must NOT also enqueue WALLET_TOPUP_CREDITED_DM to the outbox, or the
  // buyer would be notified twice.
  it("does NOT enqueue a WALLET_TOPUP_CREDITED_DM outbox row — the bot DMs the buyer directly for this poller-only rail", async () => {
    const order = await makePendingTopupOrder(sample.user.id, "10");
    const txId = "0x" + "4".repeat(64);

    const result = await deliverPaidBybitBscOrder(prisma, { orderId: order.id, bybitTxId: txId, amount: order.totalAmount });
    expect(result.status).toBe("delivered");

    const dmRows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(dmRows).toHaveLength(0);
  });
});

// Task 17: this rail's delivery transaction previously opened with no options
// object at all, so it ran on Prisma's 5-second default while the other five
// gateway crud files (tokopay.ts, paydisini.ts, nowpayments.ts,
// binance_internal.ts, and this rail's sibling bybit_deposit.ts) all pass
// { timeout: 15000 }. On a single-writer SQLite database shared by three
// processes, 5 seconds is tight under contention for a transaction doing real
// work (status transition, stock allocation, outbox enqueue) on a path that
// has already claimed the buyer's payment. Reproducing a real 5-second
// timeout would be slow/flaky, so this spies on prisma.$transaction and
// asserts its options argument instead — the honest pin for a Prisma option,
// not the timeout behavior itself.
describe("deliverPaidBybitBscOrder — delivery transaction timeout", () => {
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

  async function makePendingBybitBscOrder() {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT_BSC } });
    return order;
  }

  it("opens the delivery $transaction with the same 15s timeout as the other five gateway rails", async () => {
    const order = await makePendingBybitBscOrder();
    const txId = "0x" + "9".repeat(64);
    const spy = vi.spyOn(prisma, "$transaction");

    const result = await deliverPaidBybitBscOrder(prisma, {
      orderId: order.id,
      bybitTxId: txId,
      amount: order.totalAmount,
    });

    expect(result.status).toBe("delivered");
    // deliverPaidBybitBscOrder calls db.$transaction exactly once (the
    // delivery transaction) — asserting there's exactly one call, then
    // checking its options, is what guarantees this pins the delivery
    // transaction and not some other $transaction call in the same code path.
    expect(spy.mock.calls).toHaveLength(1);
    expect(spy.mock.calls[0]?.[1]).toEqual({ timeout: 15000 });
  });
});
